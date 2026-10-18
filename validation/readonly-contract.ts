import { isObject } from "./rpc.js";
import { ResponsesStream } from "./responses-stream.js";

export const READ_COMMAND = "Get-Content -LiteralPath './invoice.mjs' -Raw";
function requireValue(value: unknown): asserts value { if (!value) throw new Error("PROBE_RESPONSE_CONTRACT_REFUSED"); }

// Buffer and check every execution-bearing event before giving any bytes to the
// engine. Checking only response.completed would miss a conflicting earlier call.
export function checkResponseWire(wire: string, response: Record<string, unknown>, readScope?: { cwd: string; shell: string }) {
  requireValue(Array.isArray(response.output));
  const output = response.output;
  requireValue(output.every((item) => isObject(item) && ["message", "reasoning", "function_call"].includes(String(item.type))));
  const calls = output.filter(isObject).filter((item) => item.type === "function_call");
  requireValue(calls.length <= (readScope ? 1 : 0));
  const call = calls[0];
  if (call) {
    requireValue(readScope && call.name === "exec_command" && typeof call.arguments === "string" &&
      typeof call.call_id === "string" && typeof call.id === "string");
    let args: unknown;
    try { args = JSON.parse(call.arguments); } catch { throw new Error("PROBE_RESPONSE_CONTRACT_REFUSED"); }
    requireValue(isObject(args) && Object.keys(args).every((key) => ["cmd", "workdir", "shell", "login", "yield_time_ms", "max_output_tokens"].includes(key)));
    requireValue(args.cmd === READ_COMMAND && args.shell === readScope.shell && args.login === false &&
      (args.workdir === undefined || args.workdir === readScope.cwd));
    requireValue(args.yield_time_ms === undefined || (Number.isSafeInteger(args.yield_time_ms) && Number(args.yield_time_ms) > 0 && Number(args.yield_time_ms) <= 10_000));
    requireValue(args.max_output_tokens === undefined || (Number.isSafeInteger(args.max_output_tokens) && Number(args.max_output_tokens) > 0 && Number(args.max_output_tokens) <= 2048));
  }
  let added = 0, done = 0, argumentDone = 0;
  let deltas = "";
  const parser = new ResponsesStream((event) => {
    const type = String(event.type);
    if (["response.output_item.added", "response.output_item.done"].includes(type)) {
      const item = event.item;
      requireValue(isObject(item) && ["message", "reasoning", "function_call"].includes(String(item.type)));
      if (item.type === "function_call") {
        requireValue(call && item.id === call.id && item.call_id === call.call_id && item.name === call.name);
        if (type.endsWith("added")) { added++; requireValue(item.arguments === "" || item.arguments === call.arguments); }
        else { done++; requireValue(item.arguments === call.arguments); }
      }
    } else if (type.startsWith("response.function_call_arguments.")) {
      requireValue(call && event.item_id === call.id);
      if (type.endsWith(".delta")) { requireValue(typeof event.delta === "string"); deltas += event.delta; }
      else if (type.endsWith(".done")) { argumentDone++; requireValue(event.arguments === call.arguments); }
      else requireValue(false);
    } else requireValue([
      "response.created", "response.in_progress", "response.completed",
      "response.content_part.added", "response.content_part.done", "response.output_text.delta", "response.output_text.done",
      "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
    ].includes(type));
  });
  parser.push(wire);
  parser.finish();
  requireValue(call ? added === 1 && done === 1 && argumentDone <= 1 && (!deltas || deltas === call.arguments) : added === 0 && done === 0 && argumentDone === 0 && !deltas);
  return call;
}

export function checkDiagnosis(text: string, marker: string): boolean {
  try {
    const result: unknown = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return isObject(result) && result.file === "invoice.mjs" && result.ignoresQuantity === true &&
      result.observedTotal === 125 && result.expectedTotal === 500 && result.marker === marker;
  } catch { return false; }
}
