import { formatIssues, TriageRequest, TriageResponse } from "../../../lib/schemas";
import { triageTicket, TriageOutputError } from "../../../lib/triage";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // 1. Validate the request before spending an LLM call on it.
  const input = TriageRequest.safeParse(body);
  if (!input.success) {
    return Response.json(
      { error: "Invalid ticket.", details: formatIssues(input.error) },
      { status: 400 },
    );
  }

  try {
    // 2. triageTicket() already validated the model output against TriageResult.
    const result = await triageTicket(input.data);

    // 3. Validate the full response shape before it reaches the user.
    const response = TriageResponse.safeParse(result);
    if (!response.success) {
      console.error("Triage response failed validation:", response.error);
      return Response.json(
        { error: "The server built an invalid triage response.", details: formatIssues(response.error) },
        { status: 500 },
      );
    }

    return Response.json(response.data);
  } catch (error) {
    if (error instanceof TriageOutputError) {
      console.error("Invalid model output:", error.message, error.details);
      return Response.json(
        { error: `Model returned an invalid triage: ${error.message}`, details: error.details },
        { status: 502 },
      );
    }
    console.error("LLM call failed:", error);
    return Response.json(
      { error: "The triage assistant is unavailable. Please try again." },
      { status: 502 },
    );
  }
}
