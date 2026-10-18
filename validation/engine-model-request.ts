import { MAX_OUTPUT_TOKENS } from "./deepseek-request.js";
import { mapDeepSeekRoles } from "./deepseek-roles.js";

// Deliberately omit engine-only metadata/cache identifiers and unreviewed fields.
export function prepareEngineModelRequest(request: Record<string, unknown>, tools: Record<string, unknown>[]) {
  if (request.previous_response_id || request.conversation || request.background) throw new Error("API_UNSUPPORTED_ENGINE_STATE");
  if (request.instructions !== undefined && typeof request.instructions !== "string") throw new Error("API_ENGINE_INSTRUCTIONS_INVALID");
  return mapDeepSeekRoles({
    model: request.model, input: request.input, tools, tool_choice: tools.length ? "auto" : "none",
    stream: true, store: false, max_output_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort: "none" }, parallel_tool_calls: false,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
  });
}
