import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { createProcessTreeFixture, waitForProcessTree, verifyTreeStopped } from "../dist/validation/workflow-lifecycle.js";
import { stopAndCloseDesktop } from "./desktop-helpers.mjs";

for (const restartApplication of [false, true]) test(`desktop Stop preserves unknown outcomes until explicit isolated abandonment (restart=${restartApplication})`, { timeout: 90_000 }, async () => {
  const run = createRunDirectory("desktop stop 中文"), original = path.join(run.root, "process project");
  mkdirSync(original); mkdirSync(path.join(run.root, "temp"));
  writeFileSync(path.join(original, "package.json"), '{"private":true,"type":"module"}');
  createProcessTreeFixture(original, 12_000);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(key.toUpperCase())));
  Object.assign(env, { LCODEX_DESKTOP_TEST_ROOT: run.root, TEMP: path.join(run.root, "temp"), TMP: path.join(run.root, "temp") });
  let app, clean = false;
  try {
    app = await _electron.launch({ executablePath: electronPath, args: ["."], cwd: path.resolve("."), env });
    let page = await app.firstWindow(); await page.getByRole("heading", { name: "从一个本地项目开始" }).waitFor();
    await app.evaluate((_electron, source) => { (0, eval)(source); }, readFileSync(path.resolve("tests/mock-model.mjs"), "utf8"));
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, original);
    await page.getByRole("button", { name: "选择项目", exact: true }).click();
    await page.getByRole("heading", { name: "一起构建 process project" }).waitFor();
    const keyReply = await page.evaluate(() => window.lcodex.request({ type: "set-key", key: "sk-synthetic-stop-not-a-real-credential" }));
    assert.equal(keyReply.ok, true);
    const chatId = keyReply.state.activeChatId;
    await page.getByRole("combobox", { name: "任务方式" }).selectOption("write");
    await page.getByRole("textbox", { name: "输入任务" }).fill("STOP_TREE：启动合成进程树，用来测试停止按钮。");
    await page.getByRole("button", { name: "发送任务", exact: true }).click();
    const manifestFile = path.join(run.root, "desktop/tasks", chatId, "task.json");
    const deadline = Date.now() + 20_000;
    while (!existsSync(manifestFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const workspace = path.join(manifest.taskDirectory, "workspace");
    const readinessDeadline = Date.now() + 35_000;
    while (!["parent", "child", "grandchild"].every(role => existsSync(path.join(workspace, `pid-${role}.json`))) && Date.now() < readinessDeadline) {
      const state = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
      const current = state.state.chats.find(chat => chat.id === chatId);
      if (["ended", "failed", "stopped", "reconcile"].includes(current.execution)) throw new Error(current.error ?? "PROCESS_FIXTURE_NOT_STARTED");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const tree = await waitForProcessTree(workspace);
    await page.getByRole("button", { name: "停止任务", exact: true }).click();
    await page.getByText("需要核对", { exact: true }).waitFor({ timeout: 40_000 });
    const proof = await verifyTreeStopped(workspace, tree, 12_000);
    assert.equal(proof.allEnded, true); assert.equal(proof.noLateWrites, true);
    const reply = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
    const chat = reply.state.chats.find(chat => chat.id === chatId);
    assert.equal(chat.execution, "reconcile"); assert.equal(chat.reviewId, null); assert.equal(chat.changes.length, 0);
    assert.equal(existsSync(path.join(original, "pid-parent.json")), false);
    const restart = await page.evaluate(chatId => window.lcodex.request({ type: "send", chatId, text: "retry" }), chatId);
    assert.equal(restart.ok, false);
    assert.equal(restart.code, "TASK_REVIEW_OR_RECONCILE_REQUIRED");
    const removeUnknown = await page.evaluate(chatId => window.lcodex.request({ type: "delete-chat", chatId }), chatId);
    assert.equal(removeUnknown.ok, false); assert.equal(removeUnknown.code, "CHAT_DELETE_REFUSED");
    const budgetBefore = readFileSync(path.join(run.root, "test-budget.jsonl"), "utf8");
    if (restartApplication) {
      await app.close();
      app = await _electron.launch({ executablePath: electronPath, args: ["."], cwd: path.resolve("."), env }); page = await app.firstWindow();
    }
    await page.getByRole("button", { name: "核对并放弃本次隔离尝试", exact: true }).click();
    await page.getByRole("button", { name: "新建聊天继续工作", exact: true }).waitFor();
    const ended = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
    const endedChat = ended.state.chats.find(item => item.id === chatId);
    assert.equal(endedChat.execution, "stopped"); assert.equal(endedChat.verification, "unverified");
    assert.equal(endedChat.error, "TASK_ISOLATED_ABANDONED");
    assert.equal(readFileSync(path.join(run.root, "test-budget.jsonl"), "utf8"), budgetBefore);
    assert.equal(existsSync(workspace), true, "Explicit abandonment retains evidence until separate deletion");
    assert.equal(existsSync(path.join(original, "pid-parent.json")), false);
    await page.getByRole("button", { name: "删除聊天", exact: true }).click();
    await page.getByRole("button", { name: "删除聊天和副本", exact: true }).click();
    await page.getByRole("dialog", { name: "删除聊天", exact: true }).waitFor({ state: "hidden" });
    assert.equal(existsSync(manifest.taskDirectory), false);
    assert.equal(existsSync(original), true);
    clean = true;
  } finally { await stopAndCloseDesktop(app); if (clean) run.cleanup(); else console.log("Retained generated stop run:", path.basename(run.root)); }
});
