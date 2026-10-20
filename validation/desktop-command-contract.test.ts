import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { desktopCommandContract, desktopCommandHistory } from "./desktop-command-contract.js";
import { ResponsesStream } from "./responses-stream.js";
import { assertFinalAnswer, SessionProgress } from "./session-progress.js";

const options = { workspace: path.resolve(".local/test-project"), shell: "pinned-shell", rootMarker: ".lcodex-root", readOnlyAssets: [], readOnly: false };
function sample(args: Record<string, unknown> = { cmd: "Get-Content 'source.txt'" }) {
  const item = { id: "item1", type: "function_call", call_id: "call1", name: "exec_command", status: "completed", arguments: JSON.stringify(args) };
  const response = { id: "r1", status: "completed", output: [item] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments.slice(0, 7) },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments.slice(7) },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  const wire = () => events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
  return { response, events, wire };
}

test("cmd-only model calls execute with host-owned parameters and retain exact identities and command text", async () => {
  const contract = desktopCommandContract(options), data = sample();
  const { batch } = contract.response(data.wire(), data.response), chunks: string[] = [];
  const ids: string[] = [];
  await batch.deliver({ write: bytes => { chunks.push(bytes); }, beforeTool: call => { ids.push(call.callId); }, afterTool: async () => {}, signal: new AbortController().signal });
  const parser = new ResponsesStream(); parser.push(chunks.join(""));
  const item = (parser.finish().response.output as { id: string; call_id: string; arguments: string }[])[0]!;
  assert.equal(item.id, "item1"); assert.equal(item.call_id, "call1"); assert.deepEqual(ids, ["call1"]);
  assert.deepEqual(JSON.parse(item.arguments), { cmd: "Get-Content 'source.txt'", shell: options.shell, login: false,
    workdir: options.workspace, yield_time_ms: 30000, max_output_tokens: 4096 });
  assert.deepEqual(desktopCommandHistory([item, { type: "function_call_output", call_id: "call1", output: "actual" }]),
    [data.response.output[0], { type: "function_call_output", call_id: "call1", output: "actual" }].map((v, i) => i === 0 ? { ...item, arguments: data.response.output[0]!.arguments } : v));
});

test("invalid arguments and inconsistent deltas are rejected before any adaptation", () => {
  const contract = desktopCommandContract(options);
  for (const args of [{ cmd: "x", shell: "attacker" }, { cmd: "x", max_output_tokens: 10000 }, { cmd: "x", workdir: "../outside" }, { cmd: "x", sandbox_permissions: "require_escalated" }, { cmd: "a\0b" }, { cmd: 1 }]) {
    const data = sample(args); assert.throws(() => contract.response(data.wire(), data.response), /REFUSED/);
  }
  const data = sample(); data.events[1]!.delta = "different";
  assert.throws(() => contract.response(data.wire(), data.response), /REFUSED/);
});

test("reserved verification exposes only the exact configured command and rejects alternatives", () => {
  const contract = desktopCommandContract({ ...options, verifyCommand: "npm.cmd test; exit $LASTEXITCODE" });
  const tools = contract.tools([{ type: "function", name: "exec_command" }, { type: "custom", name: "apply_patch" }]);
  assert.equal(tools.length, 1);
  const data = sample({ cmd: "npm.cmd test; exit $LASTEXITCODE" }); contract.response(data.wire(), data.response);
  const other = sample({ cmd: "npm.cmd test; Set-Content x forged" });
  assert.throws(() => contract.response(other.wire(), other.response), /TASK_VERIFICATION_REQUIRED/);
});

test("verification planning uses observed completions, invalidates after tools and never upgrades claims", () => {
  const progress = new SessionProgress("test", true);
  assert.equal(progress.verificationOnly(6), false); assert.equal(progress.verificationOnly(7), true);
  progress.plan("a", "test"); progress.started(); progress.completed({ id: "a", type: "commandExecution", exitCode: 1 });
  assert.equal(progress.verificationOnly(7), true);
  assert.match(progress.instruction(6), /Last actual verification exit code: 1/);
  progress.plan("b", "test"); progress.started(); progress.completed({ id: "b", type: "commandExecution", exitCode: 0 });
  assert.equal(progress.verificationOnly(7), false);
  // Even a completion without an observed start cannot retain an older pass.
  progress.completed({ id: "c", type: "fileChange", exitCode: null });
  assert.equal(progress.verificationOnly(7), true);
  assert.equal(progress.verificationOnly(8), false);
  assert.equal(new SessionProgress("test", false).verificationOnly(7), false);
  assert.equal(new SessionProgress("", true).verificationOnly(7), false);
});

test("a final DSML tool block is not treated as an answer or executed", () => {
  assert.throws(() => assertFinalAnswer([{ type: "message", content: [{ type: "output_text", text: "<｜｜DSML｜｜tool_calls>\nunsafe" }] }]), /TASK_FINAL_ANSWER_INVALID/);
  assertFinalAnswer([{ type: "message", content: [{ type: "output_text", text: "Tests have not run. The task remains unverified." }] }]);
});
