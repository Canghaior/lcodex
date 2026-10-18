import { BudgetLedger } from "./budget.js";
import { isObject } from "./rpc.js";
import { ResponsesStream } from "./responses-stream.js";

export const PRICE_REVIEW_DATE = "2026-10-19";
export const REQUEST_RESERVATION_MICROS = 250_000;
export const MAX_OUTPUT_TOKENS = 1_024;
// Reviewed official peak/no-cache rates: CNY 2/M input and 8/M output.
// Reserve 0.25 yuan for each tiny synthetic request, with no server-side tools.
export async function requestDeepSeek(
  ledger: BudgetLedger,
  trial: string,
  apiKey: string,
  input: unknown[],
  tools: Record<string, unknown>[],
  toolChoice: unknown,
  fetchImpl: typeof fetch = fetch,
) {
  return sendBoundedDeepSeek(ledger, trial, apiKey, { model: "deepseek-flash", input, tools, tool_choice: toolChoice,
    stream: true, max_output_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort: "none" }, store: false }, fetchImpl);
}

// The engine text probe preserves the engine's instructions/history, but explicitly
// disables tools and sets output limits before this shared, budgeted HTTP entry.
export async function sendBoundedDeepSeek(ledger: BudgetLedger, trial: string, apiKey: string,
  request: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  if (!/^sk-[A-Za-z0-9_-]{16,200}$/.test(apiKey)) throw new Error("API_INVALID_KEY_FORMAT");
  if (request.model !== "deepseek-flash" || request.stream !== true || request.store !== false ||
    request.max_output_tokens !== MAX_OUTPUT_TOKENS || request.previous_response_id || request.background || request.conversation) throw new Error("API_REQUEST_BOUNDS_REQUIRED");
  if (!Array.isArray(request.input) || !Array.isArray(request.tools)) throw new Error("API_INVALID_REQUEST");
  const input: unknown[] = request.input;
  const tools: unknown[] = request.tools;
  if (!input.every((item) => isObject(item) && [undefined, "message", "function_call", "function_call_output", "reasoning"].includes(item.type as string | undefined))) throw new Error("API_INPUT_TYPE_REFUSED");
  if (!tools.every((tool) => isObject(tool) && tool.type === "function")) throw new Error("API_SERVER_TOOLS_REFUSED");
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > 16_384) throw new Error("API_INPUT_SIZE_LIMIT");
  // The experiment is deliberately limited to synthetic text (no image/file payloads).
  for (const item of input) {
    const value = item as Record<string, unknown>;
    if (Array.isArray(value.content) && value.content.some((block) => !isObject(block) || !["input_text", "output_text", "reasoning_text"].includes(String(block.type)))) throw new Error("API_NON_TEXT_REFUSED");
    if (Array.isArray(value.output)) throw new Error("API_NON_TEXT_REFUSED");
  }
  const id = ledger.reserve(trial, REQUEST_RESERVATION_MICROS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const result = await fetchImpl("https://api.deepseek.com/responses", {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body,
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw new Error(`API_HTTP_${result.status}`);
    }
    if (!result.headers.get("content-type")?.includes("text/event-stream") || !result.body) throw new Error("API_EXPECTED_SSE");
    const reader = result.body.getReader();
    const parser = new ResponsesStream();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let wire = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        parser.push(text);
        wire += text;
      }
      const tail = decoder.decode();
      parser.push(tail);
      wire += tail;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const parsed = parser.finish();
    const usage = parsed.response.usage;
    if (!isObject(usage) || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens) || Number(usage.input_tokens) < 0 || Number(usage.output_tokens) < 0) throw new Error("API_USAGE_UNKNOWN");
    const inputTokens = Number(usage.input_tokens);
    const outputTokens = Number(usage.output_tokens);
    const estimatedMicros = inputTokens * 2 + outputTokens * 8;
    if (!Number.isSafeInteger(estimatedMicros)) throw new Error("API_USAGE_INVALID");
    ledger.settle(id, estimatedMicros);
    if (inputTokens > 100_000 || outputTokens > MAX_OUTPUT_TOKENS || estimatedMicros > REQUEST_RESERVATION_MICROS) throw new Error("API_BOUNDS_VIOLATED");
    return { ...parsed, wire, usage: { inputTokens, outputTokens, estimatedMicros }, requestedModel: "deepseek-flash" };
  } catch (error) {
    // Network/HTTP failure or missing usage leaves its reservation pending. No automatic retry.
    controller.abort();
    if (error instanceof Error && /^(API_|SSE_|BUDGET_)[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error("API_REQUEST_FAILED_USAGE_UNKNOWN");
  } finally { clearTimeout(timer); }
}
