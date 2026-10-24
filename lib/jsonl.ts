// Server only: tiny JSON Lines store (one JSON object per line).
// Appending never rewrites older lines, so a crash mid-write can at worst damage the last
// line, which readJsonl() then skips. Works with `npm run dev` / `npm run start`;
// serverless hosts (e.g. Vercel) have no durable disk.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(value) + "\n", "utf8");
}

// In file order (oldest first). Lines that are not JSON or do not match the schema are skipped.
export async function readJsonl<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // Nothing logged yet.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}
