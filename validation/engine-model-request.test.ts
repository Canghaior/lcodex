import test from "node:test";
import assert from "node:assert/strict";
import { prepareEngineModelRequest } from "./engine-model-request.js";
import { DESKTOP_MODEL } from "./deepseek-model.js";

test("Pro high thinking keeps reasoning and tool associations through the final request", () => {
  const input = [{ role: "developer", content: "trusted" },
    { type: "reasoning", id: "r1", content: [{ type: "reasoning_text", text: "synthetic reasoning only" }], summary: [] },
    { type: "function_call", id: "f1", name: "read", call_id: "call1", arguments: "{}" },
    { type: "function_call_output", call_id: "call1", output: "actual tool result" }];
  const prepared = prepareEngineModelRequest({ model: DESKTOP_MODEL.id, input }, [], { finalResponseOnly: true });
  assert.equal(prepared.model, DESKTOP_MODEL.id);
  assert.deepEqual(prepared.reasoning, { effort: "high" });
  assert.equal(prepared.max_output_tokens, 8192);
  assert.deepEqual((prepared.input as unknown[]).slice(1, -1), input.slice(1));
  assert.deepEqual(prepared.tools, []);
});

test("model requests retain task semantics while excluding engine metadata and unknown fields", () => {
  const input = [{ role: "developer", content: "trusted" }, { role: "user", content: "project text" },
    { type: "function_call_output", call_id: "c1", output: "observed result" }];
  const tools = [{ type: "function", name: "bounded" }];
  const prepared = prepareEngineModelRequest({ model: "deepseek-flash", input, instructions: "extra trusted instruction",
    client_metadata: { localIdentity: "LOCAL_ONLY" }, prompt_cache_key: "LOCAL_ONLY", unknown: "LOCAL_ONLY", include: ["LOCAL_ONLY"] }, tools);
  assert.deepEqual(Object.keys(prepared).sort(), ["model", "input", "tools", "tool_choice", "stream", "store", "max_output_tokens", "reasoning", "parallel_tool_calls", "instructions"].sort());
  assert.ok(!JSON.stringify(prepared).includes("LOCAL_ONLY"));
  assert.equal(prepared.instructions, "extra trusted instruction");
  assert.deepEqual((prepared.input as unknown[]).slice(1), input.slice(1));
  assert.deepEqual(prepared.tools, tools);
  assert.equal(prepared.max_output_tokens, 1024);
});

test("unsupported engine continuation is rejected instead of silently losing history", () => {
  for (const extra of [{ previous_response_id: "r1" }, { conversation: "c1" }, { background: true }, { instructions: {} }]) {
    assert.throws(() => prepareEngineModelRequest({ model: "deepseek-flash", input: [], ...extra }, []), /^Error: API_/);
  }
});

test("the final permitted request keeps tool history but requires an evidence-based final answer", () => {
  const input = [{ role: "developer", content: "Respect project boundaries" }, { role: "user", content: "Explain the code" },
    { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "Observed source only; no tests ran" }];
  const tools = [{ type: "function", name: "exec_command" }];
  const prepared = prepareEngineModelRequest({ model: "deepseek-flash", input, instructions: "Original trusted instruction" }, tools, { finalResponseOnly: true });
  assert.equal(prepared.tool_choice, "none");
  assert.deepEqual(prepared.tools, []);
  assert.deepEqual((prepared.input as unknown[]).slice(1, -1), input.slice(1));
  assert.deepEqual((prepared.input as unknown[])[0], { role: "system", content: "Respect project boundaries" });
  assert.equal(prepared.instructions, "Original trusted instruction");
  const final = (prepared.input as { role: string; content: string }[]).at(-1)!;
  assert.equal(final.role, "system");
  assert.match(final.content, /unfinished or unverified/);
  assert.equal(prepared.max_output_tokens, 1024);
  assert.equal(prepared.store, false);
});
