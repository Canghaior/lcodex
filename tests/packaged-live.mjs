// Explicit, paid acceptance only. The test adds the existing shared development
// ledger around the real transport; no model responses or tool results are mocked.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron } from "playwright-core";
import { readKey } from "../dist/validation/read-key.js";
import { BudgetLedger } from "../dist/validation/budget.js";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { createWorkflowSample, createWorkflowEvaluator, psQuote } from "../dist/validation/workflow-sample.js";
import { isolatedEnvironment } from "../dist/validation/isolated-env.js";
import { snapshot } from "../dist/validation/fixtures.js";
import { stopAndCloseDesktop, waitForFreshDesktop } from "./desktop-helpers.mjs";

if (!process.argv.includes("--live")) throw new Error("LIVE_OPT_IN_REQUIRED");
const selected = process.argv.find(arg => arg.startsWith("--kind="))?.slice(7);
assert.ok(selected === undefined || ["read", "bug", "feature", "real-read"].includes(selected));
const kinds = selected ? [selected] : ["read", "bug", "feature"];
const fromRepetition = Number(process.argv.find(arg => arg.startsWith("--from-repetition="))?.slice(18) ?? "1");
assert.ok(Number.isInteger(fromRepetition) && fromRepetition >= 1 && fromRepetition <= 3);
assert.ok(fromRepetition === 1 || selected && selected !== "real-read", "Select a task kind when continuing independent repetitions");
const retryTrial = process.argv.find(arg => arg.startsWith("--retry-trial="))?.slice(14);
const authorizedTrial = process.argv.find(arg => arg.startsWith("--authorized-trial="))?.slice(19);
if (authorizedTrial) {
  assert.equal(selected, "real-read");
  assert.equal(retryTrial, undefined);
  assert.match(authorizedTrial, /^p4-real-read-1-[a-f0-9-]{36}$/);
  const ledger = new BudgetLedger(path.resolve(".local/state/p1-budget.jsonl"));
  try { assert.equal(ledger.trialLimit(authorizedTrial), 2_000_000, "Requires an already recorded, explicit one-trial authorization"); }
  finally { ledger.close(); }
}
if (retryTrial) {
  assert.equal(selected, "real-read", "A source-task retry must reuse its one existing trial");
  assert.match(retryTrial, /^p4-real-read-1-[a-f0-9-]{36}$/);
  const prior = readFileSync(".local/state/p1-budget.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(prior.some(entry => entry.type === "reserve" && entry.trial === retryTrial), "Never manufacture a retry trial");
}
const suite = randomUUID(), results = [], ledgerFile = path.resolve(".local/state/p1-budget.jsonl");
const packagedRoot = path.resolve(".local/releases/win-unpacked"), executable = path.join(packagedRoot, "lcodex.exe");
const binary = path.join(packagedRoot, "resources/runtimes/codex/bin/codex.exe"), shell = path.join(packagedRoot, "resources/runtimes/powershell/pwsh.exe");
const developmentModuleBase = pathToFileURL(path.resolve("dist/validation") + path.sep).href;
assert.ok(existsSync(executable));
const budget = () => { const ledger = new BudgetLedger(ledgerFile); try { return ledger.summary(); } finally { ledger.close(); } };
const initialBudget = budget(); assert.equal(initialBudget.pending, 0); assert.equal(initialBudget.overrun, false);
mkdirSync(".local/reports", { recursive: true });
const reportFile = path.resolve(`.local/reports/p4-live-${suite}.json`);
const save = () => writeFileSync(reportFile, JSON.stringify({ suite, realModel: true, packaged: true, initialBudget, finalBudget: budget(), results }, null, 2));
let key = await readKey();
try {
  for (const kind of kinds) for (let repetition = fromRepetition; repetition <= (kind === "real-read" ? 1 : 3); repetition++) {
    const run = createRunDirectory(`p4 live ${kind} 中文`), data = path.join(run.root, "app data"), verification = path.join(run.root, "verification");
    const project = kind === "real-read" ? path.resolve("src") : path.join(run.root, "catalog project");
    for (const directory of [data, verification, path.join(run.root, "temp"), ...["home", "profile/roaming", "profile/local/Packages", "temp"].map(name => path.join(verification, name))]) mkdirSync(directory, { recursive: true });
    let prompt = kind === "real-read"
      ? "只读检查当前 lcodex 项目 src：说明 main/engine/session.ts 怎样把 DeepSeek 请求交给 app-server，哪些执行层规则限制文件和网络，停止任务与应用文件有什么区别。给出实际文件和函数依据，以及仍存在的限制；不要改文件或运行安装命令。只读取相关文件的必要片段，避免输出整个目录或完整大型文件。"
      : createWorkflowSample(project, kind === "feature" ? "feature" : "bug");
    if (kind === "read") prompt = "只读分析 src/catalog.mjs 的 total(items)：说明单价 125 分、数量 4 时为什么得到 125 而不是 500，指出具体代码原因与正确计算规则。先实际读取代码和测试，引用文件与函数；不要修改文件，无需运行测试。";
    const before = snapshot(project), evaluator = kind === "real-read" ? null : createWorkflowEvaluator(verification, kind === "feature" ? "feature" : "bug");
    const verify = workspace => {
      writeFileSync(path.join(verification, "home/config.toml"), ['default_permissions="scoped"', '[windows]', 'sandbox="mxc"', '[permissions.scoped.filesystem]', '":minimal"="read"', `${psQuote(workspace)}="read"`, `${psQuote(path.join(workspace, ".env"))}="deny"`, `${psQuote(evaluator.file)}="read"`, `${psQuote(path.dirname(process.execPath))}="read"`, `${psQuote(path.dirname(shell))}="read"`, `${psQuote(path.dirname(process.env.COMSPEC))}="read"`, `${psQuote(path.join(verification, "profile/local/Packages"))}="write"`, '[permissions.scoped.network]', 'enabled=false', ''].join("\n"));
      return evaluator.run(binary, shell, workspace, isolatedEnvironment(verification, process.env));
    };
    const trial = authorizedTrial ?? retryTrial ?? `p4-${kind}-${repetition}-${randomUUID()}`;
    const trialLimitMicros = authorizedTrial ? 2_000_000 : 1_000_000;
    const record = { kind, repetition, trial, trialLimitMicros, retry: !!retryTrial, status: "failed", humanContextAdditions: 0, humanPatches: 0, manualTakeovers: 0, baseline: evaluator ? verify(project) : null };
    results.push(record); const started = Date.now(), budgetBefore = budget();
    console.log(`Starting ${kind} ${repetition}; shared committed ¥${(budgetBefore.committedMicros / 1e6).toFixed(6)}`);
    let app, clean = false;
    try {
      if (evaluator) { assert.equal(record.baseline.passed, 1); assert.equal(record.baseline.protocolValid, true); }
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(name.toUpperCase())));
      Object.assign(env, { PATH: path.join(process.env.SystemRoot, "System32"), TEMP: path.join(run.root, "temp"), TMP: path.join(run.root, "temp") });
      app = await _electron.launch({ executablePath: executable, args: ["--user-data-dir=" + data], env, cwd: run.root, timeout: 40000 });
      const page = await waitForFreshDesktop(app);
      // Add the non-resetting ¥10/¥1 development budget to this personal-profile
      // test. The original transport still reaches DeepSeek exactly once. Both
      // ledgers retain unknown reservations if a real request loses its result.
      await app.evaluate(async (_electron, { base, file, trial }) => {
        // Playwright's main-process evaluation context has no dynamic-import
        // callback. Load these synchronous ESM helpers through Node's require.
        const require = process.getBuiltinModule("module").createRequire(base + "p4-test.cjs");
        const { BudgetLedger } = require("./budget.js");
        const { PROJECT_MAX_INPUT_BYTES, sendBoundedDeepSeek } = require("./deepseek-request.js");
        const { DESKTOP_MODEL } = require("./deepseek-model.js");
        const direct = globalThis.fetch;
        globalThis.lcodexLiveRequestSizes = [];
        globalThis.lcodexLiveResponseMetadata = [];
        globalThis.fetch = async (url, init) => {
          if (url !== "https://api.deepseek.com/responses" || init.method !== "POST") throw new Error("LIVE_UNEXPECTED_NETWORK");
          const authorization = new Headers(init.headers).get("authorization");
          if (!authorization?.startsWith("Bearer ")) throw new Error("LIVE_AUTH_MISSING");
          const ledger = new BudgetLedger(file);
          try {
            globalThis.lcodexLiveRequestSizes.push(Buffer.byteLength(init.body));
            const request = JSON.parse(init.body);
            if (request.model !== DESKTOP_MODEL.id || request.reasoning?.effort !== DESKTOP_MODEL.effort) throw new Error("LIVE_MODEL_CONFIGURATION_MISMATCH");
            const result = await sendBoundedDeepSeek(ledger, trial, authorization.slice(7), request, direct, init.signal, PROJECT_MAX_INPUT_BYTES);
            // Retain protocol/size evidence, never request text, source excerpts,
            // tool arguments, reasoning, credentials or raw response bodies.
            const label = value => typeof value === "string" && /^[a-z_.]{1,64}$/.test(value) ? value : "other";
            globalThis.lcodexLiveResponseMetadata.push({
              requestedModel: result.requestedModel, reasoning: label(request.reasoning?.effort),
              toolChoice: label(request.tool_choice), terminal: label(result.terminalType), status: label(result.response.status),
              incompleteReason: label(result.response.incomplete_details?.reason), events: result.events,
              usage: result.usage,
              output: Array.isArray(result.response.output) ? result.response.output.map(item => ({
                type: label(item.type), status: label(item.status),
                textBytes: Array.isArray(item.content) ? item.content.reduce((size, part) => size + (typeof part.text === "string" ? Buffer.byteLength(part.text) : 0), 0) : 0,
              })) : [],
            });
            return new Response(result.wire, { headers: { "content-type": "text/event-stream" } });
          } finally { ledger.close(); }
        };
      }, { base: developmentModuleBase, file: ledgerFile, trial });
      for (const command of [{ type: "set-key", key }, { type: "configure-budget", totalMicros: trialLimitMicros, trialMicros: trialLimitMicros }, { type: "confirm-price" }]) {
        const reply = await page.evaluate(command => window.lcodex.request(command), command); assert.equal(reply.ok, true, reply.code);
      }
      await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
      await page.getByRole("button", { name: "选择项目", exact: true }).click();
      await page.getByRole("heading", { name: "一起构建 " + path.basename(project) }).waitFor();
      let reply = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
      const chatId = reply.state.activeChatId, projectId = reply.state.chats.find(chat => chat.id === chatId).projectId;
      if (["bug", "feature"].includes(kind)) {
        await page.evaluate(projectId => window.lcodex.request({ type: "set-test-command", projectId, command: "npm.cmd test; exit $LASTEXITCODE" }), projectId);
        await page.getByRole("combobox", { name: "任务方式" }).selectOption("write");
        prompt += " Run the configured test command before and after changes. Preserve existing assertions and user-notes.txt; add tests for the new feature if applicable.";
      }
      await page.getByRole("textbox", { name: "输入任务" }).fill("请用中文回答。" + prompt);
      await page.getByRole("button", { name: "发送任务", exact: true }).click();
      const deadline = Date.now() + 230000; let chat;
      do {
        reply = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
        chat = reply.state.chats.find(chat => chat.id === chatId);
        if (["ended", "failed", "stopped", "reconcile"].includes(chat.execution)) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      Object.assign(record, { execution: chat.execution, code: chat.error, verification: chat.verification, baselineExit: chat.baselineExit, tools: chat.tools.map(tool => ({ title: tool.title, status: tool.status, exitCode: tool.exitCode })), finalText: chat.messages.filter(message => message.role === "assistant").map(message => message.text).join("\n") });
      record.requestBytes = await app.evaluate(() => globalThis.lcodexLiveRequestSizes);
      record.responses = await app.evaluate(() => globalThis.lcodexLiveResponseMetadata);
      assert.deepEqual(snapshot(project), before, "Original project changed before explicit application");
      assert.equal(chat.execution, "ended", chat.error ?? "unfinished");
      const taskRoot = path.join(data, "tasks", chatId), outcome = JSON.parse(readFileSync(path.join(taskRoot, "outcome.json"), "utf8"));
      record.requests = outcome.requests; record.cleanExit = outcome.cleanExit;
      assert.equal(budget().requests - budgetBefore.requests, outcome.requests, "Each real request must be counted once in the shared development ledger");
      if (["read", "real-read"].includes(kind)) {
        assert.equal(chat.changes.length, 0); assert.equal(chat.verification, "unverified");
        assert.ok(chat.tools.some(tool => tool.status === "completed" && tool.exitCode === 0));
        if (kind === "read") {
          assert.ok(chat.tools.some(tool => tool.output.includes("unitCents") && tool.output.includes("export function total")));
          assert.match(record.finalText, /catalog\.mjs/); assert.match(record.finalText, /total/);
          assert.match(record.finalText, /quantity|数量/); assert.match(record.finalText, /unitCents|单价/);
          assert.match(record.finalText, /乘|\*/);
        } else { assert.match(record.finalText, /session\.ts/); assert.match(record.finalText, /MXC|沙箱/); }
      } else {
        assert.equal(chat.verification, "passed");
        // Test-only evidence recognition, never an execution permission rule.
        // A read followed by the configured command still yields its actual exit
        // code. The protected external verifier, not this text match, determines
        // correctness and supplies the pre-task baseline.
        const command = "npm.cmd test; exit $LASTEXITCODE";
        const checks = chat.tools.filter(tool => tool.title.endsWith(command));
        assert.ok(checks.length >= 2); assert.equal(checks[0].exitCode, kind === "bug" ? 1 : 0); assert.equal(checks.at(-1).exitCode, 0);
        assert.equal(chat.baselineExit, chat.tools.find(tool => tool.title === command)?.exitCode);
        const task = JSON.parse(readFileSync(path.join(taskRoot, "task.json"), "utf8"));
        record.candidate = verify(path.join(task.taskDirectory, "workspace")); assert.equal(record.candidate.passed, record.candidate.total); assert.equal(record.candidate.protocolValid, true);
        record.changedFiles = chat.changes.map(change => change.relative);
        assert.ok(record.changedFiles.includes("src/catalog.mjs"));
        // Regression tests are in scope for a repair too. The external verifier
        // remains protected; do not mistake useful test additions for scope drift.
        assert.ok(record.changedFiles.every(file => file === "src/catalog.mjs" || file.startsWith("test/")));
        if (kind === "feature") assert.ok(record.changedFiles.some(file => file.startsWith("test/")));
        await page.getByRole("button", { name: /^改动/ }).click(); await page.getByRole("button", { name: "应用全部", exact: true }).click();
        await page.getByText("已应用", { exact: true }).first().waitFor();
        record.applied = verify(project); assert.equal(record.applied.passed, record.applied.total); assert.equal(record.applied.protocolValid, true);
        assert.equal(readFileSync(path.join(project, "user-notes.txt"), "utf8"), "USER_EXISTING_NOTES_DO_NOT_CHANGE\n");
      }
      if (repetition === 1) await page.screenshot({ path: path.resolve(`.local/reports/p4-real-${kind}.png`) });
      assert.equal((await page.evaluate(() => window.lcodex.request({ type: "delete-key" }))).ok, true);
      record.status = "passed"; clean = true;
    } catch (error) {
      record.failure = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "ACCEPTANCE_ASSERTION_FAILED";
      throw error;
    } finally {
      await stopAndCloseDesktop(app); record.durationMs = Date.now() - started;
      const after = budget(); record.estimatedMicros = after.estimatedMicros - budgetBefore.estimatedMicros; record.requestCountDelta = after.requests - budgetBefore.requests; save();
      console.log(JSON.stringify({ kind, repetition, status: record.status, code: record.code, requests: record.requestCountDelta, estimatedYuan: record.estimatedMicros / 1e6, durationMs: record.durationMs }));
      if (clean) run.cleanup(); else console.log("Retained live fixture:", path.basename(run.root));
    }
  }
} finally { key = ""; save(); console.log("Report:", path.basename(reportFile)); }
