"use client";

import { useState, type FormEvent } from "react";
import {
  ErrorResponse,
  formatIssues,
  SMOKE_MAX_SAMPLE,
  SmokeRequest,
  SmokeResponse,
  type Dataset,
} from "../../lib/schemas";

const DATASETS: { value: Dataset; label: string }[] = [
  { value: "labelled_100", label: "Labelled 100 (with ground truth)" },
  { value: "unlabelled_500", label: "Unlabelled 500" },
];

function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

export default function SmokePage() {
  const [dataset, setDataset] = useState<Dataset>("labelled_100");
  const [sampleSize, setSampleSize] = useState("10");
  const [run, setRun] = useState<SmokeResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isRunning) return;

    setError(null);
    setDetails([]);

    // Number("") is 0 and Number("abc") is NaN: both are rejected by the schema with a clear message.
    const input = SmokeRequest.safeParse({ dataset, sampleSize: Number(sampleSize) });
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

  const labelled = run?.summary.dataset === "labelled_100";

  return (
    <main className="chat wide">
      <h1>Smoke test</h1>
      <p>
        Triage a random sample of tickets and compare against the labels.{" "}
        <a href="/">Back to triage</a> · <a href="/admin">Run history</a>
      </p>

      <form onSubmit={startRun} aria-busy={isRunning} noValidate>
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
        </div>

        <button type="submit" disabled={isRunning}>
          {isRunning ? `Running ${sampleSize} tickets...` : "Run smoke test"}
        </button>

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

      {run && (
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
                    <td title={result.error}>{result.status}</td>
                    <td className={result.category_match === false ? "mismatch" : undefined}>
                      {result.predicted?.category ?? "—"}
                    </td>
                    {labelled && <td>{result.expected?.category ?? "—"}</td>}
                    <td className={result.priority_match === false ? "mismatch" : undefined}>
                      {result.predicted?.priority ?? "—"}
                    </td>
                    {labelled && <td>{result.expected?.priority ?? "—"}</td>}
                    <td>{result.usage.total_tokens}</td>
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
                    Category mismatches: {run.summary.category_mismatches} / {run.summary.outcomes.ok}{" "}
                    (accuracy {percent(run.summary.category_accuracy)})
                  </li>
                  <li>
                    Priority mismatches: {run.summary.priority_mismatches} / {run.summary.outcomes.ok}{" "}
                    (accuracy {percent(run.summary.priority_accuracy)})
                  </li>
                </>
              )}
              <li>
                Outcomes: {run.summary.outcomes.ok} ok · {run.summary.outcomes.invalid_input} invalid input ·{" "}
                {run.summary.outcomes.invalid_output} invalid output · {run.summary.outcomes.llm_error} LLM errors
              </li>
              <li>
                Latency: {run.summary.avg_latency_ms} ms average · run took{" "}
                {(run.summary.wall_time_ms / 1000).toFixed(1)} s
              </li>
              <li>
                Tokens: {run.summary.tokens.input_tokens} in · {run.summary.tokens.output_tokens} out ·{" "}
                {run.summary.tokens.total_tokens} total
              </li>
              <li>Estimated cost (paid tier): {usd(run.summary.cost_usd)}</li>
              <li>Model: {run.summary.model}</li>
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
