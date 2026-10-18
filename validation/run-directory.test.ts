import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRunDirectory } from "./run-directory.js";

test("cleanup removes only its own run and preserves neighbouring state", () => {
  const run = createRunDirectory("cleanup-test");
  const neighbour = createRunDirectory("keep-test");
  writeFileSync(path.join(neighbour.root, "keep.txt"), "preserve");
  mkdirSync(path.join(run.root, "nested"));
  writeFileSync(path.join(run.root, "nested/output.txt"), "generated");
  run.cleanup();
  assert.equal(existsSync(run.root), false);
  assert.equal(existsSync(path.join(neighbour.root, "keep.txt")), true);
  neighbour.cleanup();
});

test("cleanup refuses a junction without following or deleting its target", () => {
  const run = createRunDirectory("link-test");
  const target = createRunDirectory("link-target");
  const link = path.join(run.root, "redirect");
  writeFileSync(path.join(target.root, "keep.txt"), "preserve");
  try {
    symlinkSync(target.root, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => run.cleanup(), /LINK_REFUSED/);
    assert.equal(existsSync(path.join(target.root, "keep.txt")), true);
  } finally {
    if (existsSync(link)) unlinkSync(link);
    run.cleanup();
    target.cleanup();
  }
});

test("run names cannot supply a traversal path", () => {
  assert.throws(() => createRunDirectory("../state"), /INVALID_PREFIX/);
});

test("Chinese and space paths are actually removed, not just reported successful", () => {
  const run = createRunDirectory("清理 中文 路径");
  mkdirSync(path.join(run.root, "子目录 with spaces"));
  writeFileSync(path.join(run.root, "子目录 with spaces", "样本.txt"), "synthetic");
  run.cleanup();
  assert.equal(existsSync(run.root), false);
});
