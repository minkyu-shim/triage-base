import { badRequest, failure, readJson } from "../../../../lib/errors";
import { llmModel, streamCompletion } from "../../../../lib/llm";
import { buildExplainMessage, EXPLAIN_SYSTEM, PROMPT_VERSIONS } from "../../../../lib/prompt";
import { ExplainRequest, formatIssues } from "../../../../lib/schemas";

// Streams a 2–4 sentence explanation of a triage for the support agent.
// Only the explanation is streamed; the triage itself is never streamed.
export async function POST(request: Request) {
  const body = await readJson(request);
  if (body === undefined) return badRequest("Invalid JSON body.");

  const input = ExplainRequest.safeParse(body);
  if (!input.success) {
    return badRequest("Invalid explain request.", formatIssues(input.error));
  }

  try {
    // Errors before the first chunk still come back as a JSON error with the right status.
    const stream = await streamCompletion({
      log: { route: "/api/triage/explain" },
      promptVersion: PROMPT_VERSIONS.explain,
      model: llmModel,
      messages: [
        { role: "system", content: EXPLAIN_SYSTEM },
        { role: "user", content: buildExplainMessage(input.data.ticket, input.data.triage) },
      ],
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure("Explain failed", error);
  }
}
