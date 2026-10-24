import { badRequest, failure, readJson } from "../../../lib/errors";
import { chatCompletion, completionText, llmModel } from "../../../lib/llm";
import { CHAT_SYSTEM, PROMPT_VERSIONS } from "../../../lib/prompt";
import { ChatRequest, formatIssues } from "../../../lib/schemas";

// Stateless: the client sends the whole conversation every time and the server keeps nothing.
export async function POST(request: Request) {
  const body = await readJson(request);
  if (body === undefined) return badRequest("Invalid JSON body.");

  // Checked before Zod so the error says why: only the server writes the system message.
  if (
    typeof body === "object" &&
    body !== null &&
    "messages" in body &&
    Array.isArray(body.messages) &&
    body.messages.some((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "system")
  ) {
    return badRequest("System messages are not allowed.");
  }

  const input = ChatRequest.safeParse(body);
  if (!input.success) {
    return badRequest("Invalid conversation.", formatIssues(input.error));
  }

  try {
    const { value: answer } = await chatCompletion({
      log: { route: "/api/chat" },
      promptVersion: PROMPT_VERSIONS.chat,
      model: llmModel,
      messages: [{ role: "system", content: CHAT_SYSTEM }, ...input.data.messages],
      parse: completionText,
    });
    return Response.json({ answer });
  } catch (error) {
    return failure("Chat failed", error);
  }
}
