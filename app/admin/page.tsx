import type { Metadata } from "next";
import { connection } from "next/server";
import { readCalls } from "../../lib/callLog";
import { usd } from "../../lib/format";
import { readRuns } from "../../lib/runLog";
import type { CallLogEntry } from "../../lib/schemas";
import { RunsTable } from "./RunsTable";

export const metadata: Metadata = { title: "Admin" };

type Group = {
  key: string;
  prompt_version: string;
  api: string;
  model: string;
  calls: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unpriced: number; // calls with no known cost
  latency_ms: number;
};

// Totals per prompt version × API × model.
function groupCalls(calls: CallLogEntry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const call of calls) {
    const prompt_version = call.prompt_version ?? "—";
    const key = `${prompt_version}|${call.api}|${call.model}`;
    const group = groups.get(key) ?? {
      key,
      prompt_version,
      api: call.api,
      model: call.model,
      calls: 0,
      errors: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      unpriced: 0,
      latency_ms: 0,
    };
    group.calls += 1;
    if (call.status !== 200) group.errors += 1;
    group.input_tokens += call.input_tokens ?? 0;
    group.output_tokens += call.output_tokens ?? 0;
    if (call.cost_usd === null) group.unpriced += 1;
    else group.cost_usd += call.cost_usd;
    group.latency_ms += call.latency_ms;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.calls - a.calls);
}

function countByStatus(calls: CallLogEntry[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = call.status === 200 ? "200 ok" : `${call.status} ${call.code ?? ""}`.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort();
}

// Server component: reads the log files directly, so no API route or client fetch is needed.
export default async function AdminPage() {
  // Render on every request instead of once at build time, so new runs show up immediately.
  await connection();
  const [runs, calls] = await Promise.all([readRuns(), readCalls()]);
  const groups = groupCalls(calls);
  const byStatus = countByStatus(calls);
  const totalCost = calls.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0);
  const totalTokens = calls.reduce((sum, call) => sum + (call.total_tokens ?? 0), 0);
  const errors = calls.filter((call) => call.status !== 200).length;

  return (
    <main className="chat wide">
      <h1>Admin</h1>
      <p>
        Smoke test runs and every LLM / decision model call. Costs are estimates at the paid-tier prices in{" "}
        <code>config/models.json</code>. <a href="/smoke">Run a smoke test</a> · <a href="/">Back to triage</a>
      </p>

      <h2>Smoke test runs</h2>
      {runs.length === 0 ? (
        <p>
          No runs logged yet. Start one from the <a href="/smoke">smoke test page</a>.
        </p>
      ) : (
        <RunsTable runs={runs} />
      )}

      <h2>LLM and decision model calls</h2>
      {calls.length === 0 ? (
        <p>No calls logged yet. Triage a ticket to see one here.</p>
      ) : (
        <>
          <section className="summary">
            <ul>
              <li>
                {calls.length} calls · {errors} errors · {totalTokens} tokens · {usd(totalCost)} estimated cost
              </li>
              <li>
                By status:{" "}
                {byStatus.map(([status, count], index) => (
                  <span key={status}>
                    {index > 0 && " · "}
                    {status}: {count}
                  </span>
                ))}
              </li>
            </ul>
          </section>

          <div className="table-wrap">
            <table>
              <caption>Per prompt version, API and model</caption>
              <thead>
                <tr>
                  <th>Prompt version</th>
                  <th>API</th>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>Errors</th>
                  <th>Tokens (in / out)</th>
                  <th>Avg latency</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key}>
                    <td>{group.prompt_version}</td>
                    <td>{group.api}</td>
                    <td>{group.model}</td>
                    <td>{group.calls}</td>
                    <td>{group.errors}</td>
                    <td>
                      {group.input_tokens} / {group.output_tokens}
                    </td>
                    <td>{Math.round(group.latency_ms / group.calls)} ms</td>
                    <td>
                      {usd(group.cost_usd)}
                      {group.unpriced > 0 && <small className="meta"> ({group.unpriced} unpriced)</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-wrap">
            <table>
              <caption>Last 50 calls (no ticket text is ever logged)</caption>
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Route</th>
                  <th>API</th>
                  <th>Strategy</th>
                  <th>Prompt</th>
                  <th>Model</th>
                  <th>Ticket</th>
                  <th>Status</th>
                  <th>Tokens (in / out / total)</th>
                  <th>Latency</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {calls.slice(0, 50).map((call, index) => (
                  <tr key={`${call.ts}-${index}`}>
                    <td>{call.ts.slice(0, 19).replace("T", " ")}</td>
                    <td>{call.route}</td>
                    <td>{call.api}</td>
                    <td>{call.strategy ?? "—"}</td>
                    <td>{call.prompt_version ?? "—"}</td>
                    <td>{call.model}</td>
                    <td>{call.ticket_id ?? "—"}</td>
                    <td className={call.status === 200 ? undefined : "mismatch"}>
                      {call.status} {call.code}
                    </td>
                    <td>
                      {call.input_tokens ?? "—"} / {call.output_tokens ?? "—"} / {call.total_tokens ?? "—"}
                    </td>
                    <td>{call.latency_ms} ms</td>
                    <td>{usd(call.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
