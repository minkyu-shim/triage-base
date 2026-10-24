// Server only: one JSON line per LLM / DM call in logs/llm-calls.jsonl, read by /admin.
// Never log the key or the ticket text: only ids, models, tokens, status and timing.
import path from "node:path";
import { appendJsonl, readJsonl } from "./jsonl";
import { CallLogEntry, type Strategy, type Usage } from "./schemas";

const LOG_FILE = path.join(process.cwd(), "logs", "llm-calls.jsonl");

// Who made the call, passed down from the route so the log can say where it came from.
export type LogContext = { route: string; strategy?: Strategy; ticketId?: string };

type CallInput = Omit<CallLogEntry, "ts" | "input_tokens" | "output_tokens" | "total_tokens"> & {
  usage: Usage | null;
};

// A logging failure must never break the request that is being logged.
export async function logCall({ usage, ...rest }: CallInput): Promise<void> {
  const entry: CallLogEntry = {
    ts: new Date().toISOString(),
    ...rest,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
  };
  try {
    await appendJsonl(LOG_FILE, entry);
  } catch (error) {
    console.error("Could not log LLM call:", error);
  }
}

// Newest first.
export async function readCalls(): Promise<CallLogEntry[]> {
  return (await readJsonl(LOG_FILE, CallLogEntry)).reverse();
}
