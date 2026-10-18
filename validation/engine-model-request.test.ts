import test from "node:test";
import assert from "node:assert/strict";
import { prepareEngineModelRequest } from "./engine-model-request.js";

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
