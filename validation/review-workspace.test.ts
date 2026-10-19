import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createFixture, snapshot } from "./fixtures.js";
import { prepareReviewWorkspace } from "./review-workspace.js";
import { contentHash, WindowsFileGuard } from "./windows-file-guard.js";
import { inspectApplyJournal } from "./apply-journal.js";
import { isolatedEnvironment } from "./isolated-env.js";

const shell = "C:/Users/lijin/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe";
const options = { skip: process.platform !== "win32" || !existsSync(shell), timeout: 90_000 };

for (const git of [false, true]) test(`isolated review: original preserved, frozen review applied, conflicts retained (git=${git})`, options, async () => {
  const fixture = createFixture(git), state = path.join(fixture.root, "state"); mkdirSync(state);
  mkdirSync(path.join(fixture.project, ".codex")); writeFileSync(path.join(fixture.project, ".codex/config.toml"), "# synthetic local engine configuration\n");
  const guard = new WindowsFileGuard(shell, fixture.root);
  const original = snapshot(fixture.project);
  const task = await prepareReviewWorkspace(fixture.project, state, guard);
  try {
    assert.equal(existsSync(path.join(task.workspace, ".env")), false);
    assert.equal(existsSync(path.join(task.workspace, ".git")), false);
    assert.equal(existsSync(path.join(task.workspace, ".codex")), false);
    writeFileSync(path.join(task.workspace, "invoice.mjs"), "// reviewed version\n");
    unlinkSync(path.join(task.workspace, "README.md"));
    writeFileSync(path.join(task.workspace, "new file 中文.txt"), "new file\n");
    writeFileSync(path.join(task.workspace, "user-notes.txt"), "agent notes\n");
    assert.deepEqual(snapshot(fixture.project), original);
    const review = await task.seal();
    assert.equal(review.changes.length, 4);
    assert.equal(review.verificationLocation, "isolated-copy");
    assert.ok(review.excluded.includes(".env"));
    // Caller mutations cannot alter the private selection or frozen contents.
    review.changes[0]!.before = null;
    writeFileSync(path.join(task.workspace, "invoice.mjs"), "// changed AFTER review\n");
    writeFileSync(path.join(fixture.project, "user-notes.txt"), "user concurrent notes\n");
    await assert.rejects(task.apply("wrong-review", ["invoice.mjs"]), /SELECTION_INVALID/);
    const outcomes = await task.apply(review.id, ["invoice.mjs", "README.md", "new file 中文.txt", "user-notes.txt"]);
    assert.deepEqual(outcomes.map(item => item.status), ["applied", "applied", "applied", "conflict"]);
    assert.equal(readFileSync(fixture.sourceFile, "utf8"), "// reviewed version\n");
    assert.equal(existsSync(path.join(fixture.project, "README.md")), false);
    assert.equal(readFileSync(path.join(fixture.project, "new file 中文.txt"), "utf8"), "new file\n");
    assert.equal(readFileSync(path.join(fixture.project, "user-notes.txt"), "utf8"), "user concurrent notes\n");
    assert.equal(snapshot(fixture.project)[".env"], original[".env"]);
    if (git) assert.equal(contentHash(readFileSync(path.join(fixture.project, ".git/index"))), fixture.gitState?.indexSha256);
    await assert.rejects(task.apply(review.id, ["invoice.mjs"]), /SELECTION_INVALID/);
    const journal = task.journal().trim().split("\n").map(line => JSON.parse(line) as { type: string });
    assert.equal(journal.filter(line => line.type === "intent").length, 4);
    assert.equal(journal.filter(line => line.type === "result").length, 4);
  } finally { task.close(); fixture.cleanup(); }
});

test("native apply holds file and ancestor handles across compare and write", options, async () => {
  const fixture = createFixture(false), guard = new WindowsFileGuard(shell, fixture.root);
  const folder = path.join(fixture.project, "folder"), file = path.join(folder, "code.txt"); mkdirSync(folder); writeFileSync(file, "before");
  let callbackRan = false;
  try {
    const result = await guard.apply(fixture.project, "folder/code.txt", contentHash("before"), Buffer.from("after"), () => {
      callbackRan = true;
      assert.throws(() => writeFileSync(file, "other editor"));
      assert.throws(() => renameSync(folder, path.join(fixture.project, "renamed")));
      assert.throws(() => renameSync(fixture.project, path.join(fixture.root, "moved-project")));
    });
    assert.equal(callbackRan, true); assert.equal(result.status, "applied");
    assert.equal(readFileSync(file, "utf8"), "after");
  } finally { fixture.cleanup(); }
});

test("occupied additions, link redirection and hard links never overwrite other files", options, async () => {
  const fixture = createFixture(false), guard = new WindowsFileGuard(shell, fixture.root);
  const outside = path.join(fixture.root, "outside"); mkdirSync(outside);
  const sentinel = path.join(outside, "sentinel.txt"); writeFileSync(sentinel, "keep");
  const junction = path.join(fixture.project, "redirect"), hard = path.join(fixture.project, "hard.txt");
  try {
    const occupied = await guard.apply(fixture.project, "invoice.mjs", null, Buffer.from("overwrite"));
    assert.deepEqual(occupied, { status: "refused", code: "GUARD_EXISTS", mayHaveChanged: false });
    symlinkSync(outside, junction, "junction");
    const redirect = await guard.apply(fixture.project, "redirect/sentinel.txt", contentHash("keep"), Buffer.from("lost"));
    assert.deepEqual(redirect, { status: "refused", code: "GUARD_TYPE_REFUSED", mayHaveChanged: false });
    await assert.rejects(guard.capture(fixture.project), /TYPE_REFUSED/);
    unlinkSync(junction);
    linkSync(sentinel, hard);
    assert.equal((await guard.apply(fixture.project, "hard.txt", contentHash("keep"), Buffer.from("lost"))).code, "GUARD_TYPE_REFUSED");
    await assert.rejects(guard.capture(fixture.project), /TYPE_REFUSED/);
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
  } finally { if (existsSync(junction)) unlinkSync(junction); if (existsSync(hard)) unlinkSync(hard); fixture.cleanup(); }
});

test("unsupported content and excluded candidate files refuse review without original writes", options, async () => {
  const fixture = createFixture(false), state = path.join(fixture.root, "state"); mkdirSync(state);
  const guard = new WindowsFileGuard(shell, fixture.root), baseline = snapshot(fixture.project);
  const task = await prepareReviewWorkspace(fixture.project, state, guard);
  try {
    writeFileSync(path.join(task.workspace, ".env.local"), "synthetic exclusion");
    await assert.rejects(task.seal(), /EXCLUDED_CHANGE/);
    unlinkSync(path.join(task.workspace, ".env.local"));
    writeFileSync(path.join(task.workspace, "binary.bin"), Buffer.from([0, 255]));
    await assert.rejects(task.seal(), /BINARY_CHANGE/);
    assert.deepEqual(snapshot(fixture.project), baseline);
  } finally { task.close(); fixture.cleanup(); }
});

test("bounded binary assets survive the copy unchanged and cannot become writable proposals", options, async () => {
  const fixture = createFixture(false), state = path.join(fixture.root, "state"); mkdirSync(state);
  const asset = path.join(fixture.project, "asset.bin"), bytes = Buffer.from([137, 80, 78, 71, 0, 255]); writeFileSync(asset, bytes);
  const guard = new WindowsFileGuard(shell, fixture.root), task = await prepareReviewWorkspace(fixture.project, state, guard);
  try {
    assert.deepEqual(task.readOnlyAssets, ["asset.bin"]);
    assert.deepEqual(readFileSync(path.join(task.workspace, "asset.bin")), bytes);
    writeFileSync(path.join(task.workspace, "asset.bin"), "changed into text");
    await assert.rejects(task.seal(), /BINARY_CHANGE/);
    unlinkSync(path.join(task.workspace, "asset.bin"));
    await assert.rejects(task.seal(), /BINARY_CHANGE/);
    writeFileSync(path.join(task.workspace, "asset.bin"), bytes);
    writeFileSync(path.join(task.workspace, "README.md"), "Updated project instructions\n");
    const review = await task.seal();
    assert.deepEqual(review.readOnlyAssets, ["asset.bin"]);
    assert.deepEqual(review.changes.map(change => change.relative), ["README.md"]);
    assert.equal((await task.apply(review.id, ["README.md"]))[0]?.status, "applied");
    assert.deepEqual(readFileSync(asset), bytes);
  } finally { task.close(); fixture.cleanup(); }
});

test("empty UTF-8 files are valid and unsafe relative paths are refused", options, async () => {
  const fixture = createFixture(false), guard = new WindowsFileGuard(shell, fixture.root);
  try {
    const before = contentHash(readFileSync(fixture.sourceFile));
    assert.equal((await guard.apply(fixture.project, "invoice.mjs", before, Buffer.alloc(0))).status, "applied");
    assert.equal(readFileSync(fixture.sourceFile).length, 0);
    assert.equal((await guard.apply(fixture.project, "empty new.txt", null, Buffer.alloc(0))).status, "applied");
    assert.equal(readFileSync(path.join(fixture.project, "empty new.txt")).length, 0);
    assert.equal((await guard.apply(fixture.project, "new folder/子目录/source.txt", null, Buffer.from("new source"))).status, "applied");
    assert.equal(readFileSync(path.join(fixture.project, "new folder/子目录/source.txt"), "utf8"), "new source");
    for (const relative of ["../outside.txt", "invoice.mjs:stream", ".git/config", "CON.txt"]) {
      const outcome = await guard.apply(fixture.project, relative, null, Buffer.from("refuse"));
      assert.equal(outcome.status, "refused"); assert.match(outcome.code!, /PATH_REFUSED|EXCLUDED/);
    }
  } finally { fixture.cleanup(); }
});

test("interrupted addition leaves durable evidence, blocks replay and retains the project lock after restart", options, async () => {
  const fixture = createFixture(false), state = path.join(fixture.root, "state"); mkdirSync(state);
  const script = `
    import {prepareReviewWorkspace} from './dist/validation/review-workspace.js';
    import {WindowsFileGuard} from './dist/validation/windows-file-guard.js';
    import {writeFileSync} from 'node:fs';
    import path from 'node:path';
    const task=await prepareReviewWorkspace(${JSON.stringify(fixture.project)},${JSON.stringify(state)},new WindowsFileGuard(${JSON.stringify(shell)},${JSON.stringify(fixture.root)}));
    writeFileSync(path.join(task.workspace,'interrupted.txt'),'complete candidate');
    const review=await task.seal();
    const result=await task.apply(review.id,['interrupted.txt'],()=>{throw new Error('synthetic cancellation after CREATE_NEW');});
    if(result[0]?.status!=='needs-reconcile') process.exit(2);
    let closeRefused=false; try {task.close();}catch{closeRefused=true;}
    if(!closeRefused) process.exit(3);
    console.log(JSON.stringify({taskDirectory:task.taskDirectory}));
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: isolatedEnvironment(fixture.root, process.env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(code, 0);
    const result = JSON.parse(output.trim()) as { taskDirectory: string };
    assert.equal(readFileSync(path.join(fixture.project, "interrupted.txt")).length, 0);
    const journal = readFileSync(path.join(result.taskDirectory, "private/apply.jsonl"), "utf8");
    const guard = new WindowsFileGuard(shell, fixture.root);
    const tree = await guard.capture(fixture.project);
    const pending = inspectApplyJournal(journal, new Map(tree.files.map(file => [file.relative, file.sha256])));
    assert.equal(pending.length, 1); assert.equal(pending[0]?.observation, "diverged");
    assert.equal(pending[0]?.action, "needs-reconcile");
    assert.ok(readFileSync(path.join(result.taskDirectory, "private/frozen.json"), "utf8").includes(Buffer.from("complete candidate").toString("base64")));
    await assert.rejects(prepareReviewWorkspace(fixture.project, state, guard), /PROJECT_LOCK_BUSY_RECONCILE/);
    assert.equal(readFileSync(path.join(fixture.project, "interrupted.txt")).length, 0);
  } finally { clearTimeout(timer); fixture.cleanup(); }
});

test("a mid-write process and coordinator exit preserves partial bytes and durable reconciliation evidence", options, async () => {
  const fixture = createFixture(false), state = path.join(fixture.root, "state"); mkdirSync(state);
  const file = path.join(fixture.project, "interrupted.txt"), before = "a".repeat(256 * 1024), after = "b".repeat(256 * 1024);
  writeFileSync(file, before);
  const child = spawn(process.execPath, [path.resolve("dist/validation/apply-interruption-worker.js"), fixture.project, state, fixture.root, shell],
    { cwd: process.cwd(), env: isolatedEnvironment(fixture.root, process.env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(code, 17);
    const result = JSON.parse(output.trim()) as { taskDirectory: string };
    const actual = readFileSync(file, "utf8");
    assert.equal(actual, after.slice(0, after.length / 2) + before.slice(before.length / 2));
    const journal = readFileSync(path.join(result.taskDirectory, "private/apply.jsonl"), "utf8");
    assert.ok(!journal.includes('"type":"result"'));
    const guard = new WindowsFileGuard(shell, fixture.root), captured = await guard.capture(fixture.project);
    const pending = inspectApplyJournal(journal, new Map(captured.files.map(entry => [entry.relative, entry.sha256])));
    assert.deepEqual(pending.map(item => [item.relative, item.observation, item.action]), [["interrupted.txt", "diverged", "needs-reconcile"]]);
    const baseline = JSON.parse(readFileSync(path.join(result.taskDirectory, "private/baseline.json"), "utf8")) as { files: { relative: string; base64: string }[] };
    const frozen = JSON.parse(readFileSync(path.join(result.taskDirectory, "private/frozen.json"), "utf8")) as typeof baseline;
    assert.equal(Buffer.from(baseline.files.find(entry => entry.relative === "interrupted.txt")!.base64, "base64").toString(), before);
    assert.equal(Buffer.from(frozen.files.find(entry => entry.relative === "interrupted.txt")!.base64, "base64").toString(), after);
    await assert.rejects(prepareReviewWorkspace(fixture.project, state, guard), /PROJECT_LOCK_BUSY_RECONCILE/);
    assert.equal(readFileSync(file, "utf8"), actual);
  } finally { clearTimeout(timer); fixture.cleanup(); }
});
