import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { acquireProjectWriteLock } from "./project-write-lock.js";
import { createRunDirectory } from "./run-directory.js";
import { isolatedEnvironment } from "./isolated-env.js";

function fixture() {
  const run = createRunDirectory("project-lock");
  const state = path.join(run.root, "state"), project = path.join(run.root, "project");
  for (const dir of [state, project]) mkdirSync(dir);
  return { ...run, state, project };
}

test("one project writer excludes another while a different project remains available", () => {
  const run = fixture();
  try {
    const first = acquireProjectWriteLock(run.state, run.project);
    assert.throws(() => acquireProjectWriteLock(run.state, path.join(run.project, ".")), /BUSY_RECONCILE/);
    const otherProject = path.join(run.root, "other"); mkdirSync(otherProject);
    const other = acquireProjectWriteLock(run.state, otherProject);
    other.release(); first.release();
    const next = acquireProjectWriteLock(run.state, run.project); next.release();
    assert.equal(readdirSync(run.state).length, 0);
  } finally { run.cleanup(); }
});

test("aliases cannot bypass a project lock and linked control state is refused", () => {
  const run = fixture();
  const alias = path.join(run.root, "alias"), stateAlias = path.join(run.root, "state-alias");
  try {
    symlinkSync(run.project, alias, "junction"); symlinkSync(run.state, stateAlias, "junction");
    const lock = acquireProjectWriteLock(run.state, run.project);
    assert.throws(() => acquireProjectWriteLock(run.state, alias), /BUSY_RECONCILE/);
    assert.throws(() => acquireProjectWriteLock(stateAlias, run.project), /STATE_UNSAFE/);
    lock.release();
  } finally { unlinkSync(alias); unlinkSync(stateAlias); run.cleanup(); }
});

test("changed ownership is preserved for reconciliation instead of deleting another record", () => {
  const run = fixture();
  try {
    const lock = acquireProjectWriteLock(run.state, run.project);
    const file = path.join(run.state, readdirSync(run.state)[0]!);
    writeFileSync(file, "replacement record");
    assert.throws(() => lock.release(), /RELEASE_RECONCILE/);
    assert.equal(readFileSync(file, "utf8"), "replacement record");
    assert.throws(() => acquireProjectWriteLock(run.state, run.project), /BUSY_RECONCILE/);
  } finally { run.cleanup(); }
});

test("an owner process ending does not silently authorize a second writer", async () => {
  const run = fixture();
  const script = "const {acquireProjectWriteLock}=await import(process.argv[1]); acquireProjectWriteLock(process.argv[2],process.argv[3]); console.log('LOCKED'); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, new URL("./project-write-lock.js", import.meta.url).href, run.state, run.project],
    { env: isolatedEnvironment(run.root, process.env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let timeout: NodeJS.Timeout | undefined;
  child.stderr.resume();
  try {
    const [chunk] = await Promise.race([once(child.stdout, "data"), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("owner startup timeout")), 5000); })]);
    assert.equal(String(chunk).trim(), "LOCKED");
    assert.throws(() => acquireProjectWriteLock(run.state, run.project), /BUSY_RECONCILE/);
    child.kill(); await closed;
    assert.throws(() => acquireProjectWriteLock(run.state, run.project), /BUSY_RECONCILE/);
    assert.equal(readdirSync(run.state).length, 1);
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; run.cleanup(); }
});
