# Support ticket triage app

This repository is the starting point for an educational project in which
computer science students will build a support ticket triage application. The
planned application will use a large language model (LLM) from the backend to
help analyze incoming support requests and support the triage process.

The codebase is intentionally a basic skeleton. It provides a small chat
interface and server endpoint as a first step: before building the full triage
workflow, students can use this mock chat to validate the connection between
the application and an LLM provider.

## Current status

The app triages support tickets with an LLM called from the backend, through
any OpenAI-compatible provider (developed against Gemini).

- **Triage** (`/`, `POST /api/triage`): returns a category, priority,
  human-review flag and summary for one ticket. The request and the model's
  answer are both validated with Zod (`lib/schemas.ts`), and the model is
  constrained by a JSON schema generated from the same Zod schema. Each result
  shows its token usage (input, output, total) and latency.
- **Smoke test** (`/smoke`, `POST /api/smoke`): triages a random sample of the
  labelled 100 or unlabelled 500 dataset. For the labelled set it compares the
  predicted category and priority with the labels and counts mismatches.
- **Run history** (`/admin`): every smoke test run with its accuracy, outcome
  counts, latency, tokens, estimated cost and model.
- **Chat** (`/chat`, `POST /api/chat`): the original connectivity check, now
  answered by the LLM.

## Sample data

The `data/` folder contains two support-ticket datasets:

- **500 unlabelled tickets** in
  [`support_tickets_500.csv`](./data/support_tickets_500.csv) and
  [`support_tickets_500.json`](./data/support_tickets_500.json), for exploring
  and developing the triage workflow.
- **100 labelled tickets** in
  [`support_tickets_100_labelled.csv`](./data/support_tickets_100_labelled.csv)
  and
  [`support_tickets_100_labelled.json`](./data/support_tickets_100_labelled.json).
  These include triage annotations such as category, priority, and whether a
  ticket needs human review, making them useful for testing and evaluating
  triage approaches.

## Run locally

Requires Node.js 20.9 or newer.

```sh
cp .env.example .env.local   # then fill in the values
npm install
npm run dev
```

Open http://localhost:3033. Both `npm run dev` and `npm run start` use port
3033.

| Variable | Meaning |
| --- | --- |
| `LLM_BASE_URL` | OpenAI-compatible endpoint, e.g. `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `LLM_API_KEY` | Provider API key |
| `LLM_MODEL` | Model ID, e.g. `gemini-3.1-flash-lite-preview` |
| `LLM_MAX_RPM` | Optional. Max requests per minute during smoke tests (about 15 on the Gemini free tier) |

Smoke test runs are appended to `logs/smoke-runs.jsonl` (one JSON object per
line, gitignored). This works with `npm run dev` and `npm run start`, but not
on serverless hosts such as Vercel, which have no durable disk. Costs use the
paid-tier prices in `lib/pricing.ts`.

## Checks

```sh
npm run typecheck
npm run build
```
