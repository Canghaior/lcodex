import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { createRunDirectory } from "./run-directory.js";
import { terminateOwnedProcessTree } from "./process-tree-stop.js";
import { createProcessTreeFixture, verifyTreeStopped, waitForProcessTree } from "./workflow-lifecycle.js";

test("forced Windows cleanup ends the owned parent, child and grandchild before delayed writes", { timeout: 20000 }, async () => {
  const run = createRunDirectory("forced tree 中文");
  createProcessTreeFixture(run.root, 3000);
  const child = spawn(process.execPath, [path.join(run.root, "process-tree.mjs"), "parent"],
    { cwd: run.root, windowsHide: true, stdio: "ignore" });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let clean = false;
  try {
    const tree = await waitForProcessTree(run.root);
    await terminateOwnedProcessTree(child);
    await closed;
    assert.deepEqual(await verifyTreeStopped(run.root, tree, 3000), { processCount: 3, allEnded: true, noLateWrites: true });
    // An already-ended child handle cannot target a subsequently reused PID.
    await terminateOwnedProcessTree(child);
    clean = true;
  } finally {
    if (child.exitCode === null && child.signalCode === null) await terminateOwnedProcessTree(child);
    if (clean) run.cleanup();
  }
});
