// Server only: the decision model (DM) client. A DM answers typed questions with
// probabilities instead of free text, so it can choose category and priority, not write a summary.
// Plain fetch on purpose: the OpenAI SDK does not support decision endpoints.
import { z } from "zod";
import { logCall, type LogContext } from "./callLog";
import { DM, LLM_MAX_RETRIES, LLM_TIMEOUT_MS } from "./config";
import { DmNotConfiguredError, DmRequestError, LlmInvalidOutputError, toApiError } from "./errors";
import { estimateDmCost } from "./pricing";
import { CATEGORY_CRITERIA, DM_INSTRUCTIONS, PRIORITY_CRITERIA, PROMPT_VERSIONS } from "./prompt";
import {
  Category,
  formatIssues,
  Priority,
  ticketText,
  type Confidence,
  type DmUsage,
} from "./schemas";

export type DmDecision = {
  category: Category;
  priority: Priority;
  confidence: Confidence;
  usage: DmUsage | null;
  model: string;
};

// The DM's answer is validated like the LLM's: the state is untrusted, so the output is too.
const answer = <T extends z.ZodType<string>>(choice: T) =>
  z.object({
    choice,
    probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
    confidence: z.number().min(0).max(1).optional(),
  });

const DmResponse = z.object({
  category: answer(Category),
  priority: answer(Priority),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }).partial().optional(),
});

// Providers disagree on the shape: the course slides put answers at the top level,
// System One (LLM Gateway, OpenRouter) nests them in "answers", and /v1/decisions returns
// "answers" as an array of { name, ... }. Normalize all three to { category, priority, usage }.
function normalize(json: unknown): unknown {
  if (typeof json !== "object" || json === null || !("answers" in json)) return json;
  const { answers, ...rest } = json as { answers: unknown };
  if (Array.isArray(answers)) {
    const byName = Object.fromEntries(
      answers
        .filter((a): a is { name: string } => typeof a === "object" && a !== null && "name" in a)
        .map((a) => [a.name, a]),
    );
    return { ...rest, ...byName };
  }
  return typeof answers === "object" && answers !== null ? { ...rest, ...answers } : json;
}

// Confidence of the chosen option: the provider's own value, else its probability.
function confidenceOf(a: { choice: string; probabilities?: Record<string, number>; confidence?: number }) {
  return a.confidence ?? a.probabilities?.[a.choice];
}

function requestBody(state: string, model: string) {
  return {
    model,
    state,
    questions: {
      category: { type: "choice", instructions: DM_INSTRUCTIONS.category, criteria: CATEGORY_CRITERIA },
      priority: { type: "choice", instructions: DM_INSTRUCTIONS.priority, criteria: PRIORITY_CRITERIA },
    },
  };
}

// One HTTP attempt. Throws DmRequestError for transport/HTTP failures.
async function post(body: unknown): Promise<unknown> {
  if (!DM) throw new DmNotConfiguredError();
  let response: Response;
  try {
    response = await fetch(DM.baseUrl + DM.path, {
      method: "POST",
      headers: { Authorization: `Bearer ${DM.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DmRequestError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!response.ok) {
    // Keep provider details in the server log only.
    console.error("DM request failed:", response.status, (await response.text()).slice(0, 300));
    throw new DmRequestError(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new LlmInvalidOutputError("not JSON");
  }
}

// Same retry policy as the OpenAI SDK: retry 429, 5xx, timeouts and network errors, with backoff.
function isRetryable(error: unknown): boolean {
  if (!(error instanceof DmRequestError)) return false;
  return typeof error.failure === "string" || error.failure === 429 || error.failure >= 500;
}

export async function decide(
  ticket: { subject: string; body: string },
  log: LogContext,
): Promise<DmDecision> {
  if (!DM) throw new DmNotConfiguredError();
  const dm = DM;
  const started = performance.now();
  const entry = {
    route: log.route,
    api: "dm" as const,
    prompt_version: PROMPT_VERSIONS.dm,
    strategy: log.strategy,
    model: dm.model,
    ticket_id: log.ticketId,
  };

  try {
    let json: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        json = await post(requestBody(ticketText(ticket), dm.model));
        break;
      } catch (error) {
        if (!isRetryable(error) || attempt >= LLM_MAX_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }

    const parsed = DmResponse.safeParse(normalize(json));
    if (!parsed.success) {
      throw new LlmInvalidOutputError("schema mismatch", formatIssues(parsed.error));
    }
    const categoryConfidence = confidenceOf(parsed.data.category);
    const priorityConfidence = confidenceOf(parsed.data.priority);
    if (categoryConfidence === undefined || priorityConfidence === undefined) {
      throw new LlmInvalidOutputError("schema mismatch", ["the decision model returned no probability"]);
    }

    const inputTokens = parsed.data.usage?.input_tokens;
    const usage = inputTokens === undefined ? null : { input_tokens: inputTokens };
    await logCall({
      ...entry,
      usage: usage && { input_tokens: usage.input_tokens, output_tokens: 0, total_tokens: usage.input_tokens },
      status: 200,
      latency_ms: Math.round(performance.now() - started),
      cost_usd: estimateDmCost(dm.model, usage?.input_tokens ?? null),
    });
    return {
      category: parsed.data.category.choice,
      priority: parsed.data.priority.choice,
      confidence: { category: categoryConfidence, priority: priorityConfidence },
      usage,
      model: dm.model,
    };
  } catch (error) {
    const { status, code } = toApiError(error);
    await logCall({
      ...entry,
      usage: null,
      status,
      code,
      latency_ms: Math.round(performance.now() - started),
      cost_usd: null,
    });
    throw error;
  }
}
