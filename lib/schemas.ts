import { z } from "zod";

// Shared contract between the browser (app/page.tsx) and the API routes.
// Keep this file free of server-only imports (openai, fs) so the client can use it too.

export const Category = z.enum([
  "technical_bug",
  "feature_request",
  "account",
  "billing",
]);
export type Category = z.infer<typeof Category>;

export const Priority = z.enum(["low", "medium", "high"]);
export type Priority = z.infer<typeof Priority>;

// What the client sends to POST /api/triage.
// customer_name / customer_email are left out on purpose: the LLM does not need PII to triage.
// The 12k cap is above the longest dataset body (~9.3k chars) but rejects absurd input.
// Subject may be empty: ~11% of dataset tickets (e.g. chat messages) have none.
export const TriageRequest = z.object({
  subject: z.string().trim().max(300).default(""),
  body: z.string({ error: "Body is required" }).trim().min(1, "Body is required").max(12000),
  language: z.string().trim().max(10).optional(),
  customer_plan: z.string().trim().max(50).optional(),
});
export type TriageRequest = z.infer<typeof TriageRequest>;

// What the LLM must return. It is also turned into the JSON schema sent to the model.
export const TriageResult = z.object({
  category: Category,
  priority: Priority,
  needs_human_review: z.boolean(),
  summary: z.string().max(300),
});
export type TriageResult = z.infer<typeof TriageResult>;

// Token usage of one LLM call. total_tokens comes from the provider and can exceed
// input + output (Gemini counts hidden "thinking" tokens in the total).
export const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

// What POST /api/triage returns on success.
export const TriageResponse = z.object({
  triage: TriageResult,
  model: z.string(),
  latency_ms: z.number().nonnegative(),
  usage: Usage,
});
export type TriageResponse = z.infer<typeof TriageResponse>;

// What any API route returns on a non-2xx status.
export const ErrorResponse = z.object({
  error: z.string(),
  details: z.array(z.string()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// Single source of truth: the JSON schema given to the LLM is generated from the Zod schema.
// The "$schema" meta key is dropped because some providers reject unknown top-level keys.
const { $schema: _ignored, ...triageResultJsonSchema } = z.toJSONSchema(TriageResult);
export { triageResultJsonSchema };

// Turns Zod issues into short, human-readable lines for the UI ("body: Body is required").
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0
      ? `${issue.path.join(".")}: ${issue.message}`
      : issue.message,
  );
}

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
});
export type SmokeRequest = z.infer<typeof SmokeRequest>;

// ok: valid triage. invalid_input: ticket rejected by TriageRequest.
// invalid_output: model answered but failed TriageResult. llm_error: the call itself failed.
export const SmokeStatus = z.enum(["ok", "invalid_input", "invalid_output", "llm_error"]);
export type SmokeStatus = z.infer<typeof SmokeStatus>;

export const SmokeTicketResult = z.object({
  ticket_id: z.string(),
  subject: z.string(),
  status: SmokeStatus,
  predicted: TriageResult.optional(),
  // Only present for the labelled dataset.
  expected: z.object({ category: Category, priority: Priority }).optional(),
  category_match: z.boolean().optional(),
  priority_match: z.boolean().optional(),
  usage: Usage,
  latency_ms: z.number().nonnegative(),
  error: z.string().optional(),
});
export type SmokeTicketResult = z.infer<typeof SmokeTicketResult>;

export const SmokeRunSummary = z.object({
  run_id: z.string(),
  created_at: z.string(),
  model: z.string(),
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
  tokens: Usage, // summed over all calls
  cost_usd: z.number().nonnegative().nullable(), // null when the model has no known price
});
export type SmokeRunSummary = z.infer<typeof SmokeRunSummary>;

export const SmokeResponse = z.object({
  summary: SmokeRunSummary,
  results: z.array(SmokeTicketResult),
});
export type SmokeResponse = z.infer<typeof SmokeResponse>;
