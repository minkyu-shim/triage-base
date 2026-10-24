// Server only: cost estimates. The prices live in config/models.json, not in code.
import { MODELS } from "./config";
import type { Usage } from "./schemas";

// null when the model has no price in the config or the provider reported no usage:
// the UI then shows "n/a" rather than a wrong number.
export function estimateCost(model: string, usage: Usage | null): number | null {
  const price = MODELS.llm[model];
  if (!price || !usage) return null;
  // Gemini bills hidden "thinking" tokens as output. They are in total_tokens but not in
  // output_tokens, so billed output is whatever the total has beyond the input.
  const billedOutput = Math.max(usage.output_tokens, usage.total_tokens - usage.input_tokens);
  return (
    (usage.input_tokens / 1_000_000) * price.inputPerMTok +
    (billedOutput / 1_000_000) * price.outputPerMTok
  );
}

// Decision models bill input tokens only (state + questions).
export function estimateDmCost(model: string, inputTokens: number | null): number | null {
  const price = MODELS.dm[model];
  if (!price || inputTokens === null) return null;
  return (inputTokens / 1_000_000) * price.inputPerMTok;
}
