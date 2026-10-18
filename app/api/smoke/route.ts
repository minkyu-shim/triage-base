import { formatIssues, SmokeRequest, SmokeResponse } from "../../../lib/schemas";
import { appendRun } from "../../../lib/runLog";
import { runSmokeTest } from "../../../lib/smoke";

// A run makes up to 100 LLM calls, so it can take a minute or more.
// Local dev has no limit; this tells hosting platforms to allow it.
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = SmokeRequest.safeParse(body);
  if (!input.success) {
    return Response.json(
      { error: "Invalid smoke test request.", details: formatIssues(input.error) },
      { status: 400 },
    );
  }

  try {
    // Per-ticket failures are already captured in the results; only unexpected errors reach the catch.
    const result = await runSmokeTest(input.data);

    const response = SmokeResponse.safeParse(result);
    if (!response.success) {
      console.error("Smoke response failed validation:", response.error);
      return Response.json(
        { error: "The server built an invalid smoke test response.", details: formatIssues(response.error) },
        { status: 500 },
      );
    }

    // Log the run for /admin. A logging failure should not throw away results the user already paid for.
    try {
      await appendRun(response.data.summary);
    } catch (error) {
      console.error("Could not log smoke run:", error);
    }

    return Response.json(response.data);
  } catch (error) {
    console.error("Smoke test failed:", error);
    return Response.json(
      { error: "The smoke test could not be run. Please try again." },
      { status: 500 },
    );
  }
}
