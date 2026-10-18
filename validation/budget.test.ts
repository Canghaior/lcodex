import test, { after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { BudgetLedger } from "./budget.js";
import { createRunDirectory } from "./run-directory.js";

const runs: ReturnType<typeof createRunDirectory>[] = [];
after(() => { for (const run of runs) run.cleanup(); });

function sample() {
  const run = createRunDirectory("budget-test");
  runs.push(run);
  const root = run.root;
  const file = path.join(root, "synthetic-ledger.jsonl");
  BudgetLedger.initialize(file);
  return { file, ledger: new BudgetLedger(file) };
}

test("reservations survive restart and unknown usage blocks subsequent requests", () => {
  const { file, ledger } = sample();
  const id = ledger.reserve("trial-1", 100_000);
  assert.throws(() => ledger.reserve("trial-2", 1), /PENDING_RECONCILIATION/);
  ledger.close();
  const recovered = new BudgetLedger(file);
  try {
    assert.equal(recovered.summary().committedMicros, 100_000);
    assert.equal(recovered.summary().pending, 1);
    assert.throws(() => recovered.reserve("trial-2", 1), /PENDING_RECONCILIATION/);
    recovered.settle(id, 12_345);
    assert.equal(recovered.summary().estimatedMicros, 12_345);
  } finally { recovered.close(); }
});

test("trial budget includes earlier requests, retries cannot reset it", () => {
  const { ledger } = sample();
  try {
    const first = ledger.reserve("trial", 700_000);
    ledger.settle(first, 600_000);
    assert.throws(() => ledger.reserve("trial", 400_001), /TRIAL_LIMIT/);
    const second = ledger.reserve("trial", 400_000);
    ledger.settle(second, 400_000);
    assert.throws(() => ledger.reserve("trial", 1), /TRIAL_LIMIT/);
  } finally { ledger.close(); }
});

test("total budget spans trials and process restarts", () => {
  const { file, ledger } = sample();
  for (let i = 0; i < 10; i++) {
    const id = ledger.reserve(`trial-${i}`, 1_000_000);
    ledger.settle(id, 1_000_000);
  }
  ledger.close();
  const recovered = new BudgetLedger(file);
  try { assert.throws(() => recovered.reserve("another", 1), /TOTAL_LIMIT/); }
  finally { recovered.close(); }
});

test("a cost above reservation is recorded and halts new requests", () => {
  const { file, ledger } = sample();
  const id = ledger.reserve("trial", 10);
  ledger.settle(id, 11);
  assert.equal(ledger.summary().estimatedMicros, 11);
  assert.throws(() => ledger.reserve("another", 10), /ESTIMATE_OVERRUN/);
  ledger.close();
  const recovered = new BudgetLedger(file);
  try { assert.equal(recovered.summary().overrun, true); }
  finally { recovered.close(); }
});

test("concurrent writers and implicit reset are refused", () => {
  const { file, ledger } = sample();
  try {
    assert.throws(() => new BudgetLedger(file), /EEXIST/);
    assert.throws(() => BudgetLedger.initialize(file), /EEXIST/);
    assert.throws(() => new BudgetLedger(`${file}.missing`), /LEDGER_MISSING/);
  } finally { ledger.close(); }
});

test("malformed or partial ledger fails closed", () => {
  const { file, ledger } = sample();
  ledger.close();
  writeFileSync(file, '{"type":"init"');
  assert.throws(() => new BudgetLedger(file), /CORRUPT/);
});

test("invalid amounts and duplicate settlement do not create free budget", () => {
  const { ledger } = sample();
  try {
    for (const invalid of [-1, 0, NaN, Infinity, 0.1]) {
      assert.throws(() => ledger.reserve("trial", invalid), /INVALID_RESERVATION/);
    }
    const id = ledger.reserve("trial", 10);
    assert.throws(() => ledger.settle(id, -1), /INVALID_SETTLEMENT/);
    ledger.settle(id, 1);
    assert.throws(() => ledger.settle(id, 0), /INVALID_SETTLEMENT/);
  } finally { ledger.close(); }
});

test("request count remains bounded even for zero billed usage", () => {
  const { ledger } = sample();
  try {
    for (let i = 0; i < 8; i++) ledger.settle(ledger.reserve("trial", 1), 0);
    assert.throws(() => ledger.reserve("trial", 1), /REQUEST_LIMIT/);
  } finally { ledger.close(); }
});
