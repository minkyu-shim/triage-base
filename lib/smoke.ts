// Server only: runs triage over a random sample of a dataset and scores it against the labels.
import { DM, LLM_MAX_RPM } from "./config";
import { getDataset, isLabelled, sampleTickets, type Ticket } from "./datasets";
import { LlmInvalidOutputError, toApiError } from "./errors";
import { PROMPT_VERSIONS } from "./prompt";
import {
  Category,
  formatIssues,
  Priority,
  TriageRequest,
  type Confusion,
  type SmokeRequest,
  type SmokeResponse,
  type SmokeTicketResult,
  type Strategy,
  type Usage,
} from "./schemas";
import { triageTicket } from "./triage";

// How many tickets are triaged at the same time. Kept low to stay under provider rate limits;
// the OpenAI SDK also retries 429s with backoff on its own.
const CONCURRENCY = 3;

const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

type RunOptions = { strategy: Strategy; model: string };

// Triage one ticket and never throw: every failure becomes a status on that ticket,
// so one bad ticket does not abort the whole run.
async function runOne(ticket: Ticket, { strategy, model }: RunOptions): Promise<SmokeTicketResult> {
  const base = {
    ticket_id: ticket.ticket_id,
    subject: ticket.subject,
    expected: isLabelled(ticket)
      ? { category: ticket.category, priority: ticket.priority, needs_human_review: ticket.needs_human_review }
      : undefined,
  };
  const noUsage = { usage: null, dm_usage: null, cost_usd: null };

  // Same validation as POST /api/triage (incl. the 5,000-char cap). Name and email are not sent.
  const input = TriageRequest.safeParse({
    subject: ticket.subject,
    body: ticket.body,
    language: ticket.language,
    customer_plan: ticket.customer_plan,
    strategy,
  });
  if (!input.success) {
    return {
      ...base,
      ...noUsage,
      status: "invalid_input",
      latency_ms: 0,
      error: formatIssues(input.error).join("; "),
    };
  }

  const started = performance.now();
  try {
    const result = await triageTicket(input.data, {
      strategy,
      model,
      log: { route: "/api/smoke", ticketId: ticket.ticket_id },
    });
    return {
      ...base,
      status: "ok",
      predicted: result.triage,
      decided_by: result.decided_by,
      category_match: base.expected ? result.triage.category === base.expected.category : undefined,
      priority_match: base.expected ? result.triage.priority === base.expected.priority : undefined,
      usage: result.usage,
      dm_usage: result.dm_usage,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
    };
  } catch (error) {
    // The failed calls (and the tokens they spent) are still in logs/llm-calls.jsonl.
    return {
      ...base,
      ...noUsage,
      status: error instanceof LlmInvalidOutputError ? "invalid_output" : "llm_error",
      latency_ms: Math.round(performance.now() - started),
      error: toApiError(error).message,
    };
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

// Returns a function that resolves when the next ticket may start, so starts are at least
// 60 000 / maxRpm ms apart, whatever the number of workers. (dm+llm makes 2 calls per ticket.)
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

// confusion[expected][predicted], with every cell present so the table has no holes.
function confusionMatrix<T extends string>(
  options: readonly T[],
  pairs: { expected: T; predicted: T }[],
): Confusion {
  const matrix: Confusion = Object.fromEntries(
    options.map((expected) => [expected, Object.fromEntries(options.map((predicted) => [predicted, 0]))]),
  );
  for (const { expected, predicted } of pairs) matrix[expected][predicted] += 1;
  return matrix;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pickTickets(request: SmokeRequest): Ticket[] {
  const dataset: Ticket[] = getDataset(request.dataset);
  if (!request.ticketIds) return sampleTickets(dataset, request.sampleSize);
  const byId = new Map(dataset.map((ticket) => [ticket.ticket_id, ticket]));
  return request.ticketIds.flatMap((id) => byId.get(id) ?? []);
}

export async function runSmokeTest(request: SmokeRequest, model: string): Promise<SmokeResponse> {
  const { strategy } = request;
  const started = performance.now();
  const tickets = pickTickets(request);
  const waitForSlot = createPacer(LLM_MAX_RPM);
  const results = await mapWithConcurrency(tickets, CONCURRENCY, async (ticket) => {
    await waitForSlot();
    return runOne(ticket, { strategy, model });
  });
  const wall_time_ms = Math.round(performance.now() - started);

  const count = (status: SmokeTicketResult["status"]) =>
    results.filter((result) => result.status === status).length;
  const okResults = results.filter((result) => result.status === "ok");
  const labelled = request.dataset === "labelled_100";

  // Scored over "ok" tickets only: a failed call has no prediction to compare.
  const scored = okResults.flatMap((r) => (r.expected && r.predicted ? [{ expected: r.expected, predicted: r.predicted }] : []));
  const categoryMismatches = labelled ? okResults.filter((r) => !r.category_match).length : null;
  const priorityMismatches = labelled ? okResults.filter((r) => !r.priority_match).length : null;
  const accuracy = (mismatches: number | null) =>
    mismatches === null || okResults.length === 0 ? null : 1 - mismatches / okResults.length;
  const reviewMatches = scored.filter((s) => s.expected.needs_human_review === s.predicted.needs_human_review).length;

  const called = results.filter((result) => result.status !== "invalid_input");
  const total_latency_ms = called.reduce((sum, r) => sum + r.latency_ms, 0);
  const tokens = results.reduce(
    (sum, r) => ({
      input_tokens: sum.input_tokens + (r.usage?.input_tokens ?? 0),
      output_tokens: sum.output_tokens + (r.usage?.output_tokens ?? 0),
      total_tokens: sum.total_tokens + (r.usage?.total_tokens ?? 0),
    }),
    ZERO_USAGE,
  );
  const dm_input_tokens = results.reduce((sum, r) => sum + (r.dm_usage?.input_tokens ?? 0), 0);
  // Cost of the successful tickets; null if one of them has no known price.
  const costs = okResults.map((r) => r.cost_usd);
  const cost_usd = costs.some((cost) => cost === null)
    ? null
    : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);

  const confidences = okResults.flatMap((r) => (r.predicted?.confidence ? [r.predicted.confidence] : []));
  const llm_model = strategy === "dm" ? null : model;
  const dm_model = strategy === "llm" ? null : (DM?.model ?? null);
  const prompt_version =
    strategy === "llm" ? PROMPT_VERSIONS.v2 : strategy === "dm" ? PROMPT_VERSIONS.dm : `${PROMPT_VERSIONS.dm}+${PROMPT_VERSIONS.writeup}`;

  return {
    summary: {
      run_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      model: [dm_model, llm_model].filter(Boolean).join(" + "),
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
      cost_usd,
      strategy,
      prompt_version,
      llm_model,
      dm_model,
      dm_input_tokens,
      llm_fallbacks: results.filter((r) => r.decided_by === "llm_fallback").length,
      review_accuracy: labelled && scored.length ? reviewMatches / scored.length : null,
      avg_category_confidence: average(confidences.map((c) => c.category)),
      avg_priority_confidence: average(confidences.map((c) => c.priority)),
      category_confusion: labelled
        ? confusionMatrix(Category.options, scored.map((s) => ({ expected: s.expected.category, predicted: s.predicted.category })))
        : null,
      priority_confusion: labelled
        ? confusionMatrix(Priority.options, scored.map((s) => ({ expected: s.expected.priority, predicted: s.predicted.priority })))
        : null,
      ticket_ids: results.map((r) => r.ticket_id),
    },
    results,
  };
}
