// Server only: every provider setting is read here, from env vars and config/models.json.
// Nothing else in the app reads process.env, so there is one place to look.
import { z } from "zod";
import modelsJson from "../config/models.json";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function number(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

// --- LLM (any OpenAI-compatible provider) ---
export const LLM_BASE_URL = required("LLM_BASE_URL");
export const LLM_API_KEY = required("LLM_API_KEY");
export const LLM_MODEL = required("LLM_MODEL");
// The timeout applies to each attempt, so a call can take up to timeout × (retries + 1).
export const LLM_TIMEOUT_MS = number("LLM_TIMEOUT_MS", 20_000);
export const LLM_MAX_RETRIES = number("LLM_MAX_RETRIES", 2);
// json_schema: the provider constrains the answer to our JSON schema.
// prompt: the keys are described in the system prompt (for providers without structured output).
export const LLM_STRUCTURED_OUTPUT = z
  .enum(["json_schema", "prompt"])
  .parse(optional("LLM_STRUCTURED_OUTPUT") ?? "json_schema");
// Smoke tests only: max requests per minute (about 15 on the Gemini free tier). 0 = no limit.
export const LLM_MAX_RPM = number("LLM_MAX_RPM", 0);

// --- Decision model (optional: the dm strategies return a clear error until it is set) ---
const dmBaseUrl = optional("DM_BASE_URL");
const dmApiKey = optional("DM_API_KEY");
const dmModel = optional("DM_MODEL");
export const DM =
  dmBaseUrl && dmApiKey && dmModel
    ? {
        baseUrl: dmBaseUrl.replace(/\/+$/, ""),
        path: optional("DM_PATH") ?? "/v1/systemone",
        apiKey: dmApiKey,
        model: dmModel,
      }
    : null;
// Below this probability for category or priority, the DM decision is not trusted on its own.
export const DM_CONFIDENCE_THRESHOLD = number("DM_CONFIDENCE_THRESHOLD", 0.6);

// --- Allowed models and prices (config/models.json) ---
const Price = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});
export type Price = z.infer<typeof Price>;

const ModelsConfig = z.object({
  llm: z.record(z.string(), Price),
  dm: z.record(z.string(), Price),
});
export const MODELS = ModelsConfig.parse(modelsJson);

// The model menu: the default model first, then every priced model.
export const LLM_MODELS = [...new Set([LLM_MODEL, ...Object.keys(MODELS.llm)])];
