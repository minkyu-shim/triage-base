"use client";

import { useState, type ReactNode } from "react";
import { percent, usd } from "../../lib/format";
import type { SmokeRunSummary } from "../../lib/schemas";

// Runs logged before the DM strategies have no strategy / llm_model fields: they were LLM runs.
function modelsOf(run: SmokeRunSummary) {
  return {
    strategy: run.strategy ?? "llm",
    llm: run.llm_model !== undefined ? run.llm_model : run.model,
    dm: run.dm_model ?? null,
  };
}

function date(run: SmokeRunSummary): string {
  return `${new Date(run.created_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

type Metric = {
  label: string;
  show: (run: SmokeRunSummary) => ReactNode;
  // For numeric metrics: the value to compare, and whether higher is better.
  value?: (run: SmokeRunSummary) => number | null | undefined;
  higherIsBetter?: boolean;
};

const METRICS: Metric[] = [
  { label: "Date", show: date },
  { label: "Strategy", show: (run) => modelsOf(run).strategy },
  { label: "LLM model", show: (run) => modelsOf(run).llm ?? "—" },
  { label: "Decision model", show: (run) => modelsOf(run).dm ?? "—" },
  { label: "Prompt version", show: (run) => run.prompt_version ?? "triage-v2" },
  { label: "Dataset / sample", show: (run) => `${run.dataset} / ${run.sample_size}` },
  { label: "Category accuracy", show: (run) => percent(run.category_accuracy), value: (run) => run.category_accuracy, higherIsBetter: true },
  { label: "Priority accuracy", show: (run) => percent(run.priority_accuracy), value: (run) => run.priority_accuracy, higherIsBetter: true },
  { label: "Review flag accuracy", show: (run) => percent(run.review_accuracy), value: (run) => run.review_accuracy, higherIsBetter: true },
  { label: "Avg DM confidence (cat / prio)", show: (run) => `${percent(run.avg_category_confidence)} / ${percent(run.avg_priority_confidence)}` },
  { label: "OK outcomes", show: (run) => `${run.outcomes.ok} / ${run.sample_size}`, value: (run) => run.outcomes.ok / Math.max(run.sample_size, 1), higherIsBetter: true },
  {
    label: "Invalid in / invalid out / provider error",
    show: (run) => `${run.outcomes.invalid_input} / ${run.outcomes.invalid_output} / ${run.outcomes.llm_error}`,
  },
  { label: "Avg latency", show: (run) => `${run.avg_latency_ms} ms`, value: (run) => run.avg_latency_ms, higherIsBetter: false },
  { label: "Run time", show: (run) => `${(run.wall_time_ms / 1000).toFixed(1)} s`, value: (run) => run.wall_time_ms, higherIsBetter: false },
  { label: "LLM tokens (total)", show: (run) => run.tokens.total_tokens, value: (run) => run.tokens.total_tokens, higherIsBetter: false },
  { label: "DM input tokens", show: (run) => run.dm_input_tokens ?? "—" },
  { label: "Cost", show: (run) => usd(run.cost_usd), value: (run) => run.cost_usd, higherIsBetter: false },
  { label: "Run file", show: (run) => run.run_file ?? "—" },
];

// Every run, newest first, with checkboxes: pick two to see them side by side.
export function RunsTable({ runs }: { runs: SmokeRunSummary[] }) {
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(runId: string) {
    setSelected((previous) =>
      previous.includes(runId)
        ? previous.filter((id) => id !== runId)
        : [...previous, runId].slice(-2), // keep the last two picked
    );
  }

  const compared = selected
    .map((id) => runs.find((run) => run.run_id === id))
    .filter((run): run is SmokeRunSummary => run !== undefined);

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Compare</th>
              <th>Date</th>
              <th>Strategy</th>
              <th>LLM model</th>
              <th>Decision model</th>
              <th>Dataset</th>
              <th>Sample</th>
              <th>Category accuracy</th>
              <th>Priority accuracy</th>
              <th>Outcomes (ok / invalid in / invalid out / provider error)</th>
              <th>Avg latency</th>
              <th>Run time</th>
              <th>LLM tokens (in / out / total)</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const models = modelsOf(run);
              return (
                <tr key={run.run_id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Compare run from ${date(run)}`}
                      checked={selected.includes(run.run_id)}
                      onChange={() => toggle(run.run_id)}
                    />
                  </td>
                  <td>{date(run)}</td>
                  <td>{models.strategy}</td>
                  <td>{models.llm ?? "—"}</td>
                  <td>{models.dm ?? "—"}</td>
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
              );
            })}
          </tbody>
        </table>
      </div>

      {compared.length === 2 ? (
        <div className="table-wrap">
          <table>
            <caption>Side by side (better value in bold)</caption>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Run A</th>
                <th>Run B</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map((metric) => {
                const [a, b] = compared.map((run) => metric.value?.(run));
                const comparable = typeof a === "number" && typeof b === "number" && a !== b;
                const aWins = comparable && (metric.higherIsBetter ? a > b : a < b);
                const bWins = comparable && !aWins;
                return (
                  <tr key={metric.label}>
                    <th>{metric.label}</th>
                    <td className={aWins ? "better" : undefined}>{metric.show(compared[0])}</td>
                    <td className={bWins ? "better" : undefined}>{metric.show(compared[1])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">Tick two runs to compare them side by side.</p>
      )}
    </>
  );
}
