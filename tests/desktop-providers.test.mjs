import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { _electron } from "playwright-core";
import electronPath from "electron";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { stopAndCloseDesktop, waitForFreshDesktop } from "./desktop-helpers.mjs";

const openaiKey = `sk-proj-${"synthetic".repeat(30)}`, deepseekKey = "sk-synthetic-deepseek-test-only-key";
const source = "export function total(items) { return items.reduce((sum, item) => sum + item.unitCents, 0); }\n";
const command = "& 'C:/nvm4w/nodejs/node.exe' --preserve-symlinks --preserve-symlinks-main --test; exit $LASTEXITCODE";
const snapshot = page => page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
const currentChat = reply => reply.state.chats.find(chat => chat.id === reply.state.activeChatId);
async function request(page, command) {
  const reply = await page.evaluate(command => window.lcodex.request(command), command);
  assert.equal(reply.ok, true, reply.code); return reply;
}
async function waitTask(page) {
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const reply = await snapshot(page), chat = currentChat(reply);
    if (!reply.state.busy && !["idle", "running", "waiting", "stopping"].includes(chat.execution)) {
      assert.equal(chat.execution, "ended", JSON.stringify({ code: chat.error, state: chat.execution }));
      return chat;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("DESKTOP_PROVIDER_TASK_TIMEOUT");
}
async function mock(app) {
  // Reuse the unchanged DeepSeek fixture's tool scenario; only the transport
  // envelope is replaced here. No request leaves this Electron process.
  await app.evaluate((_electron, source) => { (0, eval)(source); }, readFileSync("tests/mock-model.mjs", "utf8"));
  await app.evaluate((_electron, key) => {
    const fixtureFetch = globalThis.fetch;
    globalThis.providerRequests = [];
    globalThis.fetch = async (url, init) => {
      if (url !== "https://api.openai.com/v1/responses" || init.headers.Authorization !== `Bearer ${key}`) throw new Error("TEST_PROVIDER_OR_KEY_MISMATCH");
      const body = JSON.parse(init.body);
      if (body.model !== "gpt-6.2-astra" || body.service_tier !== "default" || body.store !== false || body.prompt_cache_options?.mode !== "explicit" || body.include?.[0] !== "reasoning.encrypted_content") throw new Error("TEST_OPENAI_ENVELOPE_MISMATCH");
      const reasoning = body.input.filter(item => item.type === "reasoning");
      if (reasoning.some(item => !item.encrypted_content?.startsWith("synthetic-final-"))) throw new Error("TEST_REASONING_NOT_PRESERVED");
      globalThis.providerRequests.push({ reasoning: reasoning.length, roles: body.input.map(item => item.role).filter(Boolean) });
      if (globalThis.holdNextProviderRequest) {
        globalThis.holdNextProviderRequest = false;
        await new Promise(resolve => { globalThis.releaseProviderRequest = resolve; });
      }
      const response = await fixtureFetch("https://api.deepseek.com/responses", { ...init, body: JSON.stringify({ ...body, model: "deepseek-v4-pro" }) });
      const events = (await response.text()).trim().split("\n\n").map(frame => JSON.parse(frame.split("\ndata: ")[1]));
      const item = { id: `reason-${crypto.randomUUID()}`, type: "reasoning", summary: [], content: null, encrypted_content: `synthetic-final-${crypto.randomUUID()}` };
      for (const event of events) {
        if (event.output_index !== undefined) event.output_index++;
        if (event.response) { event.response.model = "gpt-6.2-astra"; if (event.response.status === "completed") event.response.output.unshift(item); }
      }
      events.splice(1, 0, { type: "response.output_item.added", output_index: 0, item: { ...item, encrypted_content: "synthetic-intermediate" } }, { type: "response.output_item.done", output_index: 0, item });
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    };
  }, openaiKey);
}

test("two providers retain separate keys/budgets and OpenAI runs real protected tools, review and resumed history", { timeout: 240_000 }, async () => {
  const run = createRunDirectory("desktop providers"), project = path.join(run.root, "catalog project");
  mkdirSync(project); mkdirSync(path.join(project, "test")); mkdirSync(path.join(run.root, "temp"));
  writeFileSync(path.join(project, "catalog.mjs"), source);
  writeFileSync(path.join(project, "package.json"), '{"name":"providers-fixture","type":"module","private":true}');
  writeFileSync(path.join(project, "test/catalog.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {total} from '../catalog.mjs'; test('quantity',()=>assert.equal(total([{unitCents:25,quantity:4}]),100));\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(key.toUpperCase())));
  Object.assign(env, { LCODEX_DESKTOP_TEST_ROOT: run.root, TEMP: path.join(run.root, "temp"), TMP: path.join(run.root, "temp") });
  let app, clean = false;
  try {
    app = await _electron.launch({ executablePath: electronPath, args: ["."], cwd: path.resolve("."), env });
    let page = await waitForFreshDesktop(app);
    await mock(app);
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    await request(page, { type: "choose-project" });
    const oldChat = currentChat(await snapshot(page));
    await request(page, { type: "set-key", provider: "deepseek", key: deepseekKey });
    const originalKey = readFileSync(path.join(run.root, "desktop/deepseek.bin"));
    const originalBudget = readFileSync(path.join(run.root, "test-budget.jsonl"), "utf8");
    await request(page, { type: "new-chat", projectId: oldChat.projectId });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("当前聊天模型").selectOption("openai");
    await page.getByLabel("OpenAI API Key", { exact: true }).fill(openaiKey);
    await page.getByRole("button", { name: "保存密钥", exact: true }).click();
    await page.getByText("密钥已加密保存", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("OpenAI API Key").inputValue(), "");
    assert.equal(readFileSync(path.join(run.root, "desktop/openai.bin")).includes(Buffer.from(openaiKey)), false);
    assert.equal((await snapshot(page)).state.budget.configured, false);
    assert.equal(existsSync(path.join(run.root, "desktop/openai-usage-usd.jsonl")), false);
    for (const stale of [{ type: "set-key", key: deepseekKey }, { type: "delete-key", provider: "deepseek" }, { type: "configure-budget", provider: "deepseek", totalMicros: 5_000_000, trialMicros: 1_000_000 }]) {
      assert.equal((await page.evaluate(command => window.lcodex.request(command), stale)).code, "PROVIDER_CHANGED");
    }
    await page.getByLabel("累计预算上限（美元）").fill("5");
    await page.getByLabel("单任务上限（美元）").fill("2");
    await page.getByRole("button", { name: "确认并启用预算", exact: true }).click();
    await page.getByRole("button", { name: "保存预算上限", exact: true }).waitFor();
    await page.getByRole("button", { name: "已核对今日价格与上述记录一致", exact: true }).click();
    const connecting = await request(page, { type: "check-connection", provider: "openai" });
    assert.equal(connecting.connectionProvider, "openai");
    assert.equal(connecting.state.budget.currency, "USD");
    await request(page, { type: "set-test-command", projectId: oldChat.projectId, command });
    const openaiChat = currentChat(await snapshot(page));
    await request(page, { type: "set-mode", chatId: openaiChat.id, mode: "write" });
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await app.evaluate(() => { globalThis.holdNextProviderRequest = true; });
    await request(page, { type: "send", chatId: openaiChat.id, text: "修复数量计算并验证（模拟模型，实际引擎）" });
    await request(page, { type: "select-chat", chatId: oldChat.id });
    assert.equal((await snapshot(page)).state.busy, true);
    assert.equal((await page.evaluate(chatId => window.lcodex.request({ type: "send", chatId, text: "must not run" }), oldChat.id)).code, "TASK_ALREADY_RUNNING");
    await request(page, { type: "select-chat", chatId: openaiChat.id });
    await page.waitForFunction(async () => (await window.lcodex.request({ type: "snapshot" })).state.chats.some(chat => chat.execution === "running"));
    // Wait for the held model boundary without depending on tool timing.
    const deadline = Date.now() + 40_000;
    while (!await app.evaluate(() => !!globalThis.releaseProviderRequest)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 100)); }
    await app.evaluate(() => globalThis.releaseProviderRequest());
    let chat = await waitTask(page);
    assert.equal(chat.verification, "passed"); assert.equal(chat.baselineExit, 1); assert.equal(chat.changes.length, 1);
    assert.equal(readFileSync(path.join(project, "catalog.mjs"), "utf8"), source);
    assert.equal((await page.evaluate(() => window.lcodex.request({ type: "set-provider", provider: "deepseek" }))).code, "CHAT_MODEL_LOCKED");
    const historyStats = await app.evaluate(() => globalThis.providerRequests);
    assert.ok(historyStats.some(item => item.reasoning >= 2));
    assert.ok(historyStats.some(item => item.roles.includes("developer")));
    const ledgerBefore = readFileSync(path.join(run.root, "desktop/openai-usage-usd.jsonl"), "utf8");
    await app.close();
    app = await _electron.launch({ executablePath: electronPath, args: ["."], cwd: path.resolve("."), env }); page = await app.firstWindow();
    await page.getByRole("button", { name: "核对并重开审阅", exact: true }).waitFor();
    await request(page, { type: "reopen-review", chatId: chat.id });
    assert.equal(readFileSync(path.join(run.root, "desktop/openai-usage-usd.jsonl"), "utf8"), ledgerBefore);
    chat = currentChat(await snapshot(page));
    assert.equal(chat.provider, "openai"); assert.equal(chat.model, "gpt-6.2-astra");
    await request(page, { type: "apply", chatId: chat.id, reviewId: chat.reviewId, files: ["catalog.mjs"] });
    assert.match(readFileSync(path.join(project, "catalog.mjs"), "utf8"), /unitCents \* item.quantity/);
    await mock(app); writeFileSync(path.join(project, "latest-note.txt"), "USER_LATEST_SNAPSHOT\n");
    await request(page, { type: "set-mode", chatId: chat.id, mode: "read" });
    await request(page, { type: "send", chatId: chat.id, text: "CONTINUE_AFTER_RESTART：读取最新备注，只读。" });
    chat = await waitTask(page);
    assert.match(chat.tools.at(-1).output, /USER_LATEST_SNAPSHOT/);
    assert.ok((await app.evaluate(() => globalThis.providerRequests))[0].reasoning > 0);
    assert.deepEqual(readFileSync(path.join(run.root, "desktop/deepseek.bin")), originalKey);
    assert.equal(readFileSync(path.join(run.root, "test-budget.jsonl"), "utf8"), originalBudget);
    assert.equal(JSON.stringify(await snapshot(page)).includes(openaiKey), false);
    clean = true;
  } finally { await stopAndCloseDesktop(app); if (clean) run.cleanup(); else console.log("Retained provider test:", path.basename(run.root)); }
});
