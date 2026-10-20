import { MAX_OUTPUT_TOKENS } from "./deepseek-request.js";
import { mapDeepSeekRoles } from "./deepseek-roles.js";

const finalInstruction = "The task has reached its final permitted model request. No tools are available now. Stop planning tool calls and answer the user in plain language using only evidence already obtained. State the request limit, actual findings, unfinished or unverified work, and a next step. Do not emit tool-call markup or invent results. Keep the answer within about 450 Chinese characters or 220 English words so it fits the output budget.";

// Deliberately omit engine-only metadata/cache identifiers and unreviewed fields.
export function prepareEngineModelRequest(request: Record<string, unknown>, tools: Record<string, unknown>[], options: { finalResponseOnly?: boolean } = {}) {
  if (request.previous_response_id || request.conversation || request.background) throw new Error("API_UNSUPPORTED_ENGINE_STATE");
  if (request.instructions !== undefined && typeof request.instructions !== "string") throw new Error("API_ENGINE_INSTRUCTIONS_INVALID");
  // DeepSeek inserts `instructions` at the beginning. Put the current boundary
  // after the historical tool results as a trusted system message, and remove
  // available tools while retaining every historical call/result and its ID.
  const input = options.finalResponseOnly && Array.isArray(request.input)
    ? [...request.input, { type: "message", role: "system", content: finalInstruction }]
    : request.input;
  return mapDeepSeekRoles({
    model: request.model, input, tools: options.finalResponseOnly ? [] : tools, tool_choice: tools.length && !options.finalResponseOnly ? "auto" : "none",
    stream: true, store: false, max_output_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort: "none" }, parallel_tool_calls: false,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
  });
}
