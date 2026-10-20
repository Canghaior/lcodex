import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell as desktopShell } from "electron";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { validCommand, type AppState, type Reply } from "../shared/contracts.js";
import { AppStore } from "./storage/store.js";
import { assertProjectDataSeparation, inspectProject, newChat, previewFile } from "./projects/projects.js";
import { WindowsFileGuard } from "../../validation/windows-file-guard.js";
import { BudgetLedger } from "../../validation/budget.js";
import { Credentials } from "./storage/credentials.js";
import { Tasks } from "./engine/tasks.js";
import { Pricing, PRICE_SOURCE } from "./storage/pricing.js";
import { runtimePaths, verifyRuntime } from "./runtime.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const testRoot = !app.isPackaged ? process.env.LCODEX_DESKTOP_TEST_ROOT : undefined;
if (testRoot && (path.dirname(realpathSync(testRoot)).toLowerCase() !== path.join(sourceRoot, ".local/runs").toLowerCase() ||
  JSON.parse(readFileSync(path.join(testRoot, ".lcodex-run.json"), "utf8")).kind !== "generated-validation-run")) throw new Error("TEST_ROOT_REFUSED");
// Explicit local profiles support portable use and isolated package acceptance.
// Require an existing, non-redirected absolute directory; never infer one from a project.
const customData = app.commandLine.getSwitchValue("user-data-dir");
if (customData && (!path.isAbsolute(customData) || realpathSync(customData).toLowerCase() !== path.resolve(customData).toLowerCase())) throw new Error("DATA_DIRECTORY_REFUSED");
const dataRoot = testRoot ? path.join(testRoot, "desktop") : customData || (app.isPackaged ? app.getPath("userData") : path.join(sourceRoot, ".local", "desktop"));
mkdirSync(dataRoot, { recursive: true });
for (const relative of ["home", "profile/roaming", "profile/local/Packages", "temp"]) mkdirSync(path.join(dataRoot, relative), { recursive: true });
app.setPath("userData", dataRoot);
app.setPath("sessionData", path.join(dataRoot, "chromium"));
const ownsInstance = app.requestSingleInstanceLock();
app.setAppUserModelId("local.lcodex.desktop");
protocol.registerSchemesAsPrivileged([{ scheme: "lcodex", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
const paths = runtimePaths(sourceRoot, process.resourcesPath, app.isPackaged, app.getPath("home"));
const { engine, shell, node } = paths;
let startupStage = "READY";

async function main() {
  await app.whenReady();
  startupStage = "STORE";
  const store = new AppStore(dataRoot, app.getVersion() + (app.isPackaged ? "" : "-dev"));
  startupStage = "RUNTIME";
  const runtime = { ...await verifyRuntime(paths, process.resourcesPath, app.isPackaged), key: false, ready: false, platform: "Windows · MXC", bundled: app.isPackaged };
  const guard = runtime.shell ? new WindowsFileGuard(shell, dataRoot, paths.guard) : undefined;
  const credentials = new Credentials(dataRoot);
  const pricing = new Pricing(dataRoot, !app.isPackaged), budgetScope = app.isPackaged ? "personal" : "development";
  const ledgerFile = app.isPackaged ? path.join(dataRoot, "usage.jsonl") : testRoot && process.env.LCODEX_LIVE_TEST !== "1" ? path.join(testRoot, "test-budget.jsonl") : path.join(sourceRoot, ".local/state/p1-budget.jsonl");
  if (testRoot && process.env.LCODEX_LIVE_TEST !== "1" && !existsSync(ledgerFile)) BudgetLedger.initialize(ledgerFile);
  let tasks: Tasks | undefined;
  const state = (): AppState => {
    runtime.key = credentials.present(); runtime.ready = runtime.engine && runtime.shell && runtime.node && runtime.key && !tasks?.budgetError && tasks?.budget().pending === 0 && pricing.status().current;
    return store.state({ runtime, budget: tasks?.budget() ?? { committed: 0, unknown: 0, estimated: 0, limit: 10, perTask: 1, pending: 0, pendingCost: 0, revision: "", configured: false, scope: budgetScope, error: "RUNTIME_UNAVAILABLE" }, pricing: pricing.status(), executionAvailable: !!tasks });
  };
  startupStage = "WINDOW";
  const rendererRoot = realpathSync(path.join(sourceRoot, "dist/renderer"));
  protocol.handle("lcodex", request => {
    const url = new URL(request.url);
    if (url.hostname !== "app" || request.method !== "GET") return new Response("Refused", { status: 403 });
    let relative: string;
    try { relative = decodeURIComponent(url.pathname); } catch { return new Response("Invalid", { status: 400 }); }
    if (relative === "/") relative = "/index.html";
    const file = path.resolve(rendererRoot, "." + relative);
    const within = path.relative(rendererRoot, file);
    if (within.startsWith("..") || path.isAbsolute(within) || !existsSync(file)) return new Response("Not found", { status: 404 });
    const final = realpathSync(file), realWithin = path.relative(rendererRoot, final);
    if (realWithin.startsWith("..") || path.isAbsolute(realWithin)) return new Response("Refused", { status: 403 });
    return net.fetch(pathToFileURL(final).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("lcodex://app/") && !details.url.startsWith("file://") }));
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ width: 1500, height: 960, minWidth: 780, minHeight: 600, show: false, backgroundColor: "#ffffff", title: "lcodex", frame: false,
    webPreferences: { preload: path.join(sourceRoot, "dist/src/preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  app.on("second-instance", () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  if (guard && runtime.engine && runtime.node) tasks = new Tasks({ root: dataRoot, engine, shell, node, scriptDirectory: paths.guard, ledgerFile, budgetScope, pricing, guard, credentials, store,
    notify: () => { if (!win.isDestroyed()) win.webContents.send("lcodex:state", state()); } });
  let closePending = false;
  win.on("close", event => {
    if (tasks?.busy()) {
      event.preventDefault();
      if (!closePending) { closePending = true; void tasks.stopAll().then(() => {
        closePending = false;
        if (store.chats.some(chat => chat.execution === "reconcile")) dialog.showMessageBox(win, { type: "warning", title: "任务需要核对", message: "未能确认最后一次操作的完整结果。记录已保留，请查看任务状态后再关闭。", buttons: ["保留窗口"] });
        else win.close();
      }).catch(() => { closePending = false; }); }
      return;
    }
    try { tasks?.suspendReviews(); }
    catch { event.preventDefault(); void dialog.showMessageBox(win, { type: "warning", title: "审阅记录需要核对", message: "未能安全保存待应用改动的交接记录。窗口和文件基线已保留，请检查磁盘后重试。", buttons: ["保留窗口"] }); }
  });
  let choosing = false;
  ipcMain.handle("lcodex:request", async (event, command: unknown): Promise<Reply> => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== "lcodex://app/index.html" || !validCommand(command)) return { ok: false, code: "IPC_REFUSED" };
    try {
      if (command.type === "choose-project") {
        if (choosing) throw new Error("PROJECT_SELECTION_BUSY");
        choosing = true;
        try {
          const result = await dialog.showOpenDialog(win, { title: "选择本地项目", properties: ["openDirectory"] });
          if (!result.canceled && result.filePaths[0]) {
            if (!guard) throw new Error("SHELL_UNAVAILABLE");
            assertProjectDataSeparation(result.filePaths[0], dataRoot);
            const candidate = await inspectProject(result.filePaths[0], guard);
            const old = store.projects.find(project => project.path.toLowerCase() === candidate.path.toLowerCase());
            if (old) { old.files = candidate.files; old.excluded = candidate.excluded; }
            else store.projects.push(candidate);
            const chat = newChat(old?.id ?? candidate.id); store.chats.push(chat); store.activeChatId = chat.id;
            store.save();
          }
        } finally { choosing = false; }
      } else if (command.type === "new-chat") {
        if (!store.projects.some(project => project.id === command.projectId)) throw new Error("PROJECT_NOT_FOUND");
        const chat = newChat(command.projectId); store.chats.push(chat); store.activeChatId = chat.id; store.save();
      } else if (command.type === "select-chat") {
        if (!store.chats.some(chat => chat.id === command.chatId)) throw new Error("CHAT_NOT_FOUND");
        store.activeChatId = command.chatId; store.save();
      } else if (command.type === "set-mode") {
        const chat = store.chat(command.chatId);
        if (!chat || !["idle", "ended"].includes(chat.execution) || chat.changes.some(change => ["pending", "needs-reconcile"].includes(change.status))) throw new Error("CHAT_MODE_LOCKED");
        chat.mode = command.mode; store.save();
      } else if (command.type === "open-file") {
        const project = store.projects.find(project => project.id === command.projectId);
        if (!project || !guard) throw new Error("PROJECT_UNAVAILABLE");
        return { ok: true, state: state(), file: await previewFile(project, command.relative, guard) };
      } else if (command.type === "set-key" || command.type === "delete-key") {
        if (tasks?.busy()) throw new Error("TASK_ALREADY_RUNNING");
        if (command.type === "set-key") await credentials.save(command.key); else credentials.remove();
      } else if (command.type === "set-test-command") {
        if (tasks?.busy()) throw new Error("TASK_ALREADY_RUNNING");
        const project = store.projects.find(project => project.id === command.projectId); if (!project) throw new Error("PROJECT_NOT_FOUND");
        project.testCommand = command.command.trim(); store.save();
      } else if (["confirm-price", "open-pricing", "configure-budget", "account-unknown", "recover-budget-lock"].includes(command.type)) {
        if (!tasks) throw new Error("RUNTIME_UNAVAILABLE");
        if (tasks.busy()) throw new Error("TASK_ALREADY_RUNNING");
        if (command.type === "open-pricing") await desktopShell.openExternal(PRICE_SOURCE);
        if (command.type === "confirm-price") pricing.confirm();
        if (command.type === "configure-budget") tasks.configureBudget(command.totalMicros, command.trialMicros);
        if (command.type === "account-unknown") tasks.accountUnknown(command.revision);
        if (command.type === "recover-budget-lock") await tasks.recoverBudget();
      } else if (command.type === "check-connection") {
        if (!tasks) throw new Error("RUNTIME_UNAVAILABLE");
        await tasks.checkConnection();
        return { ok: true, state: state(), connectionVerified: true };
      } else if (["send", "stop", "apply", "discard", "reopen-review", "delete-chat", "abandon-isolated"].includes(command.type)) {
        if (!("chatId" in command) || !tasks) throw new Error("RUNTIME_UNAVAILABLE");
        const chat = store.chat(command.chatId); if (!chat) throw new Error("CHAT_NOT_FOUND");
        const project = store.projects.find(project => project.id === chat.projectId); if (!project) throw new Error("PROJECT_NOT_FOUND");
        await store.hold(chat.id, async () => {
          if (command.type === "send") await tasks.start(chat, project, command.text);
          if (command.type === "stop") tasks.stop(chat.id);
          if (command.type === "apply") await tasks.apply(chat, command.reviewId, command.files);
          if (command.type === "discard") tasks.discard(chat, command.reviewId);
          if (command.type === "reopen-review") await tasks.reopenReview(chat, project);
          if (command.type === "delete-chat") await tasks.deleteChat(chat);
          if (command.type === "abandon-isolated") await tasks.abandonIsolated(chat, project);
        });
      } else if (command.type === "window") {
        if (command.action === "minimize") win.minimize();
        if (command.action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
        if (command.action === "close") win.close();
      }
      return { ok: true, state: state() };
    } catch (error) { return { ok: false, code: error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : "ACTION_FAILED" }; }
  });
  startupStage = "LOAD";
  await win.loadURL("lcodex://app/index.html");
  win.show();
}
if (ownsInstance) main().catch((error: unknown) => {
  // Fixed stages and bounded codes make a startup failure diagnosable without
  // exposing error messages, file paths, configuration contents or credentials.
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "UNKNOWN";
  const diagnostic = `START_${startupStage}_${code}`;
  console.error("LCODEX_START_FAILED", diagnostic);
  dialog.showErrorBox("lcodex 无法启动", `本地配置或运行文件无法读取。错误码：${diagnostic}。请保留应用数据目录供核对，不要删除任务记录。`);
  app.exit(1);
});
else app.exit(0);
app.on("window-all-closed", () => app.quit());
