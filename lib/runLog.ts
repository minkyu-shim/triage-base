// Server only: persists smoke-test runs.
// - logs/smoke-runs.jsonl: one summary per line, listed by /admin (gitignored).
// - runs/<date>-<prompt-version>-<strategy>-<model>.json: the full run, committed to compare runs.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, readJsonl } from "./jsonl";
import { SmokeRunSummary, type SmokeResponse } from "./schemas";

const LOG_FILE = path.join(process.cwd(), "logs", "smoke-runs.jsonl");
const RUNS_DIR = path.join(process.cwd(), "runs");

export async function appendRun(summary: SmokeRunSummary): Promise<void> {
  await appendJsonl(LOG_FILE, summary);
}

// Newest first.
export async function readRuns(): Promise<SmokeRunSummary[]> {
  return (await readJsonl(LOG_FILE, SmokeRunSummary)).reverse();
}

// Model names can contain "/" (typesafe/jev-1.13) and strategies "+": keep file names safe.
function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

// Writes the whole run and returns its path relative to the repo root.
// Ticket subjects are dropped: the file is committed and should hold ids and outputs only.
export async function writeRunFile(run: SmokeResponse): Promise<string> {
  const { summary } = run;
  // 2026-10-24T10:15:03.123Z -> 2026-10-24T10-15-03 (the time keeps two runs of a day apart)
  const date = summary.created_at.slice(0, 19).replace(/:/g, "-");
  const name = [date, summary.prompt_version ?? "triage-v2", summary.strategy ?? "llm", summary.model]
    .map(slug)
    .join("-");
  const file = path.join(RUNS_DIR, `${name}.json`);
  await mkdir(RUNS_DIR, { recursive: true });
  const results = run.results.map(({ subject: _subject, ...rest }) => rest);
  await writeFile(file, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  return path.relative(process.cwd(), file);
}
