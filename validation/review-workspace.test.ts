import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createFixture, snapshot } from "./fixtures.js";
import { prepareReviewWorkspace } from "./review-workspace.js";
import { contentHash, WindowsFileGuard } from "./windows-file-guard.js";

const shell = "C:/Users/lijin/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe";
const options = { skip: process.platform !== "win32" || !existsSync(shell), timeout: 90_000 };

for (const git of [false, true]) test(`isolated review: original preserved, frozen review applied, conflicts retained (git=${git})`, options, async () => {
  const fixture = createFixture(git), state = path.join(fixture.root, "state"); mkdirSync(state);
  const guard = new WindowsFileGuard(shell, fixture.root);
  const original = snapshot(fixture.project);
  const task = await prepareReviewWorkspace(fixture.project, state, guard);
  try {
    assert.equal(existsSync(path.join(task.workspace, ".env")), false);
    assert.equal(existsSync(path.join(task.workspace, ".git")), false);
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
    assert.deepEqual(occupied, { status: "refused", code: "GUARD_EXISTS" });
    symlinkSync(outside, junction, "junction");
    const redirect = await guard.apply(fixture.project, "redirect/sentinel.txt", contentHash("keep"), Buffer.from("lost"));
    assert.deepEqual(redirect, { status: "refused", code: "GUARD_TYPE_REFUSED" });
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
    await assert.rejects(task.seal(), /TEXT_LIMIT/);
    assert.deepEqual(snapshot(fixture.project), baseline);
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
    for (const relative of ["../outside.txt", "invoice.mjs:stream", ".git/config", "CON.txt"]) {
      const outcome = await guard.apply(fixture.project, relative, null, Buffer.from("refuse"));
      assert.equal(outcome.status, "refused"); assert.match(outcome.code!, /PATH_REFUSED|EXCLUDED/);
    }
  } finally { fixture.cleanup(); }
});
