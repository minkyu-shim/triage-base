# LLM vs Decision Model (DM) for ticket triage

## 1. What a DM is, and what it can and cannot do here

A decision model takes a **state** (the text to judge) plus **typed questions**, and answers each question with **probabilities** instead of free text. The question types are `choice` (one option from a closed set), `noul` (yes/no) and `score` (an ordered scale).

| Triage field | DM? | Why |
|---|---|---|
| `category` (4 options) | **Yes** | A closed set, so a `choice` question. |
| `priority` (low / medium / high) | **Yes** | A closed set: a `choice` question, or a `score` on an ordered scale. |
| `needs_human_review` | Partly | Could be a `noul` question. We derive it from the DM's confidence instead (low confidence → review). |
| `summary`, `suggested_action` | **No** | Free text: a DM cannot write. |

The DM also returns a confidence for each answer. That's useful for routing: a low-confidence answer goes to an LLM or to a human.

## 2. DM research (checked 2026-10-24)

| Provider | Model | Endpoint | Price / access | Notes |
|---|---|---|---|---|
| OpenRouter | `typesafe/jev-1.13` | `POST https://openrouter.ai/api/v1/systemone` | **$0.042 per 1M input tokens, output free.** Pay-as-you-go with OpenRouter credits. | The same account and key also gives access to many LLMs. ([model page](https://openrouter.ai/typesafe), [SDK docs](https://openrouter.ai/docs/client-sdks/go/sdks/systemone/README.md)) |
| LLM Gateway | `jev-1.13.0` (TypeSafe) | `POST https://api.llmgateway.io/v1/systemone` (being deprecated in favor of `/v1/decisions`) | Input tokens only; no price or free tier stated. | The docs show the real response shape: answers are nested under `answers`, each with `choice`, `probabilities` and `confidence`. ([docs](https://docs.llmgateway.io/features/system-one)) |
| OpenAI | Decisions API on `gpt-6-luna` | `POST /v1/decisions` | $0.10 per 1M input tokens, **no free Decisions tier**. Public beta since 2026-10-06. | Different body: `input` plus a `questions` array with `choices` / `levels`. ([apidog guide](https://apidog.com/blog/openai-decisions-api/), [news](https://aiweekly.co/alerts/openai-launches-decisions-api-public-beta-on-gpt-6-luna)) |
| ngrok AI Gateway | TypeSafe Jev | gateway | $0.042 per 1M input, billed to ngrok credits | ([changelog](https://ngrok.com/changelog/ai-gateway-typesafe-jev)) |
| DigitalOcean | TypeSafe Jev | System One API | Needs a qualifying account tier | ([docs](https://docs.digitalocean.com/products/inference/how-to/use-system-one-api/)) |
| vLLM Semantic Router "Decision 3.0" | `vllm-sr/d3…` | `/v1/systemone` (per the course slides) | I could not find anything about `decision.vllm-sr.ai` or a hosted Decision 3.0 API. | The vLLM Semantic Router project itself is a routing framework you host yourself. ([arXiv](https://arxiv.org/abs/2603.04444)) |
| Cloudflare (Clef), Perplexity (`pplx-decider-v1-27b`), AWS (Strands Decider), Liquid AI (d1) | — | not confirmed | not checked in depth | Open-weight models would need self-hosting, which is out of scope here. |

**No hosted DM with an explicit free tier was found.** "Limited usage" is allowed, so the selected option is the cheapest hosted one:

**Choice: OpenRouter, `typesafe/jev-1.13`, System One endpoint.**
- **Cost is negligible.** A ticket is roughly 300–600 input tokens including the questions, so a 100-ticket run costs about 100 × 450 × $0.042 / 1M ≈ **$0.002**. That fits in the smallest OpenRouter credit.
- **It uses the System One request format from the course** (`state` + `questions` with `criteria` maps), so our request matches the slides.
- **One key, one account.** The same OpenRouter account could also serve the LLM side later.
- **Fallback:** LLM Gateway serves the same model on the same endpoint shape. Switching only needs `DM_BASE_URL` and `DM_MODEL`.

If even this is not possible, the instructor should be contacted, as the assignment says.

## 3. How the DM is integrated

- `lib/dm.ts` calls the endpoint with plain `fetch` (the OpenAI SDK does not support decision endpoints). It retries 429, 5xx and timeouts with backoff, and logs every call to `logs/llm-calls.jsonl` with `api: "dm"`.
- **Same definitions for both models.** The category and priority definitions sent to the DM as `criteria` are the same objects the LLM prompt uses (`CATEGORY_CRITERIA` / `PRIORITY_CRITERIA` in `lib/prompt.ts`), so the LLM and the DM are judged on the same definitions.
- **The DM output is validated with Zod like the LLM output.** The choice must be one of our enum values and the probabilities must be numbers between 0 and 1. It accepts both response shapes seen in the docs (answers at the top level, or nested under `answers`). An invalid answer becomes `502 invalid_model_output`.
- **Strategy selector** on `/` and `/smoke`: `llm`, `dm`, `dm+llm`. Logs, run files and `/admin` record the strategy, the LLM model and the DM model.

| Strategy | Category + priority | Summary + action | Review flag |
|---|---|---|---|
| `llm` | LLM (`triage-v2`) | LLM | LLM |
| `dm` | DM | none (shown as "not available") | true if DM confidence < `DM_CONFIDENCE_THRESHOLD` (0.6) |
| `dm+llm` | DM if both confidences ≥ 0.6, **otherwise the full LLM triage** (`decided_by: llm_fallback`) | LLM (`triage-v2-writeup`, which is given the DM decision and told not to change it) | LLM, forced to true on fallback |

## 4. Which strategy and why: (LLM or DM) vs (DM + LLM)

**Recommendation: `dm+llm` with a confidence threshold.**
- A support agent needs the summary and the suggested action, and a DM alone cannot produce them. So `dm` alone is only good for routing or queue assignment.
- `llm` alone works: 95% category and 80% priority accuracy on 20 labelled tickets. But it gives no calibrated confidence, and each call costs output tokens and about 8 s on the free tier.
- `dm+llm` uses each model for what it is good at. The DM picks the closed-set labels with probabilities, and the LLM writes the text. Low-confidence tickets fall back to the LLM and to a human, which puts review effort where it is needed. The cost added by the DM is tiny (input tokens at $0.042/M).
- **What would change this choice:** if the DM's measured accuracy on the dev set is clearly below the LLM's (section 5), or if its confidence turns out to be poorly calibrated, `llm` with the review flag stays the better default.

## 5. Evaluation

What we measure, all logged automatically by the smoke test (`/smoke` → `/admin` and `runs/*.json`):
- category and priority accuracy on the labelled dev set (and confusion matrices)
- review-flag accuracy against `needs_human_review`
- outcome counts (ok / invalid input / invalid output / provider error)
- average latency and total run time
- tokens and estimated cost per run (prices in `config/models.json`)
- **calibration:** average DM confidence next to DM accuracy. If confidence averages 0.9 but accuracy is 0.75, the threshold must be raised.

### Results so far (real runs, same 20 labelled tickets)

| Run file | Strategy | Model(s) | OK | Category acc. | Priority acc. | Review acc. | Avg latency | Cost (paid tier) |
|---|---|---|---|---|---|---|---|---|
| `runs/2026-10-24T13-05-58-triage-v2-llm-gemini-3.1-flash-lite-preview.json` | llm | gemini-3.1-flash-lite-preview | 20/20 | 95% | 80% | 95% | 8.4 s | $0.0057 |
| `runs/2026-10-24T13-06-35-triage-v2-llm-gemini-3.5-flash-lite.json` | llm | gemini-3.5-flash-lite | 17/20 (3 × 429) | 100% | 88% | 100% | 2.0 s | $0.0067 |
| *to fill in* | dm | typesafe/jev-1.13 | | | | | | |
| *to fill in* | dm+llm | typesafe/jev-1.13 + gemini-3.1-flash-lite-preview | | | | | | |

> **Status:** the DM code paths (`dm`, `dm+llm` with and without fallback, the smoke test, logging and `/admin`) were tested end to end against a local stand-in server that speaks the System One format. Those numbers are **not** reported here because they are not a real model. To fill in the two rows above: put an OpenRouter key in `.env.local` (`DM_BASE_URL=https://openrouter.ai/api`, `DM_MODEL=typesafe/jev-1.13`), then on `/smoke` press "Re-run same 20 tickets" with strategy `dm`, then `dm+llm`.

### Caveats to keep in mind
- **Confidence is not always honest.** The course example had 87% average confidence for 75% accuracy, so we compare the two in every run.
- **A DM may agree more with frontier LLMs than with our ground truth.** Our labels encode team-specific rules (e.g. "access blocked by payment = billing").
- **Close options are hard for both models.** In our runs the confusions are account vs technical_bug (TCK-10396, TCK-10410) and medium vs high priority.
- **Vendor speed and price figures are the vendors' own numbers.** We measure latency ourselves, and 20 tickets is a small sample.

## 6. Which model for which task (one sentence)

Use **the DM (`typesafe/jev-1.13`) for the closed-set decisions (category and priority, with a confidence that drives human review)**, and **`gemini-3.1-flash-lite-preview` for the text (summary, suggested action, explanations)**. On the free tier it was slower than `gemini-3.5-flash-lite` but was never rate-limited (compare `runs/2026-10-24T13-05-58-…` with `runs/2026-10-24T13-06-35-…`).
