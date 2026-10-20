import assert from "node:assert/strict";
import test from "node:test";
import { prepareSerialResponse } from "./serial-response.js";
import { ResponsesStream } from "./responses-stream.js";

const policy = {
  functionCall(name: string, args: Record<string, unknown>) { assert.equal(name, "exec_command"); assert.equal(args.cmd, "bounded"); },
  patch(input: string) { assert.equal(input, "bounded patch"); },
};
const first = { id: "item-one", type: "function_call", name: "exec_command", call_id: "one", arguments: '{"cmd":"bounded"}', status: "completed" };
const second = { id: "item-two", type: "custom_tool_call", name: "apply_patch", call_id: "two", input: "bounded patch", status: "completed" };

test("thinking content is preserved and mismatched reasoning cannot release a following tool", async () => {
  const part = { type: "reasoning_text", text: "Synthetic reasoning for an offline test." };
  const reasoning = { type: "reasoning", id: "reason1", status: "completed", summary: [], content: [part], encrypted_content: null };
  const response = { status: "completed", output: [reasoning, first] };
  const events: Record<string, unknown>[] = [
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, content: [], status: "in_progress" } },
    { type: "response.content_part.added", output_index: 0, item_id: reasoning.id, content_index: 0, part: { ...part, text: "" } },
    { type: "response.reasoning_text.delta", output_index: 0, item_id: reasoning.id, content_index: 0, delta: part.text },
    { type: "response.reasoning_text.done", output_index: 0, item_id: reasoning.id, content_index: 0, text: part.text },
    { type: "response.content_part.done", output_index: 0, item_id: reasoning.id, content_index: 0, part },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: first },
    { type: "response.output_item.done", output_index: 1, item: first },
    { type: "response.completed", response },
  ];
  const wire = (items: unknown[]) => items.map((event, sequence_number) => "data: " + JSON.stringify({ ...(event as object), sequence_number }) + "\n\n").join("");
  const prepared = prepareSerialResponse(wire(events), response, policy);
  const chunks: string[] = [];
  await prepared.deliver({ write: chunk => { chunks.push(chunk); }, beforeTool: () => {}, afterTool: async () => {}, signal: new AbortController().signal });
  const parser = new ResponsesStream(); parser.push(chunks.join(""));
  assert.deepEqual(parser.finish().response.output, response.output);
  for (const change of [{ delta: "forged" }, { item_id: first.id }, { content_index: 1 }, { type: "response.output_text.delta" }]) {
    const corrupted = structuredClone(events); corrupted[2] = { ...corrupted[2]!, ...change };
    assert.throws(() => prepareSerialResponse(wire(corrupted), response, policy), /BATCH_RESPONSE_REFUSED/);
  }
});
function sample(items: Record<string, unknown>[] = [first, second]) {
  const response = { id: "response-one", status: "completed", output: structuredClone(items) };
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
  // Deliberately interleave tools. The gateway must regroup without losing IDs.
  for (const [output_index, item] of response.output.entries()) events.push({ type: "response.output_item.added", output_index, item: { ...item, [item.type === "function_call" ? "arguments" : "input"]: "" } });
  for (const [output_index, item] of response.output.entries()) {
    const custom = item.type === "custom_tool_call", key = custom ? "input" : "arguments", prefix = custom ? "response.custom_tool_call_input" : "response.function_call_arguments";
    events.push({ type: prefix + ".delta", item_id: item.id, output_index, delta: item[key] },
      { type: prefix + ".done", item_id: item.id, output_index, [key]: item[key] },
      { type: "response.output_item.done", output_index, item });
  }
  events.push({ type: "response.completed", response });
  return { response, events, wire: () => events.map((event, sequence_number) => "data: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join("") };
}

test("a validated mixed batch releases only one tool until actual completion is reported", async () => {
  const data = sample(), prepared = prepareSerialResponse(data.wire(), data.response, policy);
  let resolveFirst!: () => void, announceFirst!: () => void;
  const firstFinished = new Promise<void>(resolve => { resolveFirst = resolve; });
  const firstReleased = new Promise<void>(resolve => { announceFirst = resolve; });
  const dispatched: string[] = [], chunks: string[] = [];
  const delivery = prepared.deliver({ write: chunk => { chunks.push(chunk); }, signal: new AbortController().signal,
    beforeTool: call => { dispatched.push(call.callId); }, afterTool: async call => { if (call.callId === "one") { announceFirst(); await firstFinished; } } });
  await firstReleased;
  assert.deepEqual(dispatched, ["one"]);
  assert.ok(!chunks.join("").includes('"id":"item-two"'));
  // A renderer/caller cannot change the frozen batch after validation.
  data.response.output[1]!.input = "changed later"; prepared.calls[1]!.callId = "forged";
  resolveFirst(); await delivery;
  assert.deepEqual(dispatched, ["one", "two"]);
  const parser = new ResponsesStream(); parser.push(chunks.join(""));
  const output = parser.finish().response.output as Record<string, unknown>[];
  assert.equal(output[1]!.input, "bounded patch");
  await assert.rejects(prepared.deliver({ write: () => {}, beforeTool: () => {}, afterTool: async () => {}, signal: new AbortController().signal }), /BATCH_RESPONSE_REFUSED/);
});

test("a malformed or unsafe later call rejects the whole batch before delivery", () => {
  for (const change of ["unsafe", "duplicate-call", "duplicate-item", "wrong-index", "hidden-tool", "delta", "too-many", "missing-done"]) {
    const data = sample(change === "too-many" ? Array.from({ length: 5 }, (_, i) => ({ ...first, id: `item-${i}`, call_id: `call-${i}` })) : undefined);
    if (change === "unsafe") data.response.output[1]!.input = "out of scope";
    if (change === "duplicate-call") data.response.output[1]!.call_id = "one";
    if (change === "duplicate-item") data.response.output[1]!.id = "item-one";
    if (change === "wrong-index") data.events[3]!.output_index = 1;
    if (change === "hidden-tool") data.events.splice(1, 0, { type: "response.output_item.added", output_index: 9, item: first });
    if (change === "delta") data.events[3]!.delta = "altered";
    if (change === "missing-done") data.events.splice(5, 1);
    assert.throws(() => prepareSerialResponse(data.wire(), data.response, policy), error => error instanceof Error, change);
  }
});

test("stop while waiting for a tool never releases queued tools or a completed response", async () => {
  const data = sample(), prepared = prepareSerialResponse(data.wire(), data.response, policy), abort = new AbortController();
  const dispatched: string[] = [], chunks: string[] = [];
  const delivery = prepared.deliver({ write: chunk => { chunks.push(chunk); }, beforeTool: call => { dispatched.push(call.callId); },
    afterTool: () => { queueMicrotask(() => abort.abort(new Error("TASK_STOPPED"))); return new Promise<void>(() => {}); }, signal: abort.signal });
  await assert.rejects(delivery, /TASK_STOPPED/);
  assert.deepEqual(dispatched, ["one"]);
  assert.ok(!chunks.join("").includes("response.completed"));
});
