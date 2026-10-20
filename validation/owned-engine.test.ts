import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { spawnOwnedEngine } from "./owned-engine.js";
import { createRunDirectory } from "./run-directory.js";
import { isolatedEnvironment } from "./isolated-env.js";
import { createProcessTreeFixture, verifyTreeStopped, waitForProcessTree } from "./workflow-lifecycle.js";

const shell = path.join(process.env.USERPROFILE!, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe");
for (const mode of ["explicit-stop", "owner-crash", "parent-exit"] as const) test(`owned job ends all descendants after ${mode}`, { timeout: 20000 }, async () => {
  const run = createRunDirectory("job owner 中文");
  for (const name of ["temp", "profile/local", "profile/roaming"]) mkdirSync(path.join(run.root, name), { recursive: true });
  createProcessTreeFixture(run.root, 4500);
  // When the direct engine exits, its detached descendants still belong to the
  // job. The parent's exit must not make those processes impossible to find.
  if (mode === "parent-exit") writeFileSync(path.join(run.root, "launcher.mjs"), `
import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';
spawn(process.execPath,['process-tree.mjs','parent'],{detached:true,stdio:'ignore'}).unref();
const timer=setInterval(()=>{if(existsSync('pid-grandchild.json')) {clearInterval(timer); process.exit(0);}},20);
`);
  const owner = spawnOwnedEngine({ engine: process.execPath, shell, root: run.root, cwd: run.root,
    env: isolatedEnvironment(run.root, process.env), args: mode === "parent-exit" ? ["launcher.mjs"] : ["process-tree.mjs", "parent"] });
  let errorText = ""; owner.child.stderr.on("data", chunk => { errorText += chunk; }); owner.child.stdout.resume();
  const closed = new Promise<number | null>(resolve => owner.child.once("close", resolve));
  let clean = false;
  try {
    const tree = await waitForProcessTree(run.root);
    if (mode === "explicit-stop") owner.stop();
    if (mode === "owner-crash") owner.child.kill();
    const exit = await closed;
    if (mode !== "owner-crash") {
      assert.equal(exit, 0, errorText);
      assert.deepEqual(owner.result(), { processesEnded: true, forced: mode === "explicit-stop", engineExitCode: mode === "parent-exit" ? 0 : null });
    } else assert.equal(owner.result(), null, "A killed owner cannot certify process exit");
    assert.deepEqual(await verifyTreeStopped(run.root, tree, 4500), { processCount: 3, allEnded: true, noLateWrites: true });
    clean = true;
  } finally { if (owner.child.exitCode === null && owner.child.signalCode === null) { owner.stop(); await closed; } if (clean) run.cleanup(); }
});

test("owned process preserves UTF-8 stdio and exact quoted arguments", { timeout: 15000 }, async () => {
  const run = createRunDirectory("job stdio 中文"); mkdirSync(path.join(run.root, "temp"));
  writeFileSync(path.join(run.root, "echo.mjs"), "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify({input:s,args:process.argv.slice(2)})));");
  const args = ["echo.mjs", '空 格\\"quote', "trailing\\"];
  const owner = spawnOwnedEngine({ engine: process.execPath, shell, root: run.root, cwd: run.root, env: isolatedEnvironment(run.root, process.env), args });
  let output = "", errors = ""; owner.child.stdout.on("data", bytes => { output += bytes; }); owner.child.stderr.on("data", bytes => { errors += bytes; });
  const closed = new Promise<number | null>(resolve => owner.child.once("close", resolve));
  owner.child.stdin.end("中文 RPC\n");
  assert.equal(await closed, 0, errors);
  assert.deepEqual(JSON.parse(output), { input: "中文 RPC\n", args: args.slice(1) });
  assert.deepEqual(owner.result(), { processesEnded: true, forced: false, engineExitCode: 0 });
  run.cleanup();
});

test("coordinator crash also ends the owner's job without a stop request", { timeout: 20000 }, async () => {
  const run = createRunDirectory("job coordinator 中文");
  for (const name of ["temp", "profile/local", "profile/roaming"]) mkdirSync(path.join(run.root, name), { recursive: true });
  createProcessTreeFixture(run.root, 4500);
  writeFileSync(path.join(run.root, "coordinator.mjs"), `
import {spawnOwnedEngine} from ${JSON.stringify(pathToFileURL(path.resolve("dist/validation/owned-engine.js")).href)};
import {existsSync} from 'node:fs';
const owner=spawnOwnedEngine(${JSON.stringify({ engine: process.execPath, shell, root: run.root, cwd: run.root, env: isolatedEnvironment(run.root, process.env), args: ["process-tree.mjs", "parent"], scriptDirectory: path.resolve("validation") })});
owner.child.stdout.resume();owner.child.stderr.resume();
const timer=setInterval(()=>{if(existsSync('pid-grandchild.json')){clearInterval(timer);process.exit(0);}},20);
`);
  const coordinator = spawn(process.execPath, ["coordinator.mjs"], { cwd: run.root, windowsHide: true, stdio: "ignore" });
  const closed = new Promise<number | null>(resolve => coordinator.once("close", resolve));
  const tree = await waitForProcessTree(run.root);
  assert.equal(await closed, 0);
  assert.deepEqual(await verifyTreeStopped(run.root, tree, 4500), { processCount: 3, allEnded: true, noLateWrites: true });
  run.cleanup();
});
