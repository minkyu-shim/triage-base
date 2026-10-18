// Server only: runs triage over a random sample of a dataset and scores it against the labels.
import { APIError } from "openai";
import { getDataset, isLabelled, sampleTickets, type Ticket } from "./datasets";
import { llmModel } from "./llm";
import { estimateCost } from "./pricing";
import {
  formatIssues,
  TriageRequest,
  type SmokeRequest,
  type SmokeResponse,
  type SmokeTicketResult,
  type Usage,
} from "./schemas";
import { triageTicket, TriageOutputError } from "./triage";

// How many LLM calls run at the same time. Kept low to stay under provider rate limits;
// the OpenAI SDK also retries 429s twice with backoff on its own.
const CONCURRENCY = 3;

// Optional pacing for rate-limited providers (e.g. Gemini free tier ~15 requests/minute).
// LLM_MAX_RPM=15 spaces call starts 4 s apart; unset or 0 means no pacing.
const MAX_RPM = Number(process.env.LLM_MAX_RPM) || 0;

const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

// Triage one ticket and never throw: every failure becomes a status on that ticket,
// so one bad ticket does not abort the whole run.
async function runOne(ticket: Ticket, model: string): Promise<SmokeTicketResult> {
  const base = {
    ticket_id: ticket.ticket_id,
    subject: ticket.subject,
    expected: isLabelled(ticket)
      ? { category: ticket.category, priority: ticket.priority }
      : undefined,
  };

  // Same validation as POST /api/triage. Name and email are not sent to the LLM.
  const input = TriageRequest.safeParse({
    subject: ticket.subject,
    body: ticket.body,
    language: ticket.language,
    customer_plan: ticket.customer_plan,
  });
  if (!input.success) {
    return {
      ...base,
      status: "invalid_input",
      usage: ZERO_USAGE,
      latency_ms: 0,
      error: formatIssues(input.error).join("; "),
    };
  }

  const started = performance.now();
  try {
    const { triage, usage, latency_ms } = await triageTicket(input.data, model);
    return {
      ...base,
      status: "ok",
      predicted: triage,
      category_match: base.expected ? triage.category === base.expected.category : undefined,
      priority_match: base.expected ? triage.priority === base.expected.priority : undefined,
      usage,
      latency_ms,
    };
  } catch (error) {
    const latency_ms = Math.round(performance.now() - started);
    if (error instanceof TriageOutputError) {
      return { ...base, status: "invalid_output", usage: ZERO_USAGE, latency_ms, error: error.message };
    }
    const message =
      error instanceof APIError && error.status === 429
        ? "Rate limited by the provider (HTTP 429). Lower the sample size or set LLM_MAX_RPM."
        : error instanceof Error
          ? error.message.slice(0, 200)
          : String(error);
    return { ...base, status: "llm_error", usage: ZERO_USAGE, latency_ms, error: message };
  }
}

// Minimal worker pool: `limit` workers pull the next index until the list is done.
// Results keep the original order because each worker writes to its own index.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Returns a function that resolves when the next call may start, so call starts
// are at least 60 000 / maxRpm ms apart, whatever the number of workers.
function createPacer(maxRpm: number): () => Promise<void> {
  if (maxRpm <= 0) return async () => {};
  const interval = 60_000 / maxRpm;
  let nextSlot = Date.now();
  return async () => {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(nextSlot, Date.now()) + interval;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

export async function runSmokeTest(
  request: SmokeRequest,
  model: string = llmModel,
): Promise<SmokeResponse> {
  const started = performance.now();
  const tickets = sampleTickets<Ticket>(getDataset(request.dataset), request.sampleSize);
  const waitForSlot = createPacer(MAX_RPM);
  const results = await mapWithConcurrency(tickets, CONCURRENCY, async (ticket) => {
    await waitForSlot();
    return runOne(ticket, model);
  });
  const wall_time_ms = Math.round(performance.now() - started);

  const count = (status: SmokeTicketResult["status"]) =>
    results.filter((result) => result.status === status).length;
  const okResults = results.filter((result) => result.status === "ok");
  const labelled = request.dataset === "labelled_100";

  // Scored over "ok" tickets only: a failed call has no prediction to compare.
  const categoryMismatches = labelled ? okResults.filter((r) => !r.category_match).length : null;
  const priorityMismatches = labelled ? okResults.filter((r) => !r.priority_match).length : null;
  const accuracy = (mismatches: number | null) =>
    mismatches === null || okResults.length === 0 ? null : 1 - mismatches / okResults.length;

  const called = results.filter((result) => result.status !== "invalid_input");
  const total_latency_ms = called.reduce((sum, r) => sum + r.latency_ms, 0);
  const tokens = results.reduce(
    (sum, r) => ({
      input_tokens: sum.input_tokens + r.usage.input_tokens,
      output_tokens: sum.output_tokens + r.usage.output_tokens,
      total_tokens: sum.total_tokens + r.usage.total_tokens,
    }),
    ZERO_USAGE,
  );

  return {
    summary: {
      run_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      model,
      dataset: request.dataset,
      sample_size: results.length,
      outcomes: {
        ok: okResults.length,
        invalid_input: count("invalid_input"),
        invalid_output: count("invalid_output"),
        llm_error: count("llm_error"),
      },
      category_mismatches: categoryMismatches,
      priority_mismatches: priorityMismatches,
      category_accuracy: accuracy(categoryMismatches),
      priority_accuracy: accuracy(priorityMismatches),
      avg_latency_ms: called.length ? Math.round(total_latency_ms / called.length) : 0,
      total_latency_ms,
      wall_time_ms,
      tokens,
      cost_usd: estimateCost(model, tokens),
    },
    results,
  };
}
