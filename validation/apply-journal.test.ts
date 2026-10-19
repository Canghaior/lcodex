import assert from "node:assert/strict";
import test from "node:test";
import { inspectApplyJournal } from "./apply-journal.js";
import { contentHash } from "./windows-file-guard.js";

const id = contentHash("review"), before = contentHash("before"), after = contentHash("after");
const lines = (extra: object[]) => [{ type: "created" }, { type: "sealed", reviewId: id }, ...extra].map(value => JSON.stringify(value)).join("\n") + "\n";
const intent = { type: "intent", reviewId: id, relative: "src/a.txt", before, after };

test("unknown application is reconciled against bytes and never authorized for replay", () => {
  for (const [actual, observation] of [[before, "matches-before"], [after, "matches-after"], [contentHash("partial"), "diverged"]]) {
    const found = inspectApplyJournal(lines([intent]), new Map([["src/a.txt", actual!]]));
    assert.equal(found.length, 1); assert.equal(found[0]?.observation, observation); assert.equal(found[0]?.action, "needs-reconcile");
  }
  assert.equal(inspectApplyJournal(lines([{ ...intent, before: null }]), new Map())[0]?.observation, "matches-before");
  assert.equal(inspectApplyJournal(lines([{ ...intent, after: null }]), new Map())[0]?.observation, "matches-after");
});

test("partial, reordered and repeated journal operations fail closed", () => {
  assert.throws(() => inspectApplyJournal(lines([intent]).trimEnd(), new Map()), /INCOMPLETE/);
  assert.throws(() => inspectApplyJournal(lines([intent, intent]), new Map()), /INVALID/);
  assert.throws(() => inspectApplyJournal(lines([{ type: "result", reviewId: id, relative: "src/a.txt", status: "applied" }]), new Map()), /INVALID/);
  assert.throws(() => inspectApplyJournal(lines([intent, { type: "closed" }]), new Map()), /INVALID/);
  const result = { type: "result", reviewId: id, relative: "src/a.txt", status: "needs-reconcile" };
  assert.equal(inspectApplyJournal(lines([intent, result]), new Map()).length, 1);
  assert.equal(inspectApplyJournal(lines([intent, { ...result, status: "applied" }, { type: "closed" }]), new Map()).length, 0);
});
