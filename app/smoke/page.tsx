"use client";

import { useState, type FormEvent } from "react";
import { percent, usd } from "../../lib/format";
import {
  ErrorResponse,
  formatIssues,
  SMOKE_MAX_SAMPLE,
  SmokeRequest,
  SmokeResponse,
  type Confusion,
  type Dataset,
  type Strategy,
} from "../../lib/schemas";
import { useModels } from "../useModels";

const DATASETS: { value: Dataset; label: string }[] = [
  { value: "labelled_100", label: "Labelled 100 (with ground truth)" },
  { value: "unlabelled_500", label: "Unlabelled 500" },
];

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: "llm", label: "LLM only" },
  { value: "dm", label: "Decision model only" },
  { value: "dm+llm", label: "Decision model + LLM" },
];

export default function SmokePage() {
  const models = useModels();
  const [dataset, setDataset] = useState<Dataset>("labelled_100");
  const [sampleSize, setSampleSize] = useState("10");
  const [strategy, setStrategy] = useState<Strategy>("llm");
  const [model, setModel] = useState("");
  const [run, setRun] = useState<SmokeResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  // ticketIds: re-run exactly these tickets (same sample, other model or strategy) for a fair comparison.
  async function startRun(ticketIds?: string[]) {
    if (isRunning) return;

    setError(null);
    setDetails([]);

    // Number("") is 0 and Number("abc") is NaN: both are rejected by the schema with a clear message.
    const input = SmokeRequest.safeParse({
      dataset: ticketIds && run ? run.summary.dataset : dataset,
      sampleSize: ticketIds ? ticketIds.length : Number(sampleSize),
      strategy,
      model: model || undefined,
      ticketIds,
    });
    if (!input.success) {
      setError("Please fix the smoke test settings.");
      setDetails(formatIssues(input.error));
      return;
    }

    setIsRunning(true);
    setRun(null);
    try {
      const response = await fetch("/api/smoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.data),
      });

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error("The server returned a non-JSON reply.");
      }

      if (!response.ok) {
        const failure = ErrorResponse.safeParse(data);
        setError(failure.success ? failure.data.error : `Smoke test failed (HTTP ${response.status}).`);
        setDetails(failure.success ? (failure.data.details ?? []) : []);
        return;
      }

      const success = SmokeResponse.safeParse(data);
      if (!success.success) {
        setError("Server returned an unexpected response.");
        setDetails(formatIssues(success.error));
        return;
      }
      setRun(success.data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to run the smoke test.");
    } finally {
      setIsRunning(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void startRun();
  }

  const labelled = run?.summary.dataset === "labelled_100";
  const summary = run?.summary;

  return (
    <main className="chat wide">
      <h1>Smoke test</h1>
      <p>
        Triage a random sample of tickets and compare against the labels.{" "}
        <a href="/">Back to triage</a> · <a href="/admin">Admin</a>
      </p>

      <form onSubmit={onSubmit} aria-busy={isRunning} noValidate>
        <div className="row">
          <label>
            Dataset
            <select
              value={dataset}
              onChange={(event) => setDataset(event.target.value as Dataset)}
              disabled={isRunning}
            >
              {DATASETS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tickets to sample (1–{SMOKE_MAX_SAMPLE})
            <input
              type="number"
              min={1}
              max={SMOKE_MAX_SAMPLE}
              value={sampleSize}
              onChange={(event) => setSampleSize(event.target.value)}
              disabled={isRunning}
            />
          </label>
          <label>
            Strategy
            <select
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as Strategy)}
              disabled={isRunning}
            >
              {STRATEGIES.map((option) => (
                <option key={option.value} value={option.value} disabled={option.value !== "llm" && models?.dm === null}>
                  {option.label}
                  {option.value !== "llm" && models?.dm === null ? " (not configured)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            LLM model
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={isRunning || strategy === "dm"}
            >
              <option value="">{models ? `${models.default_llm} (default)` : "server default"}</option>
              {models?.llm
                .filter((name) => name !== models.default_llm)
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
        </div>

        <div className="actions">
          {run?.summary.ticket_ids && (
            <button
              type="button"
              className="secondary"
              disabled={isRunning}
              onClick={() => void startRun(run.summary.ticket_ids)}
              title="Run the same tickets again with the strategy and model selected above"
            >
              Re-run same {run.summary.ticket_ids.length} tickets
            </button>
          )}
          <button type="submit" disabled={isRunning}>
            {isRunning ? "Running..." : "Run smoke test"}
          </button>
        </div>

        {error && (
          <div role="alert">
            <p>{error}</p>
            {details.length > 0 && (
              <ul>
                {details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>

      {run && summary && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Predicted category</th>
                  {labelled && <th>Expected category</th>}
                  <th>Predicted priority</th>
                  {labelled && <th>Expected priority</th>}
                  <th>Review</th>
                  {summary.strategy !== "llm" && <th>DM confidence (cat / prio)</th>}
                  <th>Tokens</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {/* Plain JSX text only: subjects come from untrusted tickets. */}
                {run.results.map((result) => (
                  <tr key={result.ticket_id}>
                    <td>{result.ticket_id}</td>
                    <td>{result.subject || "(no subject)"}</td>
                    <td title={result.error}>
                      {result.status}
                      {result.decided_by === "llm_fallback" && <small className="meta"> (LLM fallback)</small>}
                      {result.error && <small className="meta"> {result.error}</small>}
                    </td>
                    <td className={result.category_match === false ? "mismatch" : undefined}>
                      {result.predicted?.category ?? "—"}
                    </td>
                    {labelled && <td>{result.expected?.category ?? "—"}</td>}
                    <td className={result.priority_match === false ? "mismatch" : undefined}>
                      {result.predicted?.priority ?? "—"}
                    </td>
                    {labelled && <td>{result.expected?.priority ?? "—"}</td>}
                    <td>
                      {result.predicted ? (result.predicted.needs_human_review ? "yes" : "no") : "—"}
                      {result.expected && <small className="meta"> (label: {result.expected.needs_human_review ? "yes" : "no"})</small>}
                    </td>
                    {summary.strategy !== "llm" && (
                      <td>
                        {result.predicted?.confidence
                          ? `${percent(result.predicted.confidence.category)} / ${percent(result.predicted.confidence.priority)}`
                          : "—"}
                      </td>
                    )}
                    <td>
                      {result.usage ? result.usage.total_tokens : "—"}
                      {result.dm_usage && <small className="meta"> + DM {result.dm_usage.input_tokens}</small>}
                    </td>
                    <td>{result.latency_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="summary" aria-label="Smoke test summary">
            <h2>Summary</h2>
            <ul>
              {labelled && (
                <>
                  <li>
                    Category mismatches: {summary.category_mismatches} / {summary.outcomes.ok}{" "}
                    (accuracy {percent(summary.category_accuracy)}
                    {summary.avg_category_confidence != null && `, avg DM confidence ${percent(summary.avg_category_confidence)}`})
                  </li>
                  <li>
                    Priority mismatches: {summary.priority_mismatches} / {summary.outcomes.ok}{" "}
                    (accuracy {percent(summary.priority_accuracy)}
                    {summary.avg_priority_confidence != null && `, avg DM confidence ${percent(summary.avg_priority_confidence)}`})
                  </li>
                  <li>Human-review flag accuracy: {percent(summary.review_accuracy)}</li>
                </>
              )}
              <li>
                Outcomes: {summary.outcomes.ok} ok · {summary.outcomes.invalid_input} invalid input ·{" "}
                {summary.outcomes.invalid_output} invalid output · {summary.outcomes.llm_error} provider errors
                {summary.strategy === "dm+llm" && ` · ${summary.llm_fallbacks ?? 0} LLM fallbacks`}
              </li>
              <li>
                Latency: {summary.avg_latency_ms} ms average · run took {(summary.wall_time_ms / 1000).toFixed(1)} s
              </li>
              <li>
                LLM tokens: {summary.tokens.input_tokens} in · {summary.tokens.output_tokens} out ·{" "}
                {summary.tokens.total_tokens} total
                {summary.dm_model && ` · DM input tokens: ${summary.dm_input_tokens ?? 0}`}
              </li>
              <li>Estimated cost (paid tier): {usd(summary.cost_usd)}</li>
              <li>
                Strategy: {summary.strategy ?? "llm"} · prompt {summary.prompt_version} · model {summary.model}
              </li>
              {summary.run_file && <li>Saved to {summary.run_file}</li>}
            </ul>

            {summary.category_confusion && (
              <ConfusionTable title="Category confusion (rows: label, columns: predicted)" matrix={summary.category_confusion} />
            )}
            {summary.priority_confusion && (
              <ConfusionTable title="Priority confusion (rows: label, columns: predicted)" matrix={summary.priority_confusion} />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function ConfusionTable({ title, matrix }: { title: string; matrix: Confusion }) {
  const options = Object.keys(matrix);
  return (
    <div className="table-wrap">
      <table className="confusion">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th />
            {options.map((predicted) => (
              <th key={predicted}>{predicted}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {options.map((expected) => (
            <tr key={expected}>
              <th>{expected}</th>
              {options.map((predicted) => {
                const count = matrix[expected][predicted] ?? 0;
                const className = count === 0 ? undefined : expected === predicted ? "hit" : "mismatch";
                return (
                  <td key={predicted} className={className}>
                    {count}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
