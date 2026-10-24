// Server only: every failure maps to one HTTP status, one code and one safe message.
// The browser never sees a stack trace, a provider message or a key.
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";

// The model answered, but the answer is unusable: truncated, not JSON, or not matching the schema.
export class LlmInvalidOutputError extends Error {
  constructor(
    message: "truncated" | "empty answer" | "not JSON" | "schema mismatch",
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "LlmInvalidOutputError";
  }
}

// The decision model call failed: an HTTP status from the provider, a timeout or a network error.
export class DmRequestError extends Error {
  constructor(readonly failure: number | "timeout" | "network") {
    super(`Decision model request failed: ${failure}`);
    this.name = "DmRequestError";
  }
}

// A dm strategy was asked for but DM_BASE_URL / DM_API_KEY / DM_MODEL are not set.
export class DmNotConfiguredError extends Error {
  constructor() {
    super("Decision model is not configured");
    this.name = "DmNotConfiguredError";
  }
}

export type ApiError = { status: number; code: string; message: string };

const INVALID_OUTPUT: ApiError = {
  status: 502,
  code: "invalid_model_output",
  message: "The model returned an invalid answer. Please try again.",
};
const RATE_LIMITED: ApiError = {
  status: 429,
  code: "rate_limited",
  message: "Too many requests to the model provider. Please wait a moment and try again.",
};
const TIMEOUT: ApiError = {
  status: 504,
  code: "triage_timeout",
  message: "The model took too long to answer. Please try again.",
};
const UNAVAILABLE: ApiError = {
  status: 502,
  code: "triage_unavailable",
  message: "The model provider is unavailable. Please try again later.",
};
const INTERNAL: ApiError = {
  status: 500,
  code: "internal_error",
  message: "Something went wrong on the server. Please contact the administrator.",
};

function fromProviderStatus(status: number | undefined): ApiError {
  if (status === 429) return RATE_LIMITED;
  if (status !== undefined && status >= 500) return UNAVAILABLE;
  // 400/401/403/404: wrong key, model name or parameter. Retrying will not help.
  return INTERNAL;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof LlmInvalidOutputError) return INVALID_OUTPUT;
  if (error instanceof DmNotConfiguredError) {
    return { ...INTERNAL, message: "The decision model is not configured on this server." };
  }
  if (error instanceof DmRequestError) {
    if (error.failure === "timeout") return TIMEOUT;
    if (error.failure === "network") return UNAVAILABLE;
    return fromProviderStatus(error.failure);
  }
  // Order matters: the timeout error is a connection error, which is an APIError.
  if (error instanceof APIConnectionTimeoutError) return TIMEOUT;
  if (error instanceof APIConnectionError) return UNAVAILABLE;
  if (error instanceof APIError) return fromProviderStatus(error.status);
  return INTERNAL;
}

// The JSON body every route sends on failure. details are only for our own validation messages.
export function errorResponse(error: ApiError, details?: string[]): Response {
  return Response.json(
    { error: error.message, code: error.code, ...(details?.length ? { details } : {}) },
    { status: error.status },
  );
}

// 400: the client sent something we refuse before any provider call.
export function badRequest(message: string, details?: string[]): Response {
  return errorResponse({ status: 400, code: "invalid_request", message }, details);
}

// Reads the request body as JSON. Returns undefined when it is not valid JSON.
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

// Logs the real error on the server and sends the safe mapped version to the browser.
export function failure(context: string, error: unknown): Response {
  console.error(`${context}:`, error);
  const details = error instanceof LlmInvalidOutputError ? error.details : undefined;
  return errorResponse(toApiError(error), details);
}
