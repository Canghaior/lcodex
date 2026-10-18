import test from "node:test";
import assert from "node:assert/strict";
import { checkInvoiceSource, evaluateInvoiceSource, INVOICE_BASELINE, previewInvoicePatch } from "./patch-contract.js";
import { repairedExample } from "./fixtures.js";
import { checkResponseWire } from "./readonly-contract.js";

const patch = "*** Begin Patch\n*** Update File: invoice.mjs\n@@\n" +
  INVOICE_BASELINE.trimEnd().split("\n").map((line) => "-" + line).join("\n") + "\n" +
  repairedExample.trimEnd().split("\n").map((line) => "+" + line).join("\n") + "\n*** End Patch";

test("independent arithmetic checks preserve failing baseline and verify applied candidate", () => {
  assert.equal(evaluateInvoiceSource(INVOICE_BASELINE).filter((check) => check.passed).length, 2);
  assert.equal(previewInvoicePatch(patch), repairedExample);
  assert.equal(evaluateInvoiceSource(repairedExample).every((check) => check.passed), true);
});

test("patch contract excludes other paths, additional hunks and arbitrary program constructs", () => {
  for (const invalid of [
    patch.replace("invoice.mjs", "../outside.mjs"),
    patch.replace("invoice.mjs", ".env"),
    patch.replace("*** End Patch", "*** Add File: other.txt\n+x\n*** End Patch"),
    patch.replace("+export function applyDiscount", "@@\n+export function applyDiscount"),
    patch.replace("item.priceCents * item.quantity", "process.exit()"),
    patch.replace("Math.round(cents", "Math.round.constructor(cents"),
  ]) assert.throws(() => previewInvoicePatch(invalid), /PATCH_CONTRACT_REFUSED/);
  for (const source of [
    "import fs from 'node:fs';\n" + repairedExample,
    repairedExample.replace("item.priceCents * item.quantity", "item.constructor()"),
    repairedExample.replace("sum +", "sum++ +"),
  ]) assert.throws(() => checkInvoiceSource(source), /PATCH_CONTRACT_REFUSED/);
});

test("custom patch stream is checked across additions, deltas and completion", () => {
  const call = { type: "custom_tool_call", id: "p1", call_id: "c1", name: "apply_patch", input: patch };
  const response = { status: "completed", output: [call] };
  const events = [
    { type: "response.output_item.added", item: { ...call, input: "" } },
    { type: "response.custom_tool_call_input.delta", item_id: "p1", delta: patch },
    { type: "response.custom_tool_call_input.done", item_id: "p1", input: patch },
    { type: "response.output_item.done", item: call },
    { type: "response.completed", response },
  ];
  const encode = (values: unknown[]) => values.map((event, sequence_number) => "data: " + JSON.stringify({ ...(event as object), sequence_number }) + "\n\n").join("");
  assert.equal(checkResponseWire(encode(events), response, undefined, previewInvoicePatch)?.name, "apply_patch");
  assert.throws(() => checkResponseWire(encode(events), response), /CONTRACT_REFUSED/);
  events[1] = { type: "response.custom_tool_call_input.delta", item_id: "p1", delta: patch.replace("invoice.mjs", ".env") };
  assert.throws(() => checkResponseWire(encode(events), response, undefined, previewInvoicePatch), /CONTRACT_REFUSED/);
});
