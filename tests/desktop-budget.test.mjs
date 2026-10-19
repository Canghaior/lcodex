import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { stopAndCloseDesktop } from "./desktop-helpers.mjs";

test("desktop failed request keeps its reservation until explicit full-cost accounting without retry", { timeout: 40000 }, async () => {
  const run = createRunDirectory("desktop budget"); mkdirSync(path.join(run.root, "temp"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(key.toUpperCase())));
  Object.assign(env, { LCODEX_DESKTOP_TEST_ROOT: run.root, TEMP: path.join(run.root, "temp"), TMP: path.join(run.root, "temp") });
  let app, clean = false;
  try {
    app = await _electron.launch({ executablePath: electronPath, args: ["."], cwd: path.resolve("."), env });
    const page = await app.firstWindow(); await page.getByRole("heading", { name: "从一个本地项目开始" }).waitFor();
    await app.evaluate(() => { globalThis.syntheticCalls = 0; globalThis.fetch = async () => { globalThis.syntheticCalls++; return new Response("", { status: 401 }); }; });
    await page.evaluate(() => window.lcodex.request({ type: "set-key", key: "sk-synthetic-budget-not-real-key" }));
    await page.evaluate(() => window.lcodex.request({ type: "confirm-price" }));
    const failed = await page.evaluate(() => window.lcodex.request({ type: "check-connection" }));
    assert.deepEqual(failed, { ok: false, code: "API_HTTP_401" });
    const before = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
    assert.equal(before.state.budget.pending, 1); assert.equal(before.state.budget.committed, 0.25);
    const blocked = await page.evaluate(() => window.lcodex.request({ type: "check-connection" }));
    assert.equal(blocked.code, "BUDGET_PENDING_RECONCILIATION");
    const stale = await page.evaluate(() => window.lcodex.request({ type: "account-unknown", revision: "0".repeat(64) }));
    assert.equal(stale.code, "BUDGET_RECONCILIATION_CHANGED");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("heading", { name: "开发验证预算", exact: true }).scrollIntoViewIfNeeded();
    mkdirSync(".local/reports", { recursive: true });
    await page.screenshot({ path: ".local/reports/desktop-budget.png" });
    await page.getByRole("button", { name: "按预留全额记入未知用量", exact: true }).click();
    await page.getByRole("button", { name: "按预留全额记入未知用量", exact: true }).waitFor({ state: "hidden" });
    const after = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
    assert.equal(after.state.budget.pending, 0); assert.equal(after.state.budget.unknown, 0.25); assert.equal(after.state.budget.estimated, 0); assert.equal(after.state.budget.committed, 0.25);
    assert.equal(await app.evaluate(() => globalThis.syntheticCalls), 1);
    const limits = await page.evaluate(() => window.lcodex.request({ type: "configure-budget", totalMicros: 20000000, trialMicros: 1000000 }));
    assert.equal(limits.code, "BUDGET_CONFIGURATION_REFUSED");
    const bytes = readFileSync(path.join(run.root, "test-budget.jsonl"), "utf8");
    await app.close(); app = await _electron.launch({ executablePath: electronPath, args: ["."], cwd: path.resolve("."), env });
    const again = await app.firstWindow(); await again.getByRole("heading", { name: "从一个本地项目开始" }).waitFor();
    const resumed = await again.evaluate(() => window.lcodex.request({ type: "snapshot" }));
    assert.equal(resumed.state.budget.unknown, 0.25); assert.equal(resumed.state.budget.pending, 0);
    assert.equal(readFileSync(path.join(run.root, "test-budget.jsonl"), "utf8"), bytes);
    clean = true;
  } finally { await stopAndCloseDesktop(app); if (clean) run.cleanup(); else console.log("Retained budget test:", path.basename(run.root)); }
});
