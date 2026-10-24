"use client";

import { useRef, useState, type FormEvent } from "react";
import { dmTokens, percent, tokens, usd } from "../lib/format";
import {
  ErrorResponse,
  formatIssues,
  MAX_TICKET_CHARS,
  ticketText,
  TriageRequest,
  TriageResponse,
  TriageV1Response,
  type Strategy,
} from "../lib/schemas";
import { useModels } from "./useModels";

type Ticket = { subject: string; body: string };

type TriageEntry =
  | {
      id: number;
      version: "v2";
      ticket: Ticket;
      response: TriageResponse;
      explanation?: string;
      explaining?: boolean;
      explainError?: string;
    }
  | { id: number; version: "v1"; ticket: Ticket; response: TriageV1Response };

const LANGUAGES = ["", "en", "es", "fr", "de"] as const;

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: "llm", label: "LLM only" },
  { value: "dm", label: "Decision model only" },
  { value: "dm+llm", label: "Decision model + LLM" },
];

// Turns a non-2xx JSON body into a message (with the error code) and a list of details.
function describeFailure(data: unknown, status: number): { message: string; details: string[] } {
  const failure = ErrorResponse.safeParse(data);
  if (!failure.success) return { message: `Request failed (HTTP ${status}).`, details: [] };
  const code = failure.data.code ? ` [${failure.data.code}]` : "";
  return { message: failure.data.error + code, details: failure.data.details ?? [] };
}

export default function TriagePage() {
  const models = useModels();
  const [version, setVersion] = useState<"v1" | "v2">("v2");
  const [strategy, setStrategy] = useState<Strategy>("llm");
  const [model, setModel] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [language, setLanguage] = useState("");
  const [plan, setPlan] = useState("");
  const [results, setResults] = useState<TriageEntry[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const nextId = useRef(0);

  const usesLlm = version === "v1" || strategy !== "dm";

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
      strategy,
      model: model || undefined,
    });
    if (!input.success) {
      setError("Please fix the ticket before sending it.");
      setDetails(formatIssues(input.error));
      return;
    }

    setIsSending(true);
    try {
      const response = await fetch(version === "v1" ? "/api/triage/v1" : "/api/triage", {
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

      // 2. Non-2xx: show the server's error, its code and its details, if it sent any.
      if (!response.ok) {
        const failure = describeFailure(data, response.status);
        setError(failure.message);
        setDetails(failure.details);
        return;
      }

      // 3. 2xx: still validate. A wrong shape is an error, not something to render.
      const ticket = { subject: input.data.subject, body: input.data.body };
      const id = nextId.current++;
      let entry: TriageEntry;
      if (version === "v1") {
        const success = TriageV1Response.safeParse(data);
        if (!success.success) {
          setError("Server returned an unexpected response.");
          setDetails(formatIssues(success.error));
          return;
        }
        entry = { id, version: "v1", ticket, response: success.data };
      } else {
        const success = TriageResponse.safeParse(data);
        if (!success.success) {
          setError("Server returned an unexpected response.");
          setDetails(formatIssues(success.error));
          return;
        }
        entry = { id, version: "v2", ticket, response: success.data };
      }

      setResults((previous) => [entry, ...previous]);
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

  function updateEntry(id: number, change: { explanation?: string; explaining?: boolean; explainError?: string }) {
    setResults((previous) =>
      previous.map((entry) => (entry.id === id && entry.version === "v2" ? { ...entry, ...change } : entry)),
    );
  }

  // Streams the explanation: the text is appended chunk by chunk as it arrives.
  async function explain(entry: Extract<TriageEntry, { version: "v2" }>) {
    updateEntry(entry.id, { explanation: "", explaining: true, explainError: undefined });
    try {
      const response = await fetch("/api/triage/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: entry.ticket, triage: entry.response.triage }),
      });
      if (!response.ok || !response.body) {
        const data: unknown = await response.json().catch(() => null);
        updateEntry(entry.id, { explainError: describeFailure(data, response.status).message });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        updateEntry(entry.id, { explanation: text });
      }
    } catch {
      updateEntry(entry.id, { explainError: "Unable to get an explanation. Please try again." });
    } finally {
      updateEntry(entry.id, { explaining: false });
    }
  }

  return (
    <main className="chat">
      <h1>Ticket triage</h1>
      <p>
        Paste a support ticket to get its category, priority, summary and suggested action.{" "}
        <a href="/smoke">Run a smoke test</a> · <a href="/admin">Admin</a> ·{" "}
        <a href="/chat">Open the chat</a>
      </p>

      {/* noValidate: we validate with Zod ourselves so errors look the same everywhere. */}
      <form onSubmit={submitTicket} aria-busy={isSending} noValidate>
        <div className="row three">
          <label>
            Prompt version
            <select
              value={version}
              onChange={(event) => setVersion(event.target.value as "v1" | "v2")}
              disabled={isSending}
            >
              <option value="v2">v2: structured JSON</option>
              <option value="v1">v1: plain text</option>
            </select>
          </label>
          <label>
            Strategy
            <select
              value={version === "v1" ? "llm" : strategy}
              onChange={(event) => setStrategy(event.target.value as Strategy)}
              disabled={isSending || version === "v1"}
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
              disabled={isSending || !usesLlm}
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
        <small className="hint">
          {ticketText({ subject: subject.trim(), body: body.trim() }).length} / {MAX_TICKET_CHARS} characters
          (subject + body)
        </small>

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
        {/* Plain JSX text only: React escapes it, so HTML in tickets or model output is never executed. */}
        {results.map((entry) =>
          entry.version === "v1" ? (
            <article className="message result" key={entry.id}>
              <strong>{entry.ticket.subject || "(no subject)"}</strong>
              <div className="badges">
                <span className="badge">triage-v1 · plain text</span>
              </div>
              <pre className="plain">{entry.response.text}</pre>
              <small className="meta">
                Tokens: {tokens(entry.response.usage)} · {entry.response.latency_ms} ms · {entry.response.model} ·
                cost {usd(entry.response.cost_usd)}
              </small>
            </article>
          ) : (
            <TriageCard key={entry.id} entry={entry} onExplain={() => explain(entry)} />
          ),
        )}
      </section>
    </main>
  );
}

function TriageCard({
  entry,
  onExplain,
}: {
  entry: Extract<TriageEntry, { version: "v2" }>;
  onExplain: () => void;
}) {
  const { response } = entry;
  const { triage } = response;
  const dmOnly = "not available with the decision-model-only strategy";
  return (
    <article className="message result">
      <strong>{entry.ticket.subject || "(no subject)"}</strong>
      <dl className="fields">
        <dt>Category</dt>
        <dd>
          <span className={`badge category-${triage.category}`}>{triage.category}</span>
          {triage.confidence && <small className="meta"> DM confidence {percent(triage.confidence.category)}</small>}
        </dd>
        <dt>Priority</dt>
        <dd>
          <span className={`badge priority-${triage.priority}`}>{triage.priority}</span>
          {triage.confidence && <small className="meta"> DM confidence {percent(triage.confidence.priority)}</small>}
        </dd>
        <dt>Summary</dt>
        <dd>{triage.summary ?? <em className="meta">{dmOnly}</em>}</dd>
        <dt>Suggested action</dt>
        <dd>{triage.suggested_action ?? <em className="meta">{dmOnly}</em>}</dd>
        <dt>Human review</dt>
        <dd>
          {triage.needs_human_review ? <span className="badge review">needs human review</span> : "not needed"}
        </dd>
      </dl>
      <small className="meta">
        {response.strategy} · decided by {response.decided_by} · {response.prompt_version}
        <br />
        {response.llm_model && (
          <>
            LLM {response.llm_model}: {tokens(response.usage)}
            <br />
          </>
        )}
        {response.dm_model && (
          <>
            DM {response.dm_model}: {dmTokens(response.dm_usage)}
            <br />
          </>
        )}
        {response.latency_ms} ms · cost {usd(response.cost_usd)}
      </small>

      <div className="explain">
        <button type="button" className="secondary" onClick={onExplain} disabled={entry.explaining}>
          {entry.explaining ? "Explaining..." : "Explain"}
        </button>
        {entry.explanation && <p>{entry.explanation}</p>}
        {entry.explainError && <p role="alert">{entry.explainError}</p>}
      </div>
    </article>
  );
}
