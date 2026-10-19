import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { build, Platform, Arch } from "electron-builder";
import { RUNTIME_HASHES } from "../dist/src/main/runtime.js";
import { listPackage, statFile } from "@electron/asar";

const root = realpathSync("."), stage = path.join(root, ".local/package"), output = path.join(root, ".local/releases");
const engine = path.join(root, ".local/engines/codex-0.162.0/package/vendor/x86_64-pc-windows-msvc");
const shell = path.join(process.env.USERPROFILE, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell");
const node = path.join(root, ".local/engines/node-24.8.0/node-v24.8.0-win-x64");
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const ownDirectory = directory => {
  if (path.dirname(directory).toLowerCase() !== path.join(root, ".local").toLowerCase()) throw new Error("PACKAGE_PATH_REFUSED");
  if (!existsSync(directory)) { mkdirSync(directory); writeFileSync(path.join(directory, ".lcodex-generated.json"), JSON.stringify({ kind: "lcodex-package", root })); }
  if (realpathSync(directory).toLowerCase() !== directory.toLowerCase() || JSON.parse(readFileSync(path.join(directory, ".lcodex-generated.json"), "utf8")).root !== root) throw new Error("PACKAGE_OWNERSHIP_REFUSED");
};
ownDirectory(stage); ownDirectory(output);
const icon = path.join(stage, "lcodex.ico");
const active = execFileSync(path.join(shell, "pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:LCODEX_RELEASE_CHECK + '\\', [StringComparison]::OrdinalIgnoreCase) }).Count"], { windowsHide: true, encoding: "utf8", env: { ...process.env, LCODEX_RELEASE_CHECK: output } }).trim();
if (active !== "0") throw new Error("PACKAGE_RELEASE_PROCESS_STILL_RUNNING");
for (const [key, file] of [["engine", path.join(engine, "bin/codex.exe")], ["shell", path.join(shell, "pwsh.exe")], ["node", path.join(node, "node.exe")]]) if (digest(file) !== RUNTIME_HASHES[key]) throw new Error("PACKAGE_RUNTIME_MISMATCH:" + key);
const tree = directory => {
  const files = [];
  const walk = current => {
    if (lstatSync(current).isSymbolicLink()) throw new Error("PACKAGE_LINK_REFUSED");
    for (const name of readdirSync(current)) {
      const file = path.join(current, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("PACKAGE_LINK_REFUSED");
      if (stat.isDirectory()) walk(file); else if (stat.isFile() && stat.nlink === 1) files.push(file); else throw new Error("PACKAGE_SPECIAL_FILE_REFUSED");
    }
  };
  walk(directory); return files;
};
tree(stage); tree(output);
execFileSync(path.join(shell, "pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts/build-icon.ps1"), "-OutputFile", icon], { windowsHide: true });
const copy = (from, to) => { mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); };
const appRoot = path.join(stage, "app"), noticeRoot = path.join(stage, "notices");
mkdirSync(appRoot, { recursive: true }); mkdirSync(noticeRoot, { recursive: true });
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "lcodex", productName: "lcodex", version: pkg.version, private: true, type: "module", main: "dist/src/main/bootstrap.cjs", description: pkg.description, author: "lcodex contributors" }, null, 2));
// Only modules reachable from the actual entry points are packaged. The strict
// list also excludes leftovers, test runners, credentials and user state.
const pending = ["dist/src/main/bootstrap.cjs", "dist/src/main/index.js", "dist/src/preload/index.cjs"], included = new Set();
while (pending.length) {
  const relative = pending.pop(); if (included.has(relative)) continue; included.add(relative);
  if (!relative.startsWith("dist/") || relative.includes("..") || /(?:\.test\.|-probe\.)/.test(relative)) throw new Error("PACKAGE_MODULE_REFUSED");
  const source = path.join(root, relative), text = readFileSync(source, "utf8"); copy(source, path.join(appRoot, relative));
  for (const match of text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) pending.push(path.relative(root, path.resolve(path.dirname(source), match[1])).replaceAll("\\", "/"));
}
for (const file of tree(path.join(root, "dist/renderer"))) copy(file, path.join(appRoot, path.relative(root, file)));
const appFiles = ["package.json", ...included, ...tree(path.join(root, "dist/renderer")).map(file => path.relative(root, file).replaceAll("\\", "/"))];
const notices = [];
for (const [name, directory, filter] of [["codex-0.162.0", path.join(root, ".local/vendor-licenses/codex"), /^(LICENSE|NOTICE)$/i], ["node-24.8.0", node, /^LICENSE$/i], ["powershell-7.6.5", shell, /^(LICENSE\.txt|ThirdPartyNotices\.txt)$/i], ["electron-44.9.0", path.join(root, "node_modules/electron/dist"), /^LICENSE(?:S\.chromium\.html)?$/i]]) {
  const names = readdirSync(directory).filter(name => filter.test(name)); if (!names.length) throw new Error("PACKAGE_LICENSE_MISSING");
  for (const file of names) copy(path.join(directory, file), path.join(noticeRoot, name, file));
  notices.push({ name, files: names });
}
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
for (const [relative, metadata] of Object.entries(lock.packages)) {
  if (!relative.startsWith("node_modules/") || metadata.dev) continue;
  const directory = path.join(root, relative), info = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  const names = readdirSync(directory).filter(name => /^(license|copying|notice)(\..*)?$/i.test(name) && lstatSync(path.join(directory, name)).isFile());
  if (!names.length) throw new Error("PACKAGE_LICENSE_MISSING:" + info.name);
  const name = info.name.replaceAll("/", "-").replaceAll("@", "") + "-" + info.version;
  for (const file of names) copy(path.join(directory, file), path.join(noticeRoot, "npm", name, file));
  notices.push({ name: info.name, version: info.version, license: info.license, files: names });
}
writeFileSync(path.join(noticeRoot, "inventory.json"), JSON.stringify(notices, null, 2));
const resources = [{ from: engine, to: "runtimes/codex" }, { from: shell, to: "runtimes/powershell" },
  { from: node, to: "runtimes/node", filter: ["node.exe", "LICENSE", "npm", "npm.cmd", "npm.ps1", "node_modules/npm/**/*"] },
  { from: path.join(root, "validation"), to: "guard", filter: ["windows-file-guard.ps1", "windows-file-guard.cs"] }];
const manifest = [], runtimeCopies = [];
for (const resource of resources) {
  for (const file of tree(resource.from)) {
    const relative = path.relative(resource.from, file).replaceAll("\\", "/");
    if (resource.to === "runtimes/node" && !["node.exe", "LICENSE", "npm", "npm.cmd", "npm.ps1"].includes(relative) && !relative.startsWith("node_modules/npm/")) continue;
    if (resource.to === "guard" && !resource.filter.includes(relative)) continue;
    manifest.push({ relative: resource.to + "/" + relative, sha256: digest(file) });
    runtimeCopies.push({ from: file, relative: resource.to + "/" + relative });
  }
}
writeFileSync(path.join(stage, "runtime-manifest.json"), JSON.stringify({ version: 1, files: manifest }, null, 2));
process.env.ELECTRON_BUILDER_CACHE = path.join(root, ".local/builder-cache");
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const artifacts = await build({ projectDir: root, publish: "never", targets: Platform.WINDOWS.createTarget(process.argv.includes("--dir") ? ["dir"] : ["nsis"], Arch.x64), config: {
  appId: "local.lcodex.desktop", productName: "lcodex", electronVersion: "44.9.0", electronDist: path.join(root, "node_modules/electron/dist"),
  directories: { app: appRoot, output }, files: [...appFiles, "!node_modules/**/*"], asar: true, npmRebuild: false,
  extraResources: [{ from: path.join(stage, "runtime-manifest.json"), to: "runtime-manifest.json" }, { from: noticeRoot, to: "notices" }],
  afterPack: async context => {
    if (path.resolve(context.appOutDir).toLowerCase() !== path.join(output, "win-unpacked").toLowerCase()) throw new Error("PACKAGE_OUTPUT_REFUSED");
    tree(context.appOutDir);
    // Builder's dependency filters exclude nested node_modules even in extra
    // resources. Copy the exact verified runtime inventory, including npm.
    for (const entry of runtimeCopies) copy(entry.from, path.join(context.appOutDir, "resources", entry.relative));
  },
  win: { icon, signExecutable: false, requestedExecutionLevel: "asInvoker", artifactName: "lcodex-" + pkg.version + "-win-x64-setup.exe" },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, runAfterFinish: false, deleteAppDataOnUninstall: false, createDesktopShortcut: false, createStartMenuShortcut: true },
} });
const archive = path.join(output, "win-unpacked/resources/app.asar"), expectedFiles = new Set(appFiles);
for (const entry of listPackage(archive)) {
  const relative = entry.slice(1).replaceAll("\\", "/"), stat = statFile(archive, path.normalize(relative));
  if (stat.files) continue;
  if (stat.link || !expectedFiles.delete(relative)) throw new Error("PACKAGE_UNEXPECTED_FILE:" + relative);
}
if (expectedFiles.size) throw new Error("PACKAGE_REQUIRED_FILES_MISSING");
writeFileSync(path.join(output, "package-evidence.json"), JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), runtimeFiles: manifest.length, appFiles, artifacts: artifacts.map(file => ({ file: path.basename(file), sha256: digest(file) })), signed: false }, null, 2));
console.log(JSON.stringify({ packaged: true, runtimeFiles: manifest.length, appFiles: appFiles.length, artifacts: artifacts.map(file => path.basename(file)) }));
