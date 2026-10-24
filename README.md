# Support ticket triage app

An educational project (EPITA, AI System Integration & Operations): a support-ticket
triage app for "Kestrel Analytics" that calls an LLM, and optionally a decision model (DM),
from the backend. Next.js (App Router) + TypeScript, the `openai` SDK and Zod.

## What the app does

| Page / route | What it does |
|---|---|
| `/chat`, `POST /api/chat` | Chat with memory. The browser keeps the conversation and resends it every time, so the server stays stateless. A client-sent `system` message is rejected with 400. |
| `/`, `POST /api/triage` | **Triage v2**: category, priority, summary, suggested action and a human-review flag. The request and the model output are validated with Zod, and the model is constrained by a JSON schema generated from the same Zod schema. Shows token usage, latency, cost and the model(s) used. |
| `/` (version v1), `POST /api/triage/v1` | **Triage v1**: the same ticket, answered in plain text (`triage-v1`). Kept for comparison. |
| `/` strategy menu | `llm`, `dm` or `dm+llm` (see `LLM-DM-report.md`), plus an LLM model menu (names only, from `GET /api/models`). |
| `/` "Explain" button, `POST /api/triage/explain` | A short explanation for the support agent, **streamed** as it is generated. The triage itself is never streamed. |
| `/smoke`, `POST /api/smoke` | Smoke test on a random sample of the labelled 100 or unlabelled 500 dataset, with any strategy and model. For the labelled set: predicted vs labelled values, mismatch counts, accuracy, confusion matrices and DM calibration. "Re-run same tickets" repeats a sample with another model or strategy. Each run is saved to `runs/*.json`. |
| `/admin` | Every smoke run (accuracy, outcomes, latency, tokens, cost, strategy, LLM model, DM model). Tick two runs to compare them side by side. Also every LLM / DM call: errors by status, tokens and cost per prompt version × API × model, and the last 50 calls. |

Other files: `EXPERIMENTS.md` (prompt experiments), `LLM-DM-report.md` (DM research, strategy and results), `runs/` (smoke run files).

## Run locally

Requires Node.js 20.9 or newer.

```sh
cp .env.example .env.local   # then fill in the values
npm install
npm run dev                  # http://localhost:3033
```

| Variable | Meaning |
| --- | --- |
| `LLM_BASE_URL` | OpenAI-compatible endpoint, e.g. `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `LLM_API_KEY` | Provider API key (server only) |
| `LLM_MODEL` | Default model, e.g. `gemini-3.1-flash-lite-preview` |
| `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES` | Per-attempt timeout (default 20000) and retries (default 2) |
| `LLM_STRUCTURED_OUTPUT` | `json_schema` (default, the provider enforces the schema) or `prompt` (the schema is described in the prompt) |
| `LLM_MAX_RPM` | Optional cap on requests per minute during smoke tests |
| `DM_BASE_URL`, `DM_API_KEY`, `DM_MODEL`, `DM_PATH` | Decision model, e.g. `https://openrouter.ai/api`, `typesafe/jev-1.13`, `/v1/systemone`. Without them, the `dm` strategies answer with a clear error. |
| `DM_CONFIDENCE_THRESHOLD` | Below this probability the DM decision is not trusted on its own (default 0.6) |

The allowed models and their prices (USD per 1M tokens) are in `config/models.json`, not in code.

Logs: `logs/llm-calls.jsonl` (one line per LLM / DM call) and `logs/smoke-runs.jsonl` (one line per run). Both are gitignored and contain no key and no ticket text. They need a real disk, so they work with `npm run dev` / `npm run start` but not on serverless hosts.

## Quality checklist (Activity 7)

- [x] **One LLM module.** `lib/llm.ts` holds the only OpenAI client; every route goes through `chatCompletion()` / `streamCompletion()`. The DM has its own module, `lib/dm.ts`. No SDK calls in components.
- [x] **Prompts in one place with a version.** `lib/prompt.ts` (`triage-v1`, `triage-v2`, `triage-v2-writeup`, `dm-v1`, `explain-v1`, `chat-v1`). The version is logged with every call.
- [x] **All provider settings from config.** Env vars are read only in `lib/config.ts`; models and prices are in `config/models.json`.
- [x] **Every failure maps to one status and one safe message** (`lib/errors.ts`): 400 `invalid_request`, 502 `invalid_model_output` (retried once), 429 `rate_limited`, 502 `triage_unavailable`, 504 `triage_timeout`, 500 `internal_error`. The timeout and retries are set explicitly on the client. No stack trace or provider text reaches the browser: a wrong model name gives a generic 500, and the 404 details stay in the server log.
- [x] **The key is only on the server.** The browser only talks to our own routes, and their responses carry model names, never keys or URLs (checked on every route with curl; the browser's Network tab shows the same responses). `git check-ignore -v .env.local` → `.gitignore:13:.env*`.
- [x] **Over-long input → 400 with no provider call.** Subject + body over 5,000 characters is rejected by `TriageRequest`. In the smoke test, the two such dataset tickets (TCK-10308, TCK-10495) show as `invalid_input`.
- [x] **Logs have no key and no ticket text.** `logs/llm-calls.jsonl` stores the route, model, tokens, status, latency, cost and the ticket *id* only. Run files drop the subject too.
- [x] **Injection tickets don't change the category, priority or format.** TCK-10087, TCK-10035, TCK-10131 and TCK-10148 keep a valid schema and the expected labels (see `EXPERIMENTS.md`). Ticket text and model output are rendered as plain React text, never as HTML.

**Item we fixed:** ticket text used to be pasted raw inside `<ticket>…</ticket>`. TCK-10087 contains a literal `</ticket>` followed by fake "new instructions", which could close the data block early. `buildTicketMessage()` now escapes `<` and `>`, and the system prompt says so. We also lowered the input cap from 12,000 to 5,000 characters, so over-long tickets get a 400 instead of reaching the model.

## Model comparison (Activity 8 / F5)

The same 20 labelled tickets, strategy `llm`, prompt `triage-v2`, on 2026-10-24:

| | gemini-3.1-flash-lite-preview | gemini-3.5-flash-lite |
|---|---|---|
| Run file | `runs/2026-10-24T13-05-58-triage-v2-llm-gemini-3.1-flash-lite-preview.json` | `runs/2026-10-24T13-06-35-triage-v2-llm-gemini-3.5-flash-lite.json` |
| OK outcomes | 20 / 20 | 17 / 20 (3 × 429 rate limited) |
| Category accuracy | 95% | 100% (on 17) |
| Priority accuracy | 80% | 88% (on 17) |
| Review-flag accuracy | 95% | 100% (on 17) |
| Average latency | 8.4 s | 2.0 s |
| LLM tokens | 13,766 | 11,707 (17 calls) |
| Cost at paid-tier prices | $0.0057 | $0.0067 |

Three observed differences:
1. **Latency.** gemini-3.5-flash-lite answered in about 2 s per ticket, about 4× faster than the 3.1 preview (8.4 s).
2. **Rate limits / error messages.** The 3.5 model returned HTTP 429 on 3 of 20 tickets at 3 concurrent calls on the free tier. The 3.1 preview never did. The app showed them as `rate_limited`, and the run continued.
3. **Availability and structured output.** Both models accepted our strict JSON schema (`response_format: json_schema`). The older `gemini-2.5-flash` models now return 404 "no longer available to new users", which our error mapping turns into a clean 500 `internal_error`. On price, 3.5-flash-lite costs more per token ($0.30 / $2.50 vs $0.25 / $1.50 per 1M).

## Sample data

`data/` contains 500 unlabelled tickets (`support_tickets_500.{csv,json}`) and 100 labelled tickets (`support_tickets_100_labelled.{csv,json}`, with `category`, `priority`, `needs_human_review`, `tags`, `label_notes`). Tickets include prompt / HTML / SQL injection, secrets, PII and four languages, so the app treats all ticket text as untrusted.

## Checks

```sh
npm run typecheck
npm run build
```
