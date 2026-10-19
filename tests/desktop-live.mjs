// Explicit opt-in real API acceptance. Not part of npm test. Uses the existing
// development ledger and a hidden TTY input; never places credentials in argv/env.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { readKey } from "../dist/validation/read-key.js";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { createWorkflowSample, createWorkflowEvaluator } from "../dist/validation/workflow-sample.js";
import { isolatedEnvironment } from "../dist/validation/isolated-env.js";
import { snapshot } from "../dist/validation/fixtures.js";
import { BudgetLedger } from "../dist/validation/budget.js";

if (!process.argv.includes("--live")) throw new Error("LIVE_OPT_IN_REQUIRED");
let key = await readKey();
const run = createRunDirectory("desktop live 中文");
const original = path.join(run.root, "catalog project"), verification = path.join(run.root, "verification");
for (const directory of [original, verification, path.join(verification, "home"), path.join(verification, "profile/local/Packages"), path.join(verification, "temp"), path.join(run.root, "temp")]) mkdirSync(directory, { recursive: true });
const binary = path.resolve(".local/engines/codex-0.162.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const shell = path.join(process.env.USERPROFILE, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe");
const prompt = createWorkflowSample(original, "bug");
const originalBefore = snapshot(original);
const evaluator = createWorkflowEvaluator(verification, "bug"), quote = value => "'" + value.replaceAll("'", "''") + "'";
const command = "& 'C:/nvm4w/nodejs/node.exe' --preserve-symlinks --preserve-symlinks-main --test; exit $LASTEXITCODE";
function verifyConfig(workspace) {
  writeFileSync(path.join(verification, "home/config.toml"), ['default_permissions="scoped"', '[windows]', 'sandbox="mxc"', '[permissions.scoped.filesystem]', '":minimal"="read"', `${quote(workspace)}="read"`, `${quote(path.join(workspace, ".env"))}="deny"`, `${quote(evaluator.file)}="read"`, `${quote(path.dirname(process.execPath))}="read"`, `${quote(path.dirname(shell))}="read"`, `${quote(path.dirname(process.env.COMSPEC))}="read"`, `${quote(path.join(verification, "profile/local/Packages"))}="write"`, '[permissions.scoped.network]', 'enabled=false', ''].join("\n"));
}
const verificationEnv = isolatedEnvironment(verification, process.env);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(name.toUpperCase())));
Object.assign(env, { LCODEX_DESKTOP_TEST_ROOT: run.root, LCODEX_LIVE_TEST: "1", TEMP: path.join(run.root, "temp"), TMP: path.join(run.root, "temp") });
let application, clean = false, report = { realModel: true, status: "failed", humanRepairs: 0, manualTakeovers: 0 };
try {
  verifyConfig(original);
  report.baseline = evaluator.run(binary, shell, original, verificationEnv);
  assert.equal(report.baseline.passed, 1); assert.equal(report.baseline.total, 8);
  application = await _electron.launch({ executablePath: electronPath, args: ["."], cwd: path.resolve("."), env });
  const page = await application.firstWindow(); await page.getByRole("heading", { name: "从一个本地项目开始" }).waitFor();
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, original);
  await page.getByRole("button", { name: "选择项目", exact: true }).click();
  await page.getByRole("heading", { name: "一起构建 catalog project" }).waitFor();
  const saved = await page.evaluate(key => window.lcodex.request({ type: "set-key", key }), key); key = "";
  assert.equal(saved.ok, true); assert.equal(saved.state.runtime.ready, true);
  const chatId = saved.state.activeChatId, projectId = saved.state.projects[0].id;
  await page.evaluate(({ projectId, command }) => window.lcodex.request({ type: "set-test-command", projectId, command }), { projectId, command });
  await page.getByRole("combobox", { name: "任务方式" }).selectOption("write");
  await page.getByRole("textbox", { name: "输入任务" }).fill("请用中文回答。" + prompt + " 先运行配置的验证命令，记录初始结果；完成后再次运行。不要修改测试断言或用户备注。");
  await page.getByRole("button", { name: "发送任务", exact: true }).click();
  let chat;
  const deadline = Date.now() + 220_000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
    chat = result.state.chats.find(chat => chat.id === chatId);
    if (["ended", "failed", "stopped", "reconcile"].includes(chat.execution)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  report.execution = chat?.execution; report.code = chat?.error;
  report.tools = chat?.tools.map(tool => ({ status: tool.status, exitCode: tool.exitCode }));
  report.verification = chat?.verification; report.baselineExit = chat?.baselineExit;
  assert.equal(chat.execution, "ended", chat.error ?? "unfinished");
  assert.deepEqual(snapshot(original), originalBefore);
  const taskRoot = path.join(run.root, "desktop/tasks", chatId);
  const manifest = JSON.parse(readFileSync(path.join(taskRoot, "task.json"), "utf8"));
  const workspace = path.join(manifest.taskDirectory, "workspace");
  const outcome = JSON.parse(readFileSync(path.join(taskRoot, "outcome.json"), "utf8"));
  report.requests = outcome.requests; report.cleanExit = outcome.cleanExit;
  verifyConfig(workspace);
  report.candidateAcceptance = evaluator.run(binary, shell, workspace, verificationEnv);
  assert.equal(report.candidateAcceptance.passed, 8); assert.equal(report.candidateAcceptance.protocolValid, true);
  assert.ok(chat.changes.length > 0);
  report.changedFiles = chat.changes.map(change => change.relative);
  assert.deepEqual(report.changedFiles, ["src/catalog.mjs"]);
  await page.getByRole("button", { name: /^改动/ }).click();
  await page.screenshot({ path: path.resolve(".local/reports/desktop-live-review.png") });
  await page.getByRole("button", { name: "应用全部", exact: true }).click();
  await page.getByText("已应用", { exact: true }).waitFor();
  verifyConfig(original);
  report.appliedAcceptance = evaluator.run(binary, shell, original, verificationEnv);
  assert.equal(report.appliedAcceptance.passed, 8); assert.equal(report.appliedAcceptance.protocolValid, true);
  assert.equal(snapshot(original)["user-notes.txt"], originalBefore["user-notes.txt"]);
  report.status = "passed"; clean = true;
} catch (error) { report.failure = error instanceof assert.AssertionError ? "ACCEPTANCE_FAILED" : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "DESKTOP_LIVE_FAILED"; process.exitCode = 1; }
finally {
  key = "";
  if (application) await application.close();
  const ledger = new BudgetLedger(path.resolve(".local/state/p1-budget.jsonl"));
  try { report.budget = ledger.summary(); } finally { ledger.close(); }
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(`.local/reports/desktop-live-${Date.now()}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
  if (clean) run.cleanup(); else console.log("Retained generated live run:", path.basename(run.root));
}
