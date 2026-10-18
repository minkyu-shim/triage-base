import { llm, llmModel } from "../../../lib/llm"

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("message" in body) ||
    typeof body.message !== "string" ||
    !body.message.trim()
  ) {
    return Response.json(
      { error: "Please provide a non-empty message string." },
      { status: 400 },
    );
  }

  try {
    const completion = await llm.chat.completions.create({
      model: llmModel,
      messages: [
        {
          role: "system",
          content: "You are a helpful support assistant. Answer briefly.",
        },
        { role: "user", content: body.message },
      ],
    });

    const answer = completion.choices[0]?.message?.content;
    if (!answer) {
      return Response.json(
        { error: "The model returned no answer." },
        { status: 502 },
      );
    }

    return Response.json({ answer });
  } catch (error) {
    console.error("LLM call failed:", error);
    return Response.json(
      { error: "The assistant is unavailable. Please try again." },
      { status: 502 },
    );
  }
}
