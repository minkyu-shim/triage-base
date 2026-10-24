import { DM, LLM_MODEL, LLM_MODELS } from "../../../lib/config";
import type { ModelsResponse } from "../../../lib/schemas";

// Model names for the menus. Names only: keys and URLs stay on the server.
export function GET() {
  const body: ModelsResponse = { llm: LLM_MODELS, default_llm: LLM_MODEL, dm: DM?.model ?? null };
  return Response.json(body);
}
