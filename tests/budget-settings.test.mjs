import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { BudgetLedger } from "../dist/validation/budget.js";
import { WindowsFileGuard } from "../dist/validation/windows-file-guard.js";
import { recoverBudgetLock } from "../dist/src/main/storage/budget-recovery.js";
import { Pricing, localDay, PRICE_REFERENCE } from "../dist/src/main/storage/pricing.js";

test("daily price confirmation is local, expires across days and rejects changed references", () => {
  const run = createRunDirectory("price settings");
  try {
    const pricing = new Pricing(run.root, false);
    assert.equal(pricing.status().current, false);
    pricing.confirm(); assert.equal(pricing.requireCurrent(), localDay());
    assert.equal(pricing.status("2099-01-01").current, false);
    const file = path.join(run.root, "pricing.json");
    writeFileSync(file, JSON.stringify({ reference: PRICE_REFERENCE + "changed", confirmedOn: localDay() }));
    assert.throws(() => pricing.requireCurrent(), /PRICE_REVIEW_REQUIRED/);
    assert.equal(existsSync(path.join(run.root, "usage.jsonl")), false, "Price confirmation does not create or reset a budget");
  } finally { run.cleanup(); }
});

test("explicit budget crash recovery refuses active owners and retains the full pending reservation", { timeout: 30000 }, async () => {
  const run = createRunDirectory("budget crash"), file = path.join(run.root, "usage.jsonl");
  const shell = "C:/Users/lijin/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe";
  const guard = new WindowsFileGuard(shell, run.root);
  BudgetLedger.initialize(file);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {BudgetLedger} from './dist/validation/budget.js'; const b=new BudgetLedger(process.argv[1]); b.reserve('crash',250000); console.log('reserved'); process.stdin.resume();`, file], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close"), timer = setTimeout(() => child.kill(), 20000); child.stderr.resume();
  try {
    await once(child.stdout, "data");
    const before = readFileSync(file, "utf8");
    await assert.rejects(recoverBudgetLock(file, guard), /BUDGET_LOCK_OWNER_ACTIVE/);
    child.kill(); await closed;
    assert.throws(() => new BudgetLedger(file), /EEXIST/);
    await recoverBudgetLock(file, guard);
    assert.equal(readFileSync(file, "utf8"), before);
    const ledger = new BudgetLedger(file);
    try { assert.equal(ledger.summary().pending, 1); assert.equal(ledger.summary().committedMicros, 250000); assert.throws(() => ledger.reserve("next", 1), /PENDING_RECONCILIATION/); }
    finally { ledger.close(); }
    writeFileSync(file + ".lock", "");
    await assert.rejects(recoverBudgetLock(file, guard));
    assert.equal(existsSync(file + ".lock"), true, "Legacy unowned locks are never guessed away");
  } finally { clearTimeout(timer); child.kill(); await closed; run.cleanup(); }
});
