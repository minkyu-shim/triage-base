import { badRequest, failure, readJson } from "../../../../lib/errors";
import { resolveLlmModel } from "../../../../lib/llm";
import { formatIssues, TriageRequest, TriageV1Response } from "../../../../lib/schemas";
import { triageTicketV1 } from "../../../../lib/triage";

// triage-v1: the same ticket validation as v2, but the model answers in plain text.
export async function POST(request: Request) {
  const body = await readJson(request);
  if (body === undefined) return badRequest("Invalid JSON body.");

  const input = TriageRequest.safeParse(body);
  if (!input.success) {
    return badRequest("Invalid ticket.", formatIssues(input.error));
  }
  const model = resolveLlmModel(input.data.model);
  if (!model) return badRequest("Unknown model.");

  try {
    const result = await triageTicketV1(input.data, model, { route: "/api/triage/v1" });
    return Response.json(TriageV1Response.parse(result));
  } catch (error) {
    return failure("Triage v1 failed", error);
  }
}
