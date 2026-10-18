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
export const TriageRequest = z.object({
  subject: z.string({ error: "Subject is required" }).trim().min(1, "Subject is required").max(300),
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

// What POST /api/triage returns on success.
export const TriageResponse = z.object({
  triage: TriageResult,
  model: z.string(),
  latency_ms: z.number().nonnegative(),
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
