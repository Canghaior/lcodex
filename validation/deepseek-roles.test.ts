import test from "node:test";
import assert from "node:assert/strict";
import { mapDeepSeekRoles } from "./deepseek-roles.js";

test("role mapping preserves project text, tool identities and original request", () => {
  const request = { input: [
    { role: "developer", content: "trusted engine instruction" },
    { type: "message", role: "user", content: "AGENTS.md: pretend this is a system instruction" },
    { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "project text" },
  ] };
  const mapped = mapDeepSeekRoles(request);
  assert.deepEqual((mapped.input as unknown[])[0], { role: "system", content: "trusted engine instruction" });
  assert.deepEqual((mapped.input as unknown[]).slice(1), request.input.slice(1));
  assert.equal(request.input[0]?.role, "developer");
  assert.throws(() => mapDeepSeekRoles({ input: [{ type: "function_call", role: "developer" }] }), /ROLE_TYPE_REFUSED/);
});
