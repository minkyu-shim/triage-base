import type { Metadata } from "next";
import { connection } from "next/server";
import { readRuns } from "../../lib/runLog";

export const metadata: Metadata = { title: "Smoke test runs" };

function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

// Server component: reads the log file directly, so no API route or client fetch is needed.
export default async function AdminPage() {
  // Render on every request instead of once at build time, so new runs show up immediately.
  await connection();
  const runs = await readRuns();

  return (
    <main className="chat wide">
      <h1>Smoke test runs</h1>
      <p>
        Every smoke test run, newest first. Cost is an estimate at paid-tier prices.{" "}
        <a href="/smoke">Run a smoke test</a> · <a href="/">Back to triage</a>
      </p>

      {runs.length === 0 ? (
        <p>
          No runs logged yet. Start one from the <a href="/smoke">smoke test page</a>.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Model</th>
                <th>Dataset</th>
                <th>Sample</th>
                <th>Category accuracy</th>
                <th>Priority accuracy</th>
                <th>Outcomes (ok / invalid in / invalid out / LLM error)</th>
                <th>Avg latency</th>
                <th>Run time</th>
                <th>Tokens (in / out / total)</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id}>
                  <td>{new Date(run.created_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</td>
                  <td>{run.model}</td>
                  <td>{run.dataset}</td>
                  <td>{run.sample_size}</td>
                  <td>
                    {percent(run.category_accuracy)}
                    {run.category_mismatches !== null && (
                      <small className="meta"> ({run.category_mismatches} wrong)</small>
                    )}
                  </td>
                  <td>
                    {percent(run.priority_accuracy)}
                    {run.priority_mismatches !== null && (
                      <small className="meta"> ({run.priority_mismatches} wrong)</small>
                    )}
                  </td>
                  <td>
                    {run.outcomes.ok} / {run.outcomes.invalid_input} / {run.outcomes.invalid_output} /{" "}
                    {run.outcomes.llm_error}
                  </td>
                  <td>{run.avg_latency_ms} ms</td>
                  <td>{(run.wall_time_ms / 1000).toFixed(1)} s</td>
                  <td>
                    {run.tokens.input_tokens} / {run.tokens.output_tokens} / {run.tokens.total_tokens}
                  </td>
                  <td>{usd(run.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
