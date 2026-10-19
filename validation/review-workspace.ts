import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireProjectWriteLock } from "./project-write-lock.js";
import { CapturedTree, contentHash, WindowsFileGuard } from "./windows-file-guard.js";

export type ReviewChange = { relative: string; before: string | null; after: string | null; kind: "add" | "modify" | "delete" };
export type FileOutcome = { relative: string; status: "applied" | "conflict" | "refused" | "needs-reconcile"; code?: string };
export type Review = { id: string; changes: ReviewChange[]; excluded: string[]; verificationLocation: "isolated-copy" };

function persist(file: string, bytes: string | Buffer) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function contents(tree: CapturedTree): Map<string, Buffer> {
  const result = new Map<string, Buffer>(), seen = new Set<string>();
  for (const entry of tree.files) {
    const parts = entry.relative.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part)) || seen.has(entry.relative.toLowerCase())) throw new Error("REVIEW_PATH_INVALID");
    seen.add(entry.relative.toLowerCase()); result.set(entry.relative, Buffer.from(entry.base64, "base64"));
  }
  return result;
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
  let active = true, unresolved = false, sealing = false, sealed: Review | undefined;
  let frozen = new Map<string, Buffer>();
  const completed = new Set<string>();
  try {
    const baseline = await guard.capture(root), before = contents(baseline);
    mkdirSync(taskDirectory);
    const workspace = path.join(taskDirectory, "workspace"), privateDir = path.join(taskDirectory, "private");
    mkdirSync(workspace); mkdirSync(privateDir);
    persist(path.join(privateDir, "baseline.json"), JSON.stringify({ taskId, projectId: lock.projectId, files: baseline.files, excluded: baseline.excluded }));
    for (const [relative, bytes] of before) {
      const destination = path.join(workspace, relative); mkdirSync(path.dirname(destination), { recursive: true }); persist(destination, bytes);
    }
    const rootMarker = `.lcodex-root-${taskId}`;
    const markerContent = taskId + "\n";
    persist(path.join(workspace, rootMarker), markerContent);
    const journal = path.join(privateDir, "apply.jsonl");
    persist(journal, JSON.stringify({ type: "created", taskId, projectId: lock.projectId }) + "\n");
    function record(value: object) {
      if (lstatSync(journal).isSymbolicLink()) throw new Error("REVIEW_JOURNAL_UNSAFE");
      const fd = openSync(journal, "a");
      try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    }
    function requireActive() { if (!active || unresolved || sealing) throw new Error("REVIEW_RECONCILE_REQUIRED"); }
    return {
      workspace, taskDirectory, rootMarker,
      async seal(): Promise<Review> {
        requireActive(); if (sealed) throw new Error("REVIEW_ALREADY_SEALED");
        sealing = true;
        try {
        const captured = await guard.capture(workspace);
        if (captured.excluded.length) throw new Error("REVIEW_EXCLUDED_CHANGE");
        frozen = contents(captured);
        if (frozen.get(rootMarker)?.toString("utf8") !== markerContent) throw new Error("REVIEW_ROOT_MARKER_CHANGED");
        frozen.delete(rootMarker);
        const changes: ReviewChange[] = [];
        for (const relative of [...new Set([...before.keys(), ...frozen.keys()])].sort()) {
          const oldBytes = before.get(relative), newBytes = frozen.get(relative);
          const oldHash = oldBytes === undefined ? null : contentHash(oldBytes), newHash = newBytes === undefined ? null : contentHash(newBytes);
          if (oldHash !== newHash) changes.push({ relative, before: oldHash, after: newHash, kind: oldHash === null ? "add" : newHash === null ? "delete" : "modify" });
        }
        const id = contentHash(JSON.stringify({ taskId, changes }));
        sealed = { id, changes, excluded: baseline.excluded, verificationLocation: "isolated-copy" };
        persist(path.join(privateDir, "frozen.json"), JSON.stringify({ id, files: captured.files.filter(file => file.relative !== rootMarker) }));
        persist(path.join(privateDir, "review.json"), JSON.stringify(sealed));
        record({ type: "sealed", reviewId: id });
        return structuredClone(sealed);
        } finally { sealing = false; }
      },
      // The review ID is the exact frozen version selected by the user. This does
      // not grant the model permission to call apply or to choose arbitrary paths.
      async apply(reviewId: string, selected: readonly string[], onLocked?: () => void): Promise<FileOutcome[]> {
        requireActive();
        if (!sealed || sealed.id !== reviewId || new Set(selected).size !== selected.length || selected.length === 0 ||
          selected.some(relative => !sealed!.changes.some(change => change.relative === relative) || completed.has(relative))) throw new Error("REVIEW_SELECTION_INVALID");
        const outcomes: FileOutcome[] = [];
        for (const relative of selected) {
          const change = sealed.changes.find(item => item.relative === relative)!;
          // Intent is durable BEFORE starting any write process. A lost response
          // or coordinator crash leaves an unresolved record, never an auto-retry.
          unresolved = true;
          try {
            record({ type: "intent", reviewId, ...change });
            const outcome = await guard.apply(root, relative, change.before, frozen.get(relative) ?? null, onLocked);
            // Any refusal may follow a partially created file. Conservatively stop
            // and retain baseline/journal unless the result is a known no-write case.
            const noWrite = outcome.status === "conflict" || outcome.status === "refused" && outcome.mayHaveChanged === false &&
              ["GUARD_MISSING", "GUARD_EXISTS", "GUARD_OPEN_REFUSED", "GUARD_TYPE_REFUSED", "GUARD_EXCLUDED", "GUARD_PATH_REFUSED"].includes(outcome.code ?? "");
            const final: FileOutcome = { relative, status: outcome.status === "applied" ? "applied" : noWrite ? outcome.status : "needs-reconcile", ...(outcome.code ? { code: outcome.code } : {}) };
            record({ type: "result", reviewId, ...final }); outcomes.push(final);
            if (final.status === "needs-reconcile") break;
            unresolved = false;
            // Every selection gets one attempt; an explicit new review is needed
            // for retries, including conflicts. Never silently apply a changed copy.
            completed.add(relative);
          } catch {
            outcomes.push({ relative, status: "needs-reconcile" });
            try { record({ type: "result", reviewId, relative, status: "needs-reconcile" }); } catch { /* intent remains */ }
            break;
          }
        }
        return outcomes;
      },
      close() {
        if (!active) throw new Error("REVIEW_ALREADY_CLOSED");
        if (unresolved || sealing) throw new Error("REVIEW_RECONCILE_REQUIRED");
        record({ type: "closed" }); lock.release(); active = false;
      },
      journal() { return readFileSync(journal, "utf8"); },
    };
  } catch (error) { lock.release(); throw error; }
}
