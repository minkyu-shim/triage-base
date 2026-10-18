"use client";

import { useState, type FormEvent } from "react";
import {
  ErrorResponse,
  formatIssues,
  TriageRequest,
  TriageResponse,
} from "../lib/schemas";

type TriageEntry = {
  subject: string;
  response: TriageResponse;
};

const LANGUAGES = ["", "en", "es", "fr", "de"] as const;

export default function TriagePage() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [language, setLanguage] = useState("");
  const [plan, setPlan] = useState("");
  const [results, setResults] = useState<TriageEntry[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  async function submitTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSending) return;

    setError(null);
    setDetails([]);

    // 1. Validate in the browser first, with the same schema the server uses.
    //    Empty optional fields are sent as undefined, not "".
    const input = TriageRequest.safeParse({
      subject,
      body,
      language: language || undefined,
      customer_plan: plan.trim() || undefined,
    });
    if (!input.success) {
      setError("Please fix the ticket before sending it.");
      setDetails(formatIssues(input.error));
      return;
    }

    setIsSending(true);
    try {
      const response = await fetch("/api/triage", {
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

      // 2. Non-2xx: show the server's error and its details, if it sent any.
      if (!response.ok) {
        const failure = ErrorResponse.safeParse(data);
        setError(
          failure.success
            ? failure.data.error
            : `Triage failed (HTTP ${response.status}).`,
        );
        setDetails(failure.success ? (failure.data.details ?? []) : []);
        return;
      }

      // 3. 2xx: still validate. A wrong shape is an error, not something to render.
      const success = TriageResponse.safeParse(data);
      if (!success.success) {
        setError("Server returned an unexpected response.");
        setDetails(formatIssues(success.error));
        return;
      }

      setResults((previous) => [
        { subject: input.data.subject, response: success.data },
        ...previous,
      ]);
      setSubject("");
      setBody("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to triage the ticket. Please try again.",
      );
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="chat">
      <h1>Ticket triage</h1>
      <p>
        Paste a support ticket to get its category, priority and review flag.{" "}
        <a href="/smoke">Run a smoke test</a> · <a href="/chat">Open the chat</a>
      </p>

      {/* noValidate: we validate with Zod ourselves so errors look the same everywhere. */}
      <form onSubmit={submitTicket} aria-busy={isSending} noValidate>
        <label htmlFor="subject">Subject (optional)</label>
        <input
          id="subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Cannot export invoices"
          disabled={isSending}
        />

        <label htmlFor="body">Body</label>
        <textarea
          id="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Describe the customer's problem..."
          rows={8}
          disabled={isSending}
        />
        <small className="hint">{body.length} / 12000 characters</small>

        <div className="row">
          <label>
            Language
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={isSending}
            >
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {code || "(unknown)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Customer plan
            <input
              value={plan}
              onChange={(event) => setPlan(event.target.value)}
              placeholder="Business"
              disabled={isSending}
            />
          </label>
        </div>

        <button type="submit" disabled={isSending}>
          {isSending ? "Triaging..." : "Triage ticket"}
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

      <section className="messages" aria-label="Triage results" aria-live="polite">
        {results.length === 0 && <p>No tickets triaged yet.</p>}
        {/* Plain JSX text only: React escapes it, so HTML in tickets is never executed. */}
        {results.map(({ subject, response }, index) => (
          <article className="message result" key={index}>
            <strong>{subject || "(no subject)"}</strong>
            <div className="badges">
              <span className={`badge category-${response.triage.category}`}>
                {response.triage.category}
              </span>
              <span className={`badge priority-${response.triage.priority}`}>
                {response.triage.priority}
              </span>
              {response.triage.needs_human_review && (
                <span className="badge review">needs human review</span>
              )}
            </div>
            <p>{response.triage.summary}</p>
            <small className="meta">
              Tokens: {response.usage.input_tokens} in ·{" "}
              {response.usage.output_tokens} out ·{" "}
              {response.usage.total_tokens} total · {response.latency_ms} ms ·{" "}
              {response.model}
            </small>
          </article>
        ))}
      </section>
    </main>
  );
}
