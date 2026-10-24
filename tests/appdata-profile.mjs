import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// The only fixture that needs to live outside .local/runs: reproduce Windows
// AppData virtualization. Never use, rename or delete the user's lcodex profile.
export function createAppDataProfile(run) {
  const name = "lcodex-test-" + randomUUID();
  const logical = path.join(process.env.APPDATA, name);
  mkdirSync(logical);
  // Windows may redirect this newly created child while leaving the AppData
  // root itself unredirected. Retain the actual parent captured at creation.
  const native = realpathSync.native(logical), parent = path.dirname(native);
  assert.equal(path.basename(native), name);
  const marker = JSON.stringify({ kind: "generated-appdata-acceptance", run: run.root, name });
  writeFileSync(path.join(native, ".lcodex-test.json"), marker);
  return { logical, native, cleanup() {
    assert.equal(path.dirname(native).toLowerCase(), parent.toLowerCase());
    assert.equal(path.basename(native), name);
    assert.equal(realpathSync.native(logical).toLowerCase(), native.toLowerCase());
    assert.equal(readFileSync(path.join(native, ".lcodex-test.json"), "utf8"), marker);
    const check = directory => {
      assert.equal(lstatSync(directory).isSymbolicLink(), false);
      for (const entry of readdirSync(directory)) {
        const child = path.join(directory, entry), stat = lstatSync(child);
        assert.equal(stat.isSymbolicLink(), false);
        if (stat.isDirectory()) check(child); else { assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1); }
      }
    };
    check(native);
    const remove = directory => {
      for (const entry of readdirSync(directory)) {
        const child = path.join(directory, entry);
        if (lstatSync(child).isDirectory()) remove(child); else unlinkSync(child);
      }
      rmdirSync(directory);
    };
    // Caller has confirmed its own application and task processes exited.
    remove(native); assert.equal(existsSync(logical), false);
  } };
}
