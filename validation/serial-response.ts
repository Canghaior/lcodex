import { isDeepStrictEqual } from "node:util";
import { checkResponseWire } from "./readonly-contract.js";
import { ResponsesStream } from "./responses-stream.js";
import { isObject } from "./rpc.js";

export const MAX_BATCH_TOOLS = 4;
export type BatchCall = { id: string; callId: string; type: "function_call" | "custom_tool_call"; name: string };
type Policy = { patch: (input: string) => void; functionCall: (name: string, args: Record<string, unknown>) => void };
function requireValue(value: unknown): asserts value { if (!value) throw new Error("BATCH_RESPONSE_REFUSED"); }
function frame(event: Record<string, unknown>, sequence: number) {
  return `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`;
}
async function interruptible(action: () => Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true }); });
  try { await Promise.race([action(), stopped]); } finally { signal.removeEventListener("abort", cancel); }
}

// DeepSeek emits raw reasoning as content parts, not reasoning summaries.
// Preserve it for subsequent requests, but verify every part against the final
// item before releasing any tool. This content never grants execution rights.
function checkReasoning(item: Record<string, unknown>, events: Record<string, unknown>[]) {
  const relevant = events.filter(event => String(event.type).startsWith("response.reasoning_text.") || String(event.type).startsWith("response.content_part."));
  if (!relevant.length && item.content === undefined) return;
  requireValue(Array.isArray(item.content) && item.content.length <= 128);
  const parts = item.content.map(part => {
    requireValue(isObject(part) && part.type === "reasoning_text" && typeof part.text === "string");
    return { expected: part, added: false, text: "", textDone: false, done: false };
  });
  for (const event of relevant) {
    requireValue(Number.isSafeInteger(event.content_index));
    const part = parts[Number(event.content_index)];
    requireValue(part && !part.done);
    switch (event.type) {
      case "response.content_part.added":
        requireValue(!part.added && isObject(event.part) && event.part.type === "reasoning_text" && event.part.text === "");
        part.added = true; break;
      case "response.reasoning_text.delta":
        requireValue(part.added && !part.textDone && typeof event.delta === "string");
        part.text += event.delta; break;
      case "response.reasoning_text.done":
        requireValue(part.added && !part.textDone && event.text === part.expected.text && part.text === part.expected.text);
        part.textDone = true; break;
      case "response.content_part.done":
        requireValue(part.textDone && isDeepStrictEqual(event.part, part.expected)); part.done = true; break;
      default: requireValue(false);
    }
  }
  requireValue(parts.every(part => part.added && part.textDone && part.done));
}

// Validate the entire upstream response before releasing even its first tool.
// Group interleaved item events without changing item IDs, call IDs or arguments.
// The engine still owns execution and reports the actual completion; the gateway
// merely withholds the next tool's events until that report has been reconciled.
export function prepareSerialResponse(wire: string, response: Record<string, unknown>, policy: Policy) {
  requireValue(response.status === "completed" && Array.isArray(response.output) && response.output.length <= 128);
  const output = response.output;
  const ids = new Set<string>(), callIds = new Set<string>();
  const groups = output.map((item, index) => {
    requireValue(isObject(item) && ["message", "reasoning", "function_call", "custom_tool_call"].includes(String(item.type)));
    requireValue(typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && !ids.has(item.id));
    ids.add(item.id);
    let call: BatchCall | undefined;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      requireValue(typeof item.call_id === "string" && item.call_id.length > 0 && item.call_id.length <= 256 && !callIds.has(item.call_id));
      requireValue(typeof item.name === "string");
      callIds.add(item.call_id);
      call = { id: item.id, callId: item.call_id, type: item.type, name: item.name };
    }
    return { item, index, call, events: [] as Record<string, unknown>[], added: false, done: false };
  });
  requireValue(callIds.size <= MAX_BATCH_TOOLS);
  const initial: Record<string, unknown>[] = [];
  let terminal: Record<string, unknown> | undefined;
  const parser = new ResponsesStream(event => {
    const type = String(event.type);
    if (type === "response.created" || type === "response.in_progress") {
      requireValue(!groups.some(group => group.added) && isObject(event.response));
      requireValue(event.response.output === undefined || Array.isArray(event.response.output) && event.response.output.length === 0);
      initial.push(event); return;
    }
    if (type === "response.completed") { requireValue(isDeepStrictEqual(event.response, response)); terminal = event; return; }
    requireValue(Number.isSafeInteger(event.output_index));
    const group = groups[Number(event.output_index)]; requireValue(group && !group.done);
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      requireValue(isObject(event.item) && event.item.id === group.item.id && event.item.type === group.item.type);
      if (type.endsWith(".added")) { requireValue(!group.added); group.added = true; }
      else { requireValue(group.added && isDeepStrictEqual(event.item, group.item)); group.done = true; }
    } else {
      requireValue(group.added && event.item_id === group.item.id);
      if (type.startsWith("response.function_call_arguments.")) requireValue(group.item.type === "function_call");
      else if (type.startsWith("response.custom_tool_call_input.")) requireValue(group.item.type === "custom_tool_call");
      else if (type.startsWith("response.reasoning_summary_")) requireValue(group.item.type === "reasoning");
      else if (type.startsWith("response.reasoning_text.")) requireValue(group.item.type === "reasoning");
      else if (type.startsWith("response.content_part.")) requireValue(group.item.type === "message" || group.item.type === "reasoning");
      else if (type.startsWith("response.output_text.")) requireValue(group.item.type === "message");
      else requireValue(false);
    }
    group.events.push(event);
  });
  parser.push(wire); parser.finish();
  requireValue(terminal && groups.every(group => group.added && group.done));
  // Reuse the strict single-call payload/delta checker for every item. An unsafe
  // later call prevents the whole response from being exposed to the engine.
  for (const group of groups) {
    if (group.item.type === "reasoning") checkReasoning(group.item, group.events);
    const projected = { ...response, output: [group.item] };
    const events = [...group.events.map(event => ({ ...event, output_index: 0 })), { type: "response.completed", response: projected }];
    checkResponseWire(events.map(frame).join(""), projected, undefined, policy.patch, policy.functionCall);
  }
  // Own the validated bytes; subsequent caller mutations cannot change delivery.
  const frozen = structuredClone({ initial, groups, terminal });
  const calls = frozen.groups.flatMap(group => group.call ? [group.call] : []);
  let used = false;
  return {
    calls: structuredClone(calls),
    async deliver(options: {
      write: (bytes: string) => void | Promise<void>;
      beforeTool: (call: BatchCall) => void | Promise<void>;
      afterTool: (call: BatchCall) => Promise<void>;
      signal: AbortSignal;
    }) {
      requireValue(!used); used = true;
      let sequence = 0;
      const emit = async (event: Record<string, unknown>) => { options.signal.throwIfAborted(); await options.write(frame(event, sequence++)); };
      for (const event of frozen.initial) await emit(event);
      for (const group of frozen.groups) {
        options.signal.throwIfAborted();
        if (group.call) await options.beforeTool(structuredClone(group.call));
        for (const event of group.events) await emit(event);
        if (group.call) await interruptible(() => options.afterTool(structuredClone(group.call!)), options.signal);
      }
      await emit(frozen.terminal!);
    },
  };
}
