import { badRequest, failure, readJson } from "../../../lib/errors";
import { resolveLlmModel } from "../../../lib/llm";
import { formatIssues, TriageRequest, TriageResponse } from "../../../lib/schemas";
import { triageTicket } from "../../../lib/triage";

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body === undefined) return badRequest("Invalid JSON body.");

  // 1. Validate the request before spending an LLM call on it (incl. the 5,000-char cap).
  const input = TriageRequest.safeParse(body);
  if (!input.success) {
    return badRequest("Invalid ticket.", formatIssues(input.error));
  }
  const model = resolveLlmModel(input.data.model);
  if (!model) return badRequest("Unknown model.");

  try {
    // 2. triageTicket() already validated the model / DM output.
    const result = await triageTicket(input.data, {
      strategy: input.data.strategy,
      model,
      log: { route: "/api/triage" },
    });

    // 3. Validate the full response shape before it reaches the user.
    const response = TriageResponse.safeParse(result);
    if (!response.success) {
      console.error("Triage response failed validation:", response.error);
      return Response.json(
        { error: "The server built an invalid triage response.", code: "internal_error" },
        { status: 500 },
      );
    }
    return Response.json(response.data);
  } catch (error) {
    return failure("Triage failed", error);
  }
}
