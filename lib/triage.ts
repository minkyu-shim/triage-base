// Server only: the triage logic behind POST /api/triage, /api/triage/v1 and the smoke test.
import type { z } from "zod";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { LogContext } from "./callLog";
import { DM_CONFIDENCE_THRESHOLD, LLM_STRUCTURED_OUTPUT } from "./config";
import { decide, type DmDecision } from "./dm";
import { LlmInvalidOutputError } from "./errors";
import { chatCompletion, completionText } from "./llm";
import { estimateCost, estimateDmCost } from "./pricing";
import {
  buildTicketMessage,
  buildWriteupMessage,
  jsonOnlyInstruction,
  PROMPT_VERSIONS,
  TRIAGE_V1_SYSTEM,
  TRIAGE_V2_SYSTEM,
  TRIAGE_WRITEUP_SYSTEM,
} from "./prompt";
import {
  formatIssues,
  TriageResult,
  triageResultJsonSchema,
  TriageWriteup,
  triageWriteupJsonSchema,
  type Strategy,
  type TriageOutput,
  type TriageRequest,
  type TriageResponse,
  type TriageV1Response,
  type Usage,
} from "./schemas";

// Some models wrap JSON in ```json … ``` when the schema is only described in the prompt.
// Stripping it is harmless in json_schema mode, where the provider returns bare JSON.
function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text;
}

// Never trust the model blindly: check truncation, parse, then validate with the Zod schema.
function parseWith<T>(schema: z.ZodType<T>) {
  return (completion: ChatCompletion): T => {
    const text = stripCodeFence(completionText(completion));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmInvalidOutputError("not JSON");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new LlmInvalidOutputError("schema mismatch", formatIssues(parsed.error));
    }
    return parsed.data;
  };
}

type StructuredCall<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonSchema: object;
  promptVersion: string;
  model: string;
  log: LogContext;
};

// A JSON answer, in either structured-output mode (LLM_STRUCTURED_OUTPUT in .env.local).
// Invalid output is retried once: a second sample often fixes a one-off slip. Both attempts are logged.
async function structuredCompletion<T>(call: StructuredCall<T>) {
  const useSchema = LLM_STRUCTURED_OUTPUT === "json_schema";
  const request = {
    log: call.log,
    promptVersion: call.promptVersion,
    model: call.model,
    messages: [
      { role: "system" as const, content: useSchema ? call.system : call.system + jsonOnlyInstruction(call.jsonSchema) },
      { role: "user" as const, content: call.user },
    ],
    responseFormat: useSchema
      ? {
          type: "json_schema" as const,
          json_schema: { name: "support_triage", schema: call.jsonSchema as Record<string, unknown>, strict: true },
        }
      : undefined,
    parse: parseWith(call.schema),
  };
  try {
    return await chatCompletion(request);
  } catch (error) {
    if (!(error instanceof LlmInvalidOutputError)) throw error;
    console.warn("Invalid model output, retrying once:", error.message, error.details);
    return chatCompletion(request);
  }
}

function llmTriage(input: TriageRequest, model: string, log: LogContext) {
  return structuredCompletion({
    system: TRIAGE_V2_SYSTEM,
    user: buildTicketMessage(input),
    schema: TriageResult,
    jsonSchema: triageResultJsonSchema,
    promptVersion: PROMPT_VERSIONS.v2,
    model,
    log,
  });
}

function llmWriteup(input: TriageRequest, decision: DmDecision, model: string, log: LogContext) {
  return structuredCompletion({
    system: TRIAGE_WRITEUP_SYSTEM,
    user: buildWriteupMessage(input, decision),
    schema: TriageWriteup,
    jsonSchema: triageWriteupJsonSchema,
    promptVersion: PROMPT_VERSIONS.writeup,
    model,
    log,
  });
}

function isConfident(decision: DmDecision): boolean {
  return Math.min(decision.confidence.category, decision.confidence.priority) >= DM_CONFIDENCE_THRESHOLD;
}

// Sum of the parts; null as soon as one part used has no known cost.
function totalCost(llm: { model: string; usage: Usage | null } | null, dm: DmDecision | null): number | null {
  const llmCost = llm ? estimateCost(llm.model, llm.usage) : 0;
  const dmCost = dm ? estimateDmCost(dm.model, dm.usage?.input_tokens ?? null) : 0;
  return llmCost === null || dmCost === null ? null : llmCost + dmCost;
}

export type TriageOptions = { strategy: Strategy; model: string; log: LogContext };

export async function triageTicket(input: TriageRequest, options: TriageOptions): Promise<TriageResponse> {
  const { strategy, model } = options;
  const log = { ...options.log, strategy };
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  // llm: the LLM decides everything.
  if (strategy === "llm") {
    const result = await llmTriage(input, model, log);
    return {
      triage: { ...result.value, confidence: null },
      prompt_version: PROMPT_VERSIONS.v2,
      strategy,
      decided_by: "llm",
      llm_model: model,
      dm_model: null,
      latency_ms: elapsed(),
      usage: result.usage,
      dm_usage: null,
      cost_usd: totalCost({ model, usage: result.usage }, null),
    };
  }

  const decision = await decide(input, log);

  // dm: the decision model alone. It cannot write text; low confidence goes to a human.
  if (strategy === "dm") {
    const triage: TriageOutput = {
      category: decision.category,
      priority: decision.priority,
      needs_human_review: !isConfident(decision),
      summary: null,
      suggested_action: null,
      confidence: decision.confidence,
    };
    return {
      triage,
      prompt_version: PROMPT_VERSIONS.dm,
      strategy,
      decided_by: "dm",
      llm_model: null,
      dm_model: decision.model,
      latency_ms: elapsed(),
      usage: null,
      dm_usage: decision.usage,
      cost_usd: totalCost(null, decision),
    };
  }

  // dm+llm, confident DM: the DM's labels, the LLM writes the summary and suggested action.
  if (isConfident(decision)) {
    const writeup = await llmWriteup(input, decision, model, log);
    return {
      triage: {
        category: decision.category,
        priority: decision.priority,
        ...writeup.value,
        confidence: decision.confidence,
      },
      prompt_version: `${PROMPT_VERSIONS.dm}+${PROMPT_VERSIONS.writeup}`,
      strategy,
      decided_by: "dm",
      llm_model: model,
      dm_model: decision.model,
      latency_ms: elapsed(),
      usage: writeup.usage,
      dm_usage: decision.usage,
      cost_usd: totalCost({ model, usage: writeup.usage }, decision),
    };
  }

  // dm+llm, unsure DM: fall back to the full LLM triage and flag it for a human.
  const fallback = await llmTriage(input, model, log);
  return {
    triage: { ...fallback.value, needs_human_review: true, confidence: decision.confidence },
    prompt_version: `${PROMPT_VERSIONS.dm}+${PROMPT_VERSIONS.v2}`,
    strategy,
    decided_by: "llm_fallback",
    llm_model: model,
    dm_model: decision.model,
    latency_ms: elapsed(),
    usage: fallback.usage,
    dm_usage: decision.usage,
    cost_usd: totalCost({ model, usage: fallback.usage }, decision),
  };
}

// triage-v1: plain text, no schema. Kept to compare with v2 (see EXPERIMENTS.md).
export async function triageTicketV1(input: TriageRequest, model: string, log: LogContext): Promise<TriageV1Response> {
  const { value, usage, latency_ms } = await chatCompletion({
    log,
    promptVersion: PROMPT_VERSIONS.v1,
    model,
    messages: [
      { role: "system", content: TRIAGE_V1_SYSTEM },
      { role: "user", content: buildTicketMessage(input) },
    ],
    parse: completionText,
  });
  return {
    text: value,
    prompt_version: PROMPT_VERSIONS.v1,
    model,
    latency_ms,
    usage,
    cost_usd: estimateCost(model, usage),
  };
}
