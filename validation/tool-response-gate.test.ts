import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRunDirectory } from "./run-directory.js";
import { TaskLimits } from "./task-limits.js";
import { prepareSerialResponse } from "./serial-response.js";
import { ToolResponseGate } from "./tool-response-gate.js";

function batch(ids: string[]) {
  const items = ids.map(id => ({ id: `item-${id}`, call_id: id, type: "function_call", name: "exec_command", arguments: "{}", status: "completed" }));
  const response = { id: "sample", status: "completed", output: items };
  const events = [...items.flatMap((item, output_index) => [{ type: "response.output_item.added", item, output_index }, { type: "response.output_item.done", item, output_index }]), { type: "response.completed", response }];
  const wire = events.map((event, sequence_number) => "data: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join("");
  return prepareSerialResponse(wire, response, { patch() { throw new Error("UNEXPECTED_PATCH"); }, functionCall(name) { assert.equal(name, "exec_command"); } });
}

test("engine acknowledgements release calls once, with identity and actual exit checks", async () => {
  for (const mode of ["passed", "wrong-id", "unknown-exit", "failure-limit"]) {
    const run = createRunDirectory("response gate"), file = path.join(run.root, "limits.jsonl"); TaskLimits.create(file);
    const limits = new TaskLimits(file), abort = new AbortController(); limits.request();
    const released: string[] = [], results: string[] = [], failures: string[] = [];
    const gate = new ToolResponseGate(limits, abort, { failure: code => { failures.push(code); }, completed: result => { results.push(result.id); } });
    try {
      const delivery = gate.deliver(batch(mode === "failure-limit" ? ["one", "two", "three"] : ["one", "two"]), bytes => {
        if (!bytes.includes("response.output_item.done")) return;
        const event = JSON.parse(bytes.split("data: ")[1]!) as { item: { call_id: string } }, id = event.item.call_id; released.push(id);
        queueMicrotask(() => {
          gate.observe("item/started", { item: { id, type: "commandExecution" } });
          const completion = { item: { id: mode === "wrong-id" ? "unexpected" : id, type: "commandExecution", exitCode: mode === "unknown-exit" ? null : mode === "failure-limit" ? 1 : 0, status: "completed" } };
          gate.observe("item/completed", completion);
          if (mode === "passed") gate.observe("item/completed", completion);
        });
      });
      if (mode === "passed") { await delivery; assert.deepEqual(results, ["one", "two"]); assert.equal(limits.summary().pending, 0); }
      else {
        await assert.rejects(delivery, /TASK_(TOOL_EVENT_MISMATCH|TOOL_RESULT_UNKNOWN|FAILURE_LIMIT)/);
        assert.deepEqual(released, mode === "failure-limit" ? ["one", "two"] : ["one"]);
        if (mode !== "failure-limit") { assert.equal(limits.summary().pending, 1); assert.equal(failures.length, 1); }
      }
    } finally { gate.close(); abort.abort(); limits.close(); run.cleanup(); }
  }
});
