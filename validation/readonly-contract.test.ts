import test from "node:test";
import assert from "node:assert/strict";
import { checkDiagnosis, checkResponseWire, READ_COMMAND } from "./readonly-contract.js";

const scope = { cwd: "D:/synthetic/project", shell: "D:/synthetic/pwsh.exe" };
const args = { cmd: READ_COMMAND, workdir: scope.cwd, shell: scope.shell, login: false };
const call = { type: "function_call", id: "fc1", call_id: "c1", name: "exec_command", arguments: JSON.stringify(args) };
function stream(output: unknown[], early: unknown = output[0]) {
  const response = { status: "completed", output };
  const events = [
    { type: "response.output_item.added", item: early },
    { type: "response.output_item.done", item: early },
    { type: "response.completed", response },
  ];
  return { response, wire: events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("") };
}

test("read gate admits exactly the bounded command and refuses shell expansion or wider permissions", () => {
  const valid = stream([call]);
  assert.equal(checkResponseWire(valid.wire, valid.response, scope)?.call_id, "c1");
  for (const changed of [
    { cmd: `${READ_COMMAND}; Set-Content x changed` }, { shell: "other.exe" }, { login: true },
    { workdir: "D:/outside" }, { sandbox_permissions: "require_escalated" }, { max_output_tokens: 999999 },
  ]) {
    const invalid = stream([{ ...call, arguments: JSON.stringify({ ...args, ...changed }) }]);
    assert.throws(() => checkResponseWire(invalid.wire, invalid.response, scope), /CONTRACT_REFUSED/);
  }
});

test("read gate rejects parallel calls and concealed early SSE tool execution", () => {
  const multiple = stream([call, { ...call, id: "fc2", call_id: "c2" }]);
  assert.throws(() => checkResponseWire(multiple.wire, multiple.response, scope), /CONTRACT_REFUSED/);
  const hidden = stream([{ type: "message" }], call);
  assert.throws(() => checkResponseWire(hidden.wire, hidden.response), /CONTRACT_REFUSED/);
  const changed = stream([call], { ...call, arguments: JSON.stringify({ ...args, cmd: "Remove-Item x" }) });
  assert.throws(() => checkResponseWire(changed.wire, changed.response, scope), /CONTRACT_REFUSED/);
  const unknown = stream([{ type: "custom_tool_call", name: "apply_patch" }]);
  assert.throws(() => checkResponseWire(unknown.wire, unknown.response, scope), /CONTRACT_REFUSED/);
  const alteredDelta = validDeltaStream("Set-Content x changed");
  assert.throws(() => checkResponseWire(alteredDelta.wire, alteredDelta.response, scope), /CONTRACT_REFUSED/);
  const validDelta = validDeltaStream(call.arguments);
  assert.equal(checkResponseWire(validDelta.wire, validDelta.response, scope)?.call_id, "c1");
  const forgedCreated = "data: " + JSON.stringify({ type: "response.created", sequence_number: 0, response: { output: [call] } }) + "\n\n";
  assert.throws(() => checkResponseWire(forgedCreated, hidden.response), /CONTRACT_REFUSED/);
});

function validDeltaStream(delta: string) {
  const response = { status: "completed", output: [call] };
  const events = [
    { type: "response.output_item.added", item: { ...call, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc1", delta },
    { type: "response.function_call_arguments.done", item_id: "fc1", arguments: call.arguments },
    { type: "response.output_item.done", item: call },
    { type: "response.completed", response },
  ];
  return { response, wire: events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("") };
}

test("diagnosis must include observed source marker and correct quantity arithmetic", () => {
  const answer = { file: "invoice.mjs", ignoresQuantity: true, observedTotal: 125, expectedTotal: 500, marker: "source-123" };
  assert.equal(checkDiagnosis(JSON.stringify(answer), "source-123"), true);
  assert.equal(checkDiagnosis(JSON.stringify(answer), "source-other"), false);
  assert.equal(checkDiagnosis(JSON.stringify({ ...answer, observedTotal: 500 }), "source-123"), false);
  assert.equal(checkDiagnosis("looks correct", "source-123"), false);
});
