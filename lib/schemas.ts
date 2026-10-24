import { z } from "zod";

// Shared contract between the browser pages and the API routes.
// Keep this file free of server-only imports (openai, fs, config) so the client can use it too.

export const Category = z.enum([
  "technical_bug",
  "feature_request",
  "account",
  "billing",
]);
export type Category = z.infer<typeof Category>;

export const Priority = z.enum(["low", "medium", "high"]);
export type Priority = z.infer<typeof Priority>;

// Who decides category and priority: the LLM alone, the decision model alone, or the
// decision model for the labels and the LLM for the text (summary + suggested action).
export const Strategy = z.enum(["llm", "dm", "dm+llm"]);
export type Strategy = z.infer<typeof Strategy>;

// ---------------------------------------------------------------------------
// Ticket input
// ---------------------------------------------------------------------------

// Tickets longer than this are rejected with a 400 before any provider call.
// The dataset has a few on purpose (tag exceeds_5000_chars): they must not reach the model.
export const MAX_TICKET_CHARS = 5000;

// The text sent to the model: subject + blank line + body (just the body when there is no subject).
export function ticketText(ticket: { subject: string; body: string }): string {
  return ticket.subject ? `${ticket.subject}\n\n${ticket.body}` : ticket.body;
}

const ticketWithinLimit: [
  (ticket: { subject: string; body: string }) => boolean,
  { message: string; path: string[] },
] = [
  (ticket) => ticketText(ticket).length <= MAX_TICKET_CHARS,
  { message: `Subject and body together must be at most ${MAX_TICKET_CHARS} characters`, path: ["body"] },
];

// customer_name / customer_email are left out on purpose: the LLM does not need PII to triage.
// Subject may be empty: ~11% of dataset tickets (e.g. chat messages) have none.
const TicketFields = z.object({
  subject: z.string().trim().max(300).default(""),
  body: z
    .string({ error: "Body is required" })
    .trim()
    .min(1, "Body is required")
    .max(MAX_TICKET_CHARS, `Body must be at most ${MAX_TICKET_CHARS} characters`),
});

// What the client sends to POST /api/triage and POST /api/triage/v1.
// model is checked against the server's allowed list in the route (the browser only sends a name).
export const TriageRequest = TicketFields.extend({
  language: z.string().trim().max(10).optional(),
  customer_plan: z.string().trim().max(50).optional(),
  strategy: Strategy.default("llm"),
  model: z.string().trim().max(100).optional(),
}).refine(...ticketWithinLimit);
export type TriageRequest = z.infer<typeof TriageRequest>;

// ---------------------------------------------------------------------------
// Model output
// ---------------------------------------------------------------------------

// What the LLM must return (triage-v2). It is also turned into the JSON schema sent to the model.
export const TriageResult = z.object({
  category: Category,
  priority: Priority,
  needs_human_review: z.boolean(),
  summary: z.string().min(1).max(300),
  suggested_action: z.string().min(1).max(500),
});
export type TriageResult = z.infer<typeof TriageResult>;

// dm+llm: the decision model already chose category and priority, the LLM only writes the text.
export const TriageWriteup = TriageResult.pick({
  needs_human_review: true,
  summary: true,
  suggested_action: true,
});
export type TriageWriteup = z.infer<typeof TriageWriteup>;

// Token usage of one LLM call. total_tokens comes from the provider and can exceed
// input + output (Gemini counts hidden "thinking" tokens in the total).
export const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

// Decision models only bill input tokens.
export const DmUsage = z.object({ input_tokens: z.number().int().nonnegative() });
export type DmUsage = z.infer<typeof DmUsage>;

// The decision model's probability for the option it chose.
export const Confidence = z.object({
  category: z.number().min(0).max(1),
  priority: z.number().min(0).max(1),
});
export type Confidence = z.infer<typeof Confidence>;

// What the API returns as the triage. summary / suggested_action are null with the dm strategy,
// because a decision model can only pick from closed sets, it cannot write text.
export const TriageOutput = z.object({
  category: Category,
  priority: Priority,
  needs_human_review: z.boolean(),
  summary: z.string().nullable(),
  suggested_action: z.string().nullable(),
  confidence: Confidence.nullable(),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

// llm_fallback: dm+llm, but the decision model was not confident enough, so the LLM decided.
export const DecidedBy = z.enum(["llm", "dm", "llm_fallback"]);
export type DecidedBy = z.infer<typeof DecidedBy>;

// What POST /api/triage returns on success.
export const TriageResponse = z.object({
  triage: TriageOutput,
  prompt_version: z.string(),
  strategy: Strategy,
  decided_by: DecidedBy,
  llm_model: z.string().nullable(),
  dm_model: z.string().nullable(),
  latency_ms: z.number().nonnegative(),
  usage: Usage.nullable(), // LLM tokens; null when no LLM call was made or none was reported
  dm_usage: DmUsage.nullable(),
  cost_usd: z.number().nonnegative().nullable(),
});
export type TriageResponse = z.infer<typeof TriageResponse>;

// What POST /api/triage/v1 returns: plain text, no schema (triage-v1).
export const TriageV1Response = z.object({
  text: z.string(),
  prompt_version: z.string(),
  model: z.string(),
  latency_ms: z.number().nonnegative(),
  usage: Usage.nullable(),
  cost_usd: z.number().nonnegative().nullable(),
});
export type TriageV1Response = z.infer<typeof TriageV1Response>;

// What any API route returns on a non-2xx status.
export const ErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.array(z.string()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// GET /api/models: names only, the keys never leave the server.
export const ModelsResponse = z.object({
  llm: z.array(z.string()),
  default_llm: z.string(),
  dm: z.string().nullable(), // null when no decision model is configured
});
export type ModelsResponse = z.infer<typeof ModelsResponse>;

// Single source of truth: the JSON schemas given to the LLM are generated from the Zod schemas.
// The "$schema" meta key is dropped because some providers reject unknown top-level keys.
function toProviderJsonSchema(schema: z.ZodType) {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}
export const triageResultJsonSchema = toProviderJsonSchema(TriageResult);
export const triageWriteupJsonSchema = toProviderJsonSchema(TriageWriteup);

// Turns Zod issues into short, human-readable lines for the UI ("body: Body is required").
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0
      ? `${issue.path.join(".")}: ${issue.message}`
      : issue.message,
  );
}

// ---------------------------------------------------------------------------
// Chat (POST /api/chat): the client keeps the history and resends it every time.
// ---------------------------------------------------------------------------

// No "system" role: the server owns the system message, a client must not inject one.
export const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatRequest = z.object({
  messages: z
    .array(ChatMessage)
    .min(1, "Send at least one message")
    .max(50, "The conversation is too long, please start a new one")
    .refine((messages) => messages.at(-1)?.role === "user", "The last message must come from the user"),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

// ---------------------------------------------------------------------------
// Explain (POST /api/triage/explain): a short streamed explanation of a triage.
// ---------------------------------------------------------------------------

export const ExplainRequest = z.object({
  ticket: TicketFields.refine(...ticketWithinLimit),
  triage: TriageOutput.pick({ category: true, priority: true, summary: true, suggested_action: true }),
});
export type ExplainRequest = z.infer<typeof ExplainRequest>;

// ---------------------------------------------------------------------------
// Per-call log (logs/llm-calls.jsonl): one line per LLM or DM call. No key, no ticket text.
// ---------------------------------------------------------------------------

export const CallLogEntry = z.object({
  ts: z.string(),
  route: z.string(),
  api: z.enum(["chat_completions", "dm"]),
  prompt_version: z.string().nullable(),
  strategy: Strategy.optional(),
  model: z.string(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
  status: z.number().int(), // HTTP status we mapped the outcome to (200 = success)
  code: z.string().optional(),
  latency_ms: z.number().nonnegative(),
  cost_usd: z.number().nonnegative().nullable(),
  ticket_id: z.string().optional(),
});
export type CallLogEntry = z.infer<typeof CallLogEntry>;

// ---------------------------------------------------------------------------
// Smoke test (F3): run triage on a random sample of a dataset and score it.
// ---------------------------------------------------------------------------

export const Dataset = z.enum(["labelled_100", "unlabelled_500"]);
export type Dataset = z.infer<typeof Dataset>;

// Capped at 100: every ticket is one LLM call, and the provider is rate-limited.
export const SMOKE_MAX_SAMPLE = 100;

export const SmokeRequest = z.object({
  dataset: Dataset,
  sampleSize: z
    .number({ error: "Sample size must be a number" })
    .int("Sample size must be a whole number")
    .min(1, "Sample size must be at least 1")
    .max(SMOKE_MAX_SAMPLE, `Sample size must be at most ${SMOKE_MAX_SAMPLE}`),
  strategy: Strategy.default("llm"),
  model: z.string().trim().max(100).optional(),
  // Re-run exactly these tickets (e.g. the same sample with another model) instead of a random sample.
  ticketIds: z.array(z.string()).max(SMOKE_MAX_SAMPLE).optional(),
});
export type SmokeRequest = z.infer<typeof SmokeRequest>;

// ok: valid triage. invalid_input: ticket rejected by TriageRequest (e.g. over 5,000 chars).
// invalid_output: model answered but failed validation. llm_error: the LLM or DM call itself failed.
export const SmokeStatus = z.enum(["ok", "invalid_input", "invalid_output", "llm_error"]);
export type SmokeStatus = z.infer<typeof SmokeStatus>;

export const SmokeTicketResult = z.object({
  ticket_id: z.string(),
  subject: z.string(),
  status: SmokeStatus,
  predicted: TriageOutput.optional(),
  decided_by: DecidedBy.optional(),
  // Only present for the labelled dataset.
  expected: z
    .object({ category: Category, priority: Priority, needs_human_review: z.boolean() })
    .optional(),
  category_match: z.boolean().optional(),
  priority_match: z.boolean().optional(),
  usage: Usage.nullable(),
  dm_usage: DmUsage.nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  latency_ms: z.number().nonnegative(),
  error: z.string().optional(),
});
export type SmokeTicketResult = z.infer<typeof SmokeTicketResult>;

// confusion[expected][predicted] = number of tickets.
export const Confusion = z.record(z.string(), z.record(z.string(), z.number().int()));
export type Confusion = z.infer<typeof Confusion>;

export const SmokeRunSummary = z.object({
  run_id: z.string(),
  created_at: z.string(),
  model: z.string(), // label of the model(s) used, e.g. "typesafe/jev-1.13 + gemini-…"
  dataset: Dataset,
  sample_size: z.number().int(),
  outcomes: z.object({
    ok: z.number().int(),
    invalid_input: z.number().int(),
    invalid_output: z.number().int(),
    llm_error: z.number().int(),
  }),
  // Mismatches and accuracy are counted over "ok" tickets only, and are null for the unlabelled set.
  category_mismatches: z.number().int().nullable(),
  priority_mismatches: z.number().int().nullable(),
  category_accuracy: z.number().min(0).max(1).nullable(),
  priority_accuracy: z.number().min(0).max(1).nullable(),
  avg_latency_ms: z.number().nonnegative(),
  total_latency_ms: z.number().nonnegative(), // sum of per-call latencies
  wall_time_ms: z.number().nonnegative(), // how long the whole run took
  tokens: Usage, // LLM tokens summed over the calls that reported usage
  cost_usd: z.number().nonnegative().nullable(), // null when a model used has no known price
  // The fields below were added with the DM strategies. They are optional so runs
  // logged before them still parse; a run without a strategy was an "llm" run.
  strategy: Strategy.optional(),
  prompt_version: z.string().optional(),
  llm_model: z.string().nullable().optional(),
  dm_model: z.string().nullable().optional(),
  dm_input_tokens: z.number().int().optional(),
  llm_fallbacks: z.number().int().optional(), // dm+llm: tickets where the DM was not confident
  review_accuracy: z.number().min(0).max(1).nullable().optional(), // needs_human_review vs label
  // Calibration: average confidence of the DM next to its accuracy. null without a DM.
  avg_category_confidence: z.number().min(0).max(1).nullable().optional(),
  avg_priority_confidence: z.number().min(0).max(1).nullable().optional(),
  category_confusion: Confusion.nullable().optional(),
  priority_confusion: Confusion.nullable().optional(),
  ticket_ids: z.array(z.string()).optional(), // to re-run the same sample with another model
  run_file: z.string().optional(), // runs/<…>.json, relative to the repo root
});
export type SmokeRunSummary = z.infer<typeof SmokeRunSummary>;

export const SmokeResponse = z.object({
  summary: SmokeRunSummary,
  results: z.array(SmokeTicketResult),
});
export type SmokeResponse = z.infer<typeof SmokeResponse>;
