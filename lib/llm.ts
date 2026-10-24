// Server only: the one module that talks to the LLM. Routes and lib code call
// chatCompletion() / streamCompletion(); nothing else uses the SDK directly.
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { logCall, type LogContext } from "./callLog";
import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MAX_RETRIES,
  LLM_MODEL,
  LLM_MODELS,
  LLM_TIMEOUT_MS,
} from "./config";
import { LlmInvalidOutputError, toApiError } from "./errors";
import { estimateCost } from "./pricing";
import type { Usage } from "./schemas";

// timeout is per attempt: with 2 retries a call can take up to 3 × LLM_TIMEOUT_MS.
// The SDK retries 408/409/429/5xx and connection errors itself, with exponential backoff.
const llm = new OpenAI({
  apiKey: LLM_API_KEY,
  baseURL: LLM_BASE_URL,
  timeout: LLM_TIMEOUT_MS,
  maxRetries: LLM_MAX_RETRIES,
});

export const llmModel = LLM_MODEL;

// The browser may only pick a model from the server's list (config/models.json + LLM_MODEL).
// Returns null for an unknown name, so the route can answer 400.
export function resolveLlmModel(requested: string | undefined): string | null {
  if (!requested) return LLM_MODEL;
  return LLM_MODELS.includes(requested) ? requested : null;
}

// Maps OpenAI-style usage to ours. null means the provider did not report usage.
function toUsage(usage: OpenAI.CompletionUsage | null | undefined): Usage | null {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

type CallParams<T> = {
  log: LogContext;
  promptVersion: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  responseFormat?: ChatCompletionCreateParamsNonStreaming["response_format"];
  // Turns the raw completion into the value the caller wants. Throw LlmInvalidOutputError
  // when the answer is unusable, so the call is logged as invalid output.
  parse: (completion: ChatCompletion) => T;
};

// One LLM call: time it, parse it, and append one line to logs/llm-calls.jsonl whatever happens.
export async function chatCompletion<T>(
  params: CallParams<T>,
): Promise<{ value: T; usage: Usage | null; latency_ms: number }> {
  const started = performance.now();
  let usage: Usage | null = null;
  const entry = {
    route: params.log.route,
    api: "chat_completions" as const,
    prompt_version: params.promptVersion,
    strategy: params.log.strategy,
    model: params.model,
    ticket_id: params.log.ticketId,
  };

  try {
    const completion = await llm.chat.completions.create({
      model: params.model,
      messages: params.messages,
      ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
    });
    usage = toUsage(completion.usage);
    const value = params.parse(completion);
    const latency_ms = Math.round(performance.now() - started);
    await logCall({ ...entry, usage, status: 200, latency_ms, cost_usd: estimateCost(params.model, usage) });
    return { value, usage, latency_ms };
  } catch (error) {
    const { status, code } = toApiError(error);
    await logCall({
      ...entry,
      usage, // tokens were still spent when the answer was invalid
      status,
      code,
      latency_ms: Math.round(performance.now() - started),
      cost_usd: usage ? estimateCost(params.model, usage) : null,
    });
    throw error;
  }
}

// Returns the text of the first choice, or throws if the model gave nothing usable.
// finish_reason "length" means the answer was cut off: treat it as invalid, never parse half a JSON.
export function completionText(completion: ChatCompletion): string {
  const choice = completion.choices[0];
  if (choice?.finish_reason === "length") {
    throw new LlmInvalidOutputError("truncated");
  }
  const content = choice?.message?.content;
  if (!content) throw new LlmInvalidOutputError("empty answer");
  return content;
}

// Streams plain text chunks. Errors before the first chunk are thrown, so the route can
// still answer with a JSON error; errors after it end the stream with a short notice.
export async function streamCompletion(params: {
  log: LogContext;
  promptVersion: string;
  model: string;
  messages: ChatCompletionMessageParam[];
}): Promise<ReadableStream<Uint8Array>> {
  const started = performance.now();
  const entry = {
    route: params.log.route,
    api: "chat_completions" as const,
    prompt_version: params.promptVersion,
    strategy: params.log.strategy,
    model: params.model,
    ticket_id: params.log.ticketId,
  };

  let stream;
  try {
    stream = await llm.chat.completions.create({
      model: params.model,
      messages: params.messages,
      stream: true,
      stream_options: { include_usage: true },
    });
  } catch (error) {
    const { status, code } = toApiError(error);
    await logCall({ ...entry, usage: null, status, code, latency_ms: Math.round(performance.now() - started), cost_usd: null });
    throw error;
  }

  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let usage: Usage | null = null;
      let status = 200;
      let code: string | undefined;
      try {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content;
          if (text) controller.enqueue(encoder.encode(text));
          // With include_usage, the last chunk carries the usage of the whole call.
          if (chunk.usage) usage = toUsage(chunk.usage);
        }
      } catch (error) {
        ({ status, code } = toApiError(error));
        console.error("Stream failed:", error);
        controller.enqueue(encoder.encode("\n[The explanation was interrupted. Please try again.]"));
      } finally {
        await logCall({
          ...entry,
          usage,
          status,
          code,
          latency_ms: Math.round(performance.now() - started),
          cost_usd: estimateCost(params.model, usage),
        });
        controller.close();
      }
    },
    cancel() {
      stream.controller.abort();
    },
  });
}
