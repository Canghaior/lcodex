import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session } from "electron";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { validCommand, type AppState, type Reply } from "../shared/contracts.js";
import { AppStore } from "./storage/store.js";
import { inspectProject, newChat, previewFile } from "./projects/projects.js";
import { WindowsFileGuard } from "../../validation/windows-file-guard.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const testRoot = !app.isPackaged ? process.env.LCODEX_DESKTOP_TEST_ROOT : undefined;
if (testRoot && (path.dirname(realpathSync(testRoot)).toLowerCase() !== path.join(sourceRoot, ".local/runs").toLowerCase() ||
  JSON.parse(readFileSync(path.join(testRoot, ".lcodex-run.json"), "utf8")).kind !== "generated-validation-run")) throw new Error("TEST_ROOT_REFUSED");
const dataRoot = testRoot ? path.join(testRoot, "desktop") : app.isPackaged ? app.getPath("userData") : path.join(sourceRoot, ".local", "desktop");
mkdirSync(dataRoot, { recursive: true });
for (const relative of ["home", "profile/roaming", "profile/local/Packages", "temp"]) mkdirSync(path.join(dataRoot, relative), { recursive: true });
app.setPath("userData", dataRoot);
app.setPath("sessionData", path.join(dataRoot, "chromium"));
app.setAppUserModelId("local.lcodex.desktop");
protocol.registerSchemesAsPrivileged([{ scheme: "lcodex", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
const shell = path.join(app.getPath("home"), ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe");
const engine = path.join(sourceRoot, ".local/engines/codex-0.162.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const node = "C:/nvm4w/nodejs/node.exe";
function matches(file: string, sha: string) { try { return createHash("sha256").update(readFileSync(file)).digest("hex") === sha; } catch { return false; } }

async function main() {
  await app.whenReady();
  const store = new AppStore(dataRoot);
  const runtime = { engine: matches(engine, "dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f"),
    shell: matches(shell, "362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139"),
    node: matches(node, "3a9ac860c566b7aeb144be914f95e3ec36dc88040aa7acb5d9d1e6e0c7afd5e"), key: false, ready: false, platform: "Windows · MXC" };
  const guard = runtime.shell ? new WindowsFileGuard(shell, dataRoot, path.join(sourceRoot, "validation")) : undefined;
  const state = (): AppState => store.state({ runtime, budget: { committed: 0, unknown: 0, limit: 10 }, executionAvailable: false });
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
        const chat = store.chats.find(chat => chat.id === command.chatId);
        if (!chat || chat.execution !== "idle") throw new Error("CHAT_MODE_LOCKED");
        chat.mode = command.mode; store.save();
      } else if (command.type === "open-file") {
        const project = store.projects.find(project => project.id === command.projectId);
        if (!project || !guard) throw new Error("PROJECT_UNAVAILABLE");
        return { ok: true, state: state(), file: await previewFile(project, command.relative, guard) };
      } else if (command.type === "window") {
        if (command.action === "minimize") win.minimize();
        if (command.action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
        if (command.action === "close") win.close();
      }
      return { ok: true, state: state() };
    } catch (error) { return { ok: false, code: error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : "ACTION_FAILED" }; }
  });
  await win.loadURL("lcodex://app/index.html");
  win.show();
}
main().catch(() => { dialog.showErrorBox("lcodex 无法启动", "本地配置或运行文件无法读取。请保留 .local/desktop 供核对，不要删除任务记录。"); app.exit(1); });
app.on("window-all-closed", () => app.quit());
