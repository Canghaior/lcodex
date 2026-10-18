import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Coordinates trusted clients. It does not prevent an editor or arbitrary shell
// from changing project files and is not a replacement for filesystem isolation.
export function acquireProjectWriteLock(stateDirectory: string, projectDirectory: string) {
  const state = path.resolve(stateDirectory);
  const parsed = path.parse(state);
  let ancestor = parsed.root;
  for (const part of state.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    const stat = lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("PROJECT_LOCK_STATE_UNSAFE");
  }
  if (!lstatSync(realpathSync(projectDirectory)).isDirectory()) throw new Error("PROJECT_LOCK_PROJECT_REQUIRED");
  const canonical = realpathSync(projectDirectory);
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const projectId = createHash("sha256").update(normalized).digest("hex");
  const lockFile = path.join(state, projectId + ".lock");
  const contents = JSON.stringify({ version: 1, projectId, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() });
  let fd: number;
  try { fd = openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("PROJECT_LOCK_BUSY_RECONCILE_REQUIRED");
    throw new Error("PROJECT_LOCK_ACQUIRE_FAILED");
  }
  try { writeFileSync(fd, contents); fsyncSync(fd); }
  catch { closeSync(fd); throw new Error("PROJECT_LOCK_INCOMPLETE_RECONCILE_REQUIRED"); }
  let active = true;
  return {
    projectId,
    release() {
      if (!active) throw new Error("PROJECT_LOCK_ALREADY_RELEASED");
      try {
        if (lstatSync(lockFile).isSymbolicLink() || readFileSync(lockFile, "utf8") !== contents) throw new Error("PROJECT_LOCK_OWNERSHIP_CHANGED");
        unlinkSync(lockFile);
      } catch { throw new Error("PROJECT_LOCK_RELEASE_RECONCILE_REQUIRED"); }
      finally { active = false; closeSync(fd); }
    },
  };
}
