import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFixture, snapshot } from "./fixtures.js";
import { isolatedEnvironment } from "./isolated-env.js";
import { WindowsFileGuard } from "./windows-file-guard.js";
import { abandonStoppedIsolatedWorkspace } from "./abandon-isolated.js";
import { prepareReviewWorkspace } from "./review-workspace.js";

const shell = "C:/Users/lijin/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe";
test("explicit isolated abandonment requires the exact task owner to have ended and never alters the original", { skip: process.platform !== "win32" || !existsSync(shell), timeout: 35_000 }, async () => {
  const fixture = createFixture(false), state = path.join(fixture.root, "state"), original = snapshot(fixture.project); mkdirSync(state);
  const script = `
    import {prepareReviewWorkspace} from './dist/validation/review-workspace.js';
    import {WindowsFileGuard} from './dist/validation/windows-file-guard.js';
    import {writeFileSync} from 'node:fs'; import path from 'node:path';
    const [project,state,root,shell]=process.argv.slice(1);
    const task=await prepareReviewWorkspace(project,state,new WindowsFileGuard(shell,root));
    writeFileSync(path.join(task.workspace,'attempt.txt'),'unapplied isolated attempt');
    console.log(JSON.stringify({taskDirectory:task.taskDirectory})); process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, fixture.project, state, fixture.root, shell], { cwd: process.cwd(), env: isolatedEnvironment(fixture.root, process.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close"); child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const [chunk] = await once(child.stdout, "data"), { taskDirectory } = JSON.parse(String(chunk));
    const guard = new WindowsFileGuard(shell, fixture.root);
    await assert.rejects(abandonStoppedIsolatedWorkspace(fixture.project, state, taskDirectory, guard), /PROJECT_LOCK_OWNER_ACTIVE/);
    child.kill(); await closed;
    await assert.rejects(prepareReviewWorkspace(fixture.project, state, guard), /PROJECT_LOCK_BUSY_RECONCILE/);
    const lockFile = path.join(state, readdirSync(state).find(name => name.endsWith(".lock"))!), lockBytes = readFileSync(lockFile, "utf8");
    writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(lockBytes), ownerTaskId: randomUUID() }));
    await assert.rejects(abandonStoppedIsolatedWorkspace(fixture.project, state, taskDirectory, guard), /PROJECT_LOCK_OWNERSHIP_CHANGED/);
    writeFileSync(lockFile, lockBytes);
    await abandonStoppedIsolatedWorkspace(fixture.project, state, taskDirectory, guard);
    assert.deepEqual(snapshot(fixture.project), original);
    assert.equal(existsSync(path.join(taskDirectory, "workspace/attempt.txt")), true);
    const next = await prepareReviewWorkspace(fixture.project, state, guard); next.close();
  } finally { clearTimeout(timer); child.kill(); await closed; fixture.cleanup(); }
});
