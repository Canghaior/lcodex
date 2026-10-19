import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireProjectWriteLock } from "./project-write-lock.js";
import { CapturedTree, contentHash, WindowsFileGuard } from "./windows-file-guard.js";
import { inspectApplyJournal } from "./apply-journal.js";
import { privatePath, readPrivate } from "./private-files.js";

export type ReviewChange = { relative: string; before: string | null; after: string | null; kind: "add" | "modify" | "delete" };
export type FileOutcome = { relative: string; status: "applied" | "conflict" | "refused" | "needs-reconcile"; code?: string };
export type Review = { id: string; changes: ReviewChange[]; excluded: string[]; readOnlyAssets: string[]; readOnlyDirectories: string[]; verificationLocation: "isolated-copy" };

function persist(file: string, bytes: string | Buffer) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function contents(tree: CapturedTree): Map<string, Buffer> {
  const result = new Map<string, Buffer>(), seen = new Set<string>();
  for (const entry of tree.files) {
    const parts = entry.relative.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part)) || seen.has(entry.relative.toLowerCase())) throw new Error("REVIEW_PATH_INVALID");
    const bytes = Buffer.from(entry.base64, "base64");
    if (contentHash(bytes) !== entry.sha256) throw new Error("REVIEW_CONTENT_CHANGED");
    seen.add(entry.relative.toLowerCase()); result.set(entry.relative, bytes);
  }
  return result;
}

function changesBetween(before: Map<string, Buffer>, after: Map<string, Buffer>): ReviewChange[] {
  const changes: ReviewChange[] = [];
  for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldBytes = before.get(relative), newBytes = after.get(relative);
    const oldHash = oldBytes === undefined ? null : contentHash(oldBytes), newHash = newBytes === undefined ? null : contentHash(newBytes);
    if (oldHash !== newHash) changes.push({ relative, before: oldHash, after: newHash, kind: oldHash === null ? "add" : newHash === null ? "delete" : "modify" });
  }
  return changes;
}
type Lifecycle = { active: boolean; unresolved: boolean; sealing: boolean };
function requireActive(state: Lifecycle) { if (!state.active || state.unresolved || state.sealing) throw new Error("REVIEW_RECONCILE_REQUIRED"); }
function reviewAccess(root: string, privateDir: string, guard: WindowsFileGuard, lock: ReturnType<typeof acquireProjectWriteLock>,
  state: Lifecycle, getReview: () => Review | undefined, getFrozen: () => Map<string, Buffer>, completed = new Set<string>()) {
  const journal = path.join(privateDir, "apply.jsonl");
  function record(value: object) {
    privatePath(privateDir, "apply.jsonl");
    const fd = openSync(journal, "a");
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  return {
    record,
    async apply(reviewId: string, selected: readonly string[], onLocked?: () => void): Promise<FileOutcome[]> {
      requireActive(state);
      const sealed = getReview(), frozen = getFrozen();
      if (!sealed || sealed.id !== reviewId || new Set(selected).size !== selected.length || selected.length === 0 ||
        selected.some(relative => !sealed.changes.some(change => change.relative === relative) || completed.has(relative))) throw new Error("REVIEW_SELECTION_INVALID");
      const outcomes: FileOutcome[] = [];
      for (const relative of selected) {
        const change = sealed.changes.find(item => item.relative === relative)!;
        // Persist intent before any original-project write. Unknown results retain
        // the lock and cannot be suspended, replayed, discarded or silently retried.
        state.unresolved = true;
        try {
          record({ type: "intent", reviewId, ...change });
          const outcome = await guard.apply(root, relative, change.before, frozen.get(relative) ?? null, onLocked);
          const noWrite = outcome.status === "conflict" || outcome.status === "refused" && outcome.mayHaveChanged === false &&
            ["GUARD_MISSING", "GUARD_EXISTS", "GUARD_OPEN_REFUSED", "GUARD_TYPE_REFUSED", "GUARD_EXCLUDED", "GUARD_PATH_REFUSED", "GUARD_PATH_ALIAS_REFUSED", "GUARD_FINAL_PATH_FAILED"].includes(outcome.code ?? "");
          const final: FileOutcome = { relative, status: outcome.status === "applied" ? "applied" : noWrite ? outcome.status : "needs-reconcile", ...(outcome.code ? { code: outcome.code } : {}) };
          record({ type: "result", reviewId, ...final }); outcomes.push(final);
          if (final.status === "needs-reconcile") break;
          state.unresolved = false; completed.add(relative);
        } catch {
          outcomes.push({ relative, status: "needs-reconcile" });
          try { record({ type: "result", reviewId, relative, status: "needs-reconcile" }); } catch { /* intent remains */ }
          break;
        }
      }
      return outcomes;
    },
    suspend() {
      requireActive(state);
      const review = getReview(); if (!review) throw new Error("REVIEW_NOT_SEALED");
      const files = ["baseline.json", "frozen.json", "review.json", "apply.jsonl"];
      const hashes = Object.fromEntries(files.map(file => [file, contentHash(readPrivate(privateDir, file, file.endsWith("jsonl") ? 1024 * 1024 : 24 * 1024 * 1024))]));
      persist(privatePath(privateDir, "suspended.json"), JSON.stringify({ version: 1, reviewId: review.id, hashes }));
      lock.release(); state.active = false;
    },
    close() {
      if (!state.active) throw new Error("REVIEW_ALREADY_CLOSED");
      requireActive(state); record({ type: "closed" }); lock.release(); state.active = false;
    },
    journal() { return readPrivate(privateDir, "apply.jsonl"); },
  };
}

// Only a completed, orderly suspended review can be reopened. A crash with an
// active lock or incomplete journal is deliberately not treated as a handoff.
export function restoreReviewWorkspace(project: string, state: string, taskDirectory: string, expectedReviewId: string, guard: WindowsFileGuard) {
  const root = realpathSync(project), storage = realpathSync(state), taskId = path.basename(taskDirectory);
  if (!/^[a-f0-9-]{36}$/.test(taskId) || path.resolve(taskDirectory).toLowerCase() !== path.join(storage, taskId).toLowerCase()) throw new Error("REVIEW_STORAGE_INVALID");
  const privateDir = path.join(taskDirectory, "private");
  if (!existsSync(privatePath(privateDir, "suspended.json"))) throw new Error("REVIEW_RECONCILE_REQUIRED");
  const suspension = JSON.parse(readPrivate(privateDir, "suspended.json"));
  if (suspension.version !== 1 || suspension.reviewId !== expectedReviewId) throw new Error("REVIEW_RECONCILE_REQUIRED");
  const read = (file: string) => {
    const text = readPrivate(privateDir, file, file.endsWith("jsonl") ? 1024 * 1024 : 24 * 1024 * 1024);
    if (contentHash(text) !== suspension.hashes?.[file]) throw new Error("REVIEW_CONTENT_CHANGED");
    return text;
  };
  const baseline = JSON.parse(read("baseline.json")), captured = JSON.parse(read("frozen.json"));
  const sealed: Review = JSON.parse(read("review.json")), journal = read("apply.jsonl");
  const before = contents(baseline), frozen = contents(captured), changes = changesBetween(before, frozen);
  const id = contentHash(JSON.stringify({ taskId, changes }));
  if (baseline.taskId !== taskId || captured.id !== id || sealed.id !== id || expectedReviewId !== id ||
    JSON.stringify(changes) !== JSON.stringify(sealed.changes) || changes.some(change => sealed.readOnlyAssets.includes(change.relative))) throw new Error("REVIEW_CONTENT_CHANGED");
  if (inspectApplyJournal(journal, new Map()).length) throw new Error("REVIEW_RECONCILE_REQUIRED");
  const records = journal.trimEnd().split("\n").map(line => JSON.parse(line));
  if (records[0]?.taskId !== taskId || records[0]?.projectId !== baseline.projectId ||
    records.some(record => record.type === "closed" || record.reviewId && record.reviewId !== id)) throw new Error("REVIEW_RECONCILE_REQUIRED");
  const completed = new Set<string>();
  const outcomes: FileOutcome[] = [];
  for (const record of records) {
    if (record.type === "intent") {
      const change = changes.find(change => change.relative === record.relative);
      if (!change || change.before !== record.before || change.after !== record.after) throw new Error("REVIEW_JOURNAL_INVALID");
    }
    if (record.type === "result") { completed.add(record.relative); outcomes.push({ relative: record.relative, status: record.status }); }
  }
  const lock = acquireProjectWriteLock(storage, root);
  try {
    if (lock.projectId !== baseline.projectId) throw new Error("REVIEW_PROJECT_CHANGED");
    // Consume handoff only after exclusively acquiring the project. If this
    // coordinator now crashes, the new lock blocks automatic recovery again.
    unlinkSync(privatePath(privateDir, "suspended.json"));
    const lifecycle: Lifecycle = { active: true, unresolved: false, sealing: false };
    const { record: _record, ...access } = reviewAccess(root, privateDir, guard, lock, lifecycle, () => sealed, () => frozen, completed);
    return { workspace: path.join(taskDirectory, "workspace"), taskDirectory, rootMarker: `.lcodex-root-${taskId}`,
      readOnlyAssets: sealed.readOnlyAssets, readOnlyDirectories: sealed.readOnlyDirectories, review: structuredClone(sealed), outcomes,
      async seal(): Promise<Review> { throw new Error("REVIEW_ALREADY_SEALED"); }, ...access };
  } catch (error) { lock.release(); throw error; }
}

// A bounded P1 coordinator, not a renderer-accessible arbitrary filesystem API.
// Caller must enforce OS sandbox isolation and verify engine/process termination
// before seal(); keeping baseline and frozen content outside cwd alone is insufficient.
export async function prepareReviewWorkspace(project: string, state: string, guard: WindowsFileGuard) {
  const root = realpathSync(project), storage = realpathSync(state);
  const relativeStorage = path.relative(root, storage);
  if (!relativeStorage.startsWith(".." + path.sep) && relativeStorage !== ".." && !path.isAbsolute(relativeStorage)) throw new Error("REVIEW_STORAGE_INSIDE_PROJECT");
  const disk = statfsSync(storage);
  if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw new Error("REVIEW_DISK_LOW");
  const lock = acquireProjectWriteLock(storage, root);
  const taskId = randomUUID(), taskDirectory = path.join(storage, taskId);
  const lifecycle: Lifecycle = { active: true, unresolved: false, sealing: false };
  let sealed: Review | undefined;
  let frozen = new Map<string, Buffer>();
  try {
    const baseline = await guard.capture(root), before = contents(baseline);
    const assets = new Set(baseline.files.filter(file => file.kind === "binary").map(file => file.relative));
    const dependencyRoot = path.join(root, "node_modules");
    const dependencies = existsSync(dependencyRoot) ? await guard.captureDependencies(dependencyRoot) : undefined;
    if (dependencies?.excluded.length) throw new Error("REVIEW_DEPENDENCY_SENSITIVE_CONTENT");
    const dependencyFiles = dependencies ? contents(dependencies) : undefined;
    const dependencyFingerprint = (tree: CapturedTree) => contentHash(JSON.stringify(tree.files.map(file => [file.relative, file.sha256]).sort()));
    const dependencyHash = dependencies ? dependencyFingerprint(dependencies) : undefined;
    const readOnlyDirectories = dependencies ? ["node_modules"] : [];
    mkdirSync(taskDirectory);
    const workspace = path.join(taskDirectory, "workspace"), privateDir = path.join(taskDirectory, "private");
    mkdirSync(workspace); mkdirSync(privateDir);
    persist(path.join(privateDir, "baseline.json"), JSON.stringify({ taskId, projectId: lock.projectId, files: baseline.files, excluded: baseline.excluded }));
    for (const [relative, bytes] of before) {
      const destination = path.join(workspace, relative); mkdirSync(path.dirname(destination), { recursive: true }); persist(destination, bytes);
    }
    if (dependencyFiles) {
      mkdirSync(path.join(workspace, "node_modules"));
      persist(path.join(privateDir, "dependencies.json"), JSON.stringify({ sha256: dependencyHash, files: dependencies!.files.map(({ relative, sha256 }) => ({ relative, sha256 })) }));
      for (const [relative, bytes] of dependencyFiles) {
        const destination = path.join(workspace, "node_modules", relative); mkdirSync(path.dirname(destination), { recursive: true }); persist(destination, bytes);
      }
    }
    const rootMarker = `.lcodex-root-${taskId}`;
    const markerContent = taskId + "\n";
    persist(path.join(workspace, rootMarker), markerContent);
    const journal = path.join(privateDir, "apply.jsonl");
    persist(journal, JSON.stringify({ type: "created", taskId, projectId: lock.projectId }) + "\n");
    const { record, ...access } = reviewAccess(root, privateDir, guard, lock, lifecycle, () => sealed, () => frozen);
    return {
      workspace, taskDirectory, rootMarker, readOnlyAssets: [...assets], readOnlyDirectories, ...access,
      async seal(): Promise<Review> {
        requireActive(lifecycle); if (sealed) throw new Error("REVIEW_ALREADY_SEALED");
        lifecycle.sealing = true;
        try {
        const captured = await guard.capture(workspace);
        if (captured.excluded.some(relative => !(dependencies && relative.toLowerCase() === "node_modules"))) throw new Error("REVIEW_EXCLUDED_CHANGE");
        if (dependencies) {
          const currentDependencies = await guard.captureDependencies(path.join(workspace, "node_modules"));
          if (currentDependencies.excluded.length || dependencyFingerprint(currentDependencies) !== dependencyHash) throw new Error("REVIEW_DEPENDENCY_CHANGED");
        }
        frozen = contents(captured);
        if (captured.files.some(file => file.kind === "binary" && !assets.has(file.relative)) || [...assets].some(relative =>
          !frozen.has(relative) || contentHash(frozen.get(relative)!) !== contentHash(before.get(relative)!))) throw new Error("REVIEW_BINARY_CHANGE");
        if (frozen.get(rootMarker)?.toString("utf8") !== markerContent) throw new Error("REVIEW_ROOT_MARKER_CHANGED");
        frozen.delete(rootMarker);
        const changes = changesBetween(before, frozen);
        const id = contentHash(JSON.stringify({ taskId, changes }));
        sealed = { id, changes, excluded: baseline.excluded, readOnlyAssets: [...assets], readOnlyDirectories, verificationLocation: "isolated-copy" };
        persist(path.join(privateDir, "frozen.json"), JSON.stringify({ id, files: captured.files.filter(file => file.relative !== rootMarker) }));
        persist(path.join(privateDir, "review.json"), JSON.stringify(sealed));
        record({ type: "sealed", reviewId: id });
        return structuredClone(sealed);
        } finally { lifecycle.sealing = false; }
      },
    };
  } catch (error) { lock.release(); throw error; }
}
