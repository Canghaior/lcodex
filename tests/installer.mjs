// Explicit local installation acceptance; not part of npm test. No model calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { _electron } from "playwright-core";
import { createRunDirectory } from "../dist/validation/run-directory.js";

if (!process.argv.includes("--install")) throw new Error("INSTALL_OPT_IN_REQUIRED");
const execute = promisify(execFile), version = JSON.parse(readFileSync("package.json", "utf8")).version;
const shell = path.resolve(".local/releases/win-unpacked/resources/runtimes/powershell/pwsh.exe");
const installer = path.resolve(`.local/releases/lcodex-${version}-win-x64-setup.exe`);
const registry = async () => {
  const { stdout } = await execute(shell, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction Stop | Get-ItemProperty | Where-Object DisplayName -like 'lcodex*' | Select-Object DisplayIcon,UninstallString)"], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
};
const resume = process.argv.find(arg => arg.startsWith("--resume="))?.slice(9);
if (!resume) assert.deepEqual(await registry(), [], "Never replace an existing lcodex installation");
const shortcut = path.join(process.env.APPDATA, "Microsoft/Windows/Start Menu/Programs/lcodex.lnk");
if (!resume) assert.equal(existsSync(shortcut), false, "Never replace an existing shortcut");
if (resume) {
  assert.equal(path.dirname(realpathSync(resume)).toLowerCase(), path.resolve(".local/runs").toLowerCase());
  assert.equal(JSON.parse(readFileSync(path.join(resume, ".lcodex-run.json"), "utf8")).kind, "generated-validation-run");
}
const run = resume ? { root: realpathSync(resume), cleanup() { console.log("Resumed test profile retained for verified cleanup:", path.basename(resume)); } } : createRunDirectory("installer 中文");
const target = path.join(run.root, "installed app"), profile = path.join(run.root, "retained profile");
mkdirSync(profile, { recursive: true });
const report = { version, realInstaller: true, realModel: false, cleanWindows: false, status: "failed" };
let app;
try {
  if (!resume) {
    console.log("Installing current-user candidate into generated directory");
    await execute(installer, ["/S", "/D=" + target], { windowsHide: true, windowsVerbatimArguments: true, timeout: 180000 });
  }
  const installed = await registry(); assert.equal(installed.length, 1);
  const executable = path.join(target, "lcodex.exe"); assert.equal(existsSync(executable), true);
  assert.equal(installed[0].DisplayIcon, executable + ",0");
  console.log("Checking actual installed application with no developer PATH");
  const result = await execute(process.execPath, ["--test", "tests/packaged.test.mjs"], { cwd: path.resolve("."), env: { ...process.env, LCODEX_PACKAGE_EXECUTABLE: executable }, windowsHide: true, timeout: 200000, maxBuffer: 20000 });
  report.workflow = result.stdout.includes("pass 1"); assert.equal(report.workflow, true);
  app = await _electron.launch({ executablePath: executable, args: ["--user-data-dir=" + profile], timeout: 40000 });
  const page = await app.firstWindow(); await page.getByRole("heading", { name: "从一个本地项目开始" }).waitFor();
  const setup = await page.evaluate(() => window.lcodex.request({ type: "configure-budget", totalMicros: 2000000, trialMicros: 500000 }));
  assert.equal(setup.ok, true); await app.close(); app = undefined;
  const usage = path.join(profile, "usage.jsonl"), before = createHash("sha256").update(readFileSync(usage)).digest("hex");
  console.log("Uninstalling this generated installation and checking retained profile");
  const uninstaller = path.join(target, "Uninstall lcodex.exe");
  assert.ok(['"' + uninstaller + '"', '"' + uninstaller + '" /currentuser'].includes(installed[0].UninstallString));
  await execute(uninstaller, ["/S", "/currentuser"], { windowsHide: true, timeout: 120000 });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && (existsSync(executable) || (await registry()).length)) await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(existsSync(executable), false); assert.deepEqual(await registry(), []); assert.equal(existsSync(shortcut), false);
  assert.equal(createHash("sha256").update(readFileSync(usage)).digest("hex"), before);
  report.status = "passed"; report.customProfilePreserved = true;
} finally {
  await app?.close(); mkdirSync(".local/reports", { recursive: true });
  writeFileSync(".local/reports/p4-installation.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.status === "passed") run.cleanup(); else console.log("Retained installer fixture:", path.basename(run.root));
}
