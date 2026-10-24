import { DM } from "../../../lib/config";
import { badRequest, DmNotConfiguredError, failure, readJson } from "../../../lib/errors";
import { resolveLlmModel } from "../../../lib/llm";
import { appendRun, writeRunFile } from "../../../lib/runLog";
import { formatIssues, SmokeRequest, SmokeResponse } from "../../../lib/schemas";
import { runSmokeTest } from "../../../lib/smoke";

// A run makes up to 100 LLM calls, so it can take a minute or more.
// Local dev has no limit; this tells hosting platforms to allow it.
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body === undefined) return badRequest("Invalid JSON body.");

  const input = SmokeRequest.safeParse(body);
  if (!input.success) {
    return badRequest("Invalid smoke test request.", formatIssues(input.error));
  }

  const model = resolveLlmModel(input.data.model);
  if (!model) return badRequest("Unknown model.");
  // Fail once here instead of once per ticket.
  if (input.data.strategy !== "llm" && !DM) {
    return failure("Smoke test", new DmNotConfiguredError());
  }

  try {
    // Per-ticket failures are already captured in the results; only unexpected errors reach the catch.
    const result = await runSmokeTest(input.data, model);

    const response = SmokeResponse.safeParse(result);
    if (!response.success) {
      console.error("Smoke response failed validation:", response.error);
      return Response.json(
        { error: "The server built an invalid smoke test response.", code: "internal_error" },
        { status: 500 },
      );
    }

    // Save the run for /admin and as a run file. A logging failure should not throw away
    // results the user already paid for.
    const run = response.data;
    try {
      run.summary.run_file = await writeRunFile(run);
    } catch (error) {
      console.error("Could not write run file:", error);
    }
    try {
      await appendRun(run.summary);
    } catch (error) {
      console.error("Could not log smoke run:", error);
    }

    return Response.json(run);
  } catch (error) {
    return failure("Smoke test failed", error);
  }
}
