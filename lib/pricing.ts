import type { Usage } from "./schemas";

type Price = { inputPerMTok: number; outputPerMTok: number };

// USD per 1M text tokens, paid tier, from https://ai.google.dev/gemini-api/docs/pricing
// (checked 2026-10-18). Free-tier calls cost $0; these show what the run would cost on the paid tier.
// Models missing from this table get a null cost ("n/a" in the UI) rather than a wrong number.
const PRICES: Record<string, Price> = {
  "gemini-3.1-flash-lite": { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  // The pricing page does not list the preview ID; assumed to cost the same as the GA model above.
  "gemini-3.1-flash-lite-preview": { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

export function estimateCost(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  // Gemini bills hidden "thinking" tokens as output. They are in total_tokens but not in
  // output_tokens, so billed output is whatever the total has beyond the input.
  const billedOutput = Math.max(usage.output_tokens, usage.total_tokens - usage.input_tokens);
  return (
    (usage.input_tokens / 1_000_000) * price.inputPerMTok +
    (billedOutput / 1_000_000) * price.outputPerMTok
  );
}
