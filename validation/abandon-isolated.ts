import { closeSync, existsSync, fsyncSync, openSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash, WindowsFileGuard } from "./windows-file-guard.js";
import { privatePath, readPrivate, writePrivate } from "./private-files.js";
import { inspectApplyJournal } from "./apply-journal.js";

export function assertNeverApplied(taskDirectory: string) {
  const journal = readPrivate(taskDirectory, "private/apply.jsonl");
  inspectApplyJournal(journal, new Map());
  const entries = journal.trimEnd().split("\n").map(line => JSON.parse(line));
  if (entries.some(entry => entry.type === "intent" || entry.type === "result")) throw new Error("TASK_ORIGINAL_WRITE_REQUIRES_RECONCILIATION");
  return { journal, entries };
}

// Explicit user disposition only. Caller must independently verify a clean
// engine exit and persisted terminal history. This does not recover any files or
// infer a tool's success; only a never-applied isolated attempt can be abandoned.
export async function abandonStoppedIsolatedWorkspace(project: string, state: string, taskDirectory: string, guard: WindowsFileGuard) {
  const root = realpathSync(project), storage = realpathSync(state), taskId = path.basename(taskDirectory);
  if (!/^[a-f0-9-]{36}$/.test(taskId) || path.resolve(taskDirectory).toLowerCase() !== path.join(storage, taskId).toLowerCase()) throw new Error("REVIEW_STORAGE_INVALID");
  const baseline = JSON.parse(readPrivate(taskDirectory, "private/baseline.json", 24 * 1024 * 1024));
  const projectId = contentHash(process.platform === "win32" ? root.toLowerCase() : root);
  if (baseline.taskId !== taskId || baseline.projectId !== projectId) throw new Error("REVIEW_PROJECT_CHANGED");
  const { journal, entries } = assertNeverApplied(taskDirectory);
  const lockRelative = `${projectId}.lock`, lockFile = privatePath(storage, lockRelative), marker = "private/abandoned.json";
  if (!existsSync(lockFile)) {
    const prior = JSON.parse(readPrivate(taskDirectory, marker));
    if (prior.taskId !== taskId || prior.projectId !== projectId || entries.at(-1)?.type !== "closed") throw new Error("TASK_ABANDON_RECONCILE_REQUIRED");
    return;
  }
  const lockText = readPrivate(storage, lockRelative), lock = JSON.parse(lockText);
  if (lock.version !== 1 || lock.projectId !== projectId || lock.ownerTaskId !== taskId || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.token !== "string") throw new Error("PROJECT_LOCK_OWNERSHIP_CHANGED");
  let ended = false;
  try { process.kill(lock.pid, 0); } catch (error) { ended = (error as NodeJS.ErrnoException).code === "ESRCH"; }
  if (!ended) throw new Error("PROJECT_LOCK_OWNER_ACTIVE");
  writePrivate(taskDirectory, marker, JSON.stringify({ taskId, projectId, journalHash: contentHash(journal), reason: "explicit-user-abandonment" }));
  if (entries.at(-1)?.type !== "closed") {
    const fd = openSync(privatePath(taskDirectory, "private/apply.jsonl"), "a");
    try { writeFileSync(fd, '{"type":"closed"}\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const removed = await guard.apply(storage, lockRelative, contentHash(lockText), null);
  if (removed.status !== "applied") throw new Error("PROJECT_LOCK_RELEASE_RECONCILE_REQUIRED");
}
