// Small display helpers shared by the pages (browser-safe).
import type { DmUsage, Usage } from "./schemas";

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}

export function usd(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : `$${value.toFixed(6)}`;
}

export function tokens(usage: Usage | null): string {
  return usage
    ? `${usage.input_tokens} in · ${usage.output_tokens} out · ${usage.total_tokens} total`
    : "usage not reported";
}

export function dmTokens(usage: DmUsage | null): string {
  return usage ? `${usage.input_tokens} in` : "usage not reported";
}
