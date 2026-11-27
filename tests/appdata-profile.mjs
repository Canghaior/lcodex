import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// The only fixture that needs to live outside .local/runs: reproduce Windows
// AppData virtualization. Never use, rename or delete the user's lcodex profile.
export function createAppDataProfile(run, minimumNativeLength = 0) {
  const name = "lcodex-test-" + randomUUID();
  const logicalRoot = path.join(process.env.APPDATA, name);
  mkdirSync(logicalRoot);
  // Windows may redirect this newly created child while leaving the AppData
  // root itself unredirected. Retain the actual parent captured at creation.
  const nativeRoot = realpathSync.native(logicalRoot), parent = path.dirname(nativeRoot);
  assert.equal(path.basename(nativeRoot), name);
  const marker = JSON.stringify({ kind: "generated-appdata-acceptance", run: run.root, name });
  writeFileSync(path.join(nativeRoot, ".lcodex-test.json"), marker);
  // Approximate the longer native path seen with redirected AppData, even on
  // a test host that does not currently redirect it. Never use a real profile.
  const padding = minimumNativeLength > nativeRoot.length ? "d".repeat(Math.max(1, minimumNativeLength - nativeRoot.length - 1)) : "";
  const logical = padding ? path.join(logicalRoot, padding) : logicalRoot;
  if (padding) mkdirSync(logical);
  const native = realpathSync.native(logical);
  assert.equal(native, padding ? path.join(nativeRoot, padding) : nativeRoot);
  assert.ok(native.length >= minimumNativeLength);
  return { logical, native, cleanup() {
    assert.equal(path.dirname(nativeRoot).toLowerCase(), parent.toLowerCase());
    assert.equal(path.basename(nativeRoot), name);
    assert.equal(realpathSync.native(logicalRoot).toLowerCase(), nativeRoot.toLowerCase());
    assert.equal(readFileSync(path.join(nativeRoot, ".lcodex-test.json"), "utf8"), marker);
    const check = directory => {
      assert.equal(lstatSync(directory).isSymbolicLink(), false);
      for (const entry of readdirSync(directory)) {
        const child = path.join(directory, entry), stat = lstatSync(child);
        assert.equal(stat.isSymbolicLink(), false);
        if (stat.isDirectory()) check(child); else { assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1); }
      }
    };
    check(nativeRoot);
    const remove = directory => {
      for (const entry of readdirSync(directory)) {
        const child = path.join(directory, entry);
        if (lstatSync(child).isDirectory()) remove(child); else unlinkSync(child);
      }
      rmdirSync(directory);
    };
    // Caller has confirmed its own application and task processes exited.
    remove(nativeRoot); assert.equal(existsSync(logicalRoot), false);
  } };
}
