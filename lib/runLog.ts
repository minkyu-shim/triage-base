// Server only: persists smoke-test summaries so /admin can list them.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SmokeRunSummary } from "./schemas";

// One JSON object per line (JSONL). Appending never rewrites older runs, so a crash
// mid-write can at worst damage the last line, which readRuns() then skips.
// Works with `npm run dev` / `npm run start`; serverless hosts (e.g. Vercel) have no durable disk.
const LOG_FILE = path.join(process.cwd(), "logs", "smoke-runs.jsonl");

export async function appendRun(summary: SmokeRunSummary): Promise<void> {
  await mkdir(path.dirname(LOG_FILE), { recursive: true });
  await appendFile(LOG_FILE, JSON.stringify(summary) + "\n", "utf8");
}

// Newest first. Lines that are not valid JSON or no longer match the schema are skipped.
export async function readRuns(): Promise<SmokeRunSummary[]> {
  let text: string;
  try {
    text = await readFile(LOG_FILE, "utf8");
  } catch (error) {
    // No run logged yet.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const runs: SmokeRunSummary[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = SmokeRunSummary.safeParse(json);
    if (parsed.success) runs.push(parsed.data);
  }
  return runs.reverse();
}
