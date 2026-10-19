import { isObject } from "./rpc.js";

type Intent = { relative: string; before: string | null; after: string | null };
export type PendingApplication = Intent & { observation: "matches-before" | "matches-after" | "diverged"; action: "needs-reconcile" };
const hashOrNull = (value: unknown): value is string | null => value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// Read-only recovery assessment. Matching bytes is evidence, never authorization
// to retry a command, roll back, release a stale project lock or discard a baseline.
export function inspectApplyJournal(text: string, currentHashes: ReadonlyMap<string, string>): PendingApplication[] {
  if (Buffer.byteLength(text) > 1024 * 1024 || !text.endsWith("\n")) throw new Error("APPLY_JOURNAL_INCOMPLETE");
  let entries: unknown[];
  try { entries = text.trimEnd().split("\n").map(line => JSON.parse(line) as unknown); }
  catch { throw new Error("APPLY_JOURNAL_INVALID"); }
  if (!isObject(entries[0]) || entries[0].type !== "created") throw new Error("APPLY_JOURNAL_INVALID");
  const unresolved = new Map<string, Intent>(), seen = new Set<string>(), resultSeen = new Set<string>();
  let reviewId: string | undefined, closed = false;
  for (const entry of entries.slice(1)) {
    if (closed || !isObject(entry)) throw new Error("APPLY_JOURNAL_INVALID");
    if (entry.type === "sealed" && !reviewId && typeof entry.reviewId === "string" && /^[a-f0-9]{64}$/.test(entry.reviewId)) { reviewId = entry.reviewId; continue; }
    if (entry.type === "closed" && unresolved.size === 0) { closed = true; continue; }
    if (!reviewId || entry.reviewId !== reviewId || typeof entry.relative !== "string" || !entry.relative ||
      entry.relative.split("/").some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) throw new Error("APPLY_JOURNAL_INVALID");
    if (entry.type === "intent") {
      if (unresolved.size || !hashOrNull(entry.before) || !hashOrNull(entry.after) || entry.before === entry.after || seen.has(entry.relative)) throw new Error("APPLY_JOURNAL_INVALID");
      seen.add(entry.relative); unresolved.set(entry.relative, { relative: entry.relative, before: entry.before, after: entry.after });
    } else if (entry.type === "result" && unresolved.has(entry.relative) && !resultSeen.has(entry.relative)) {
      resultSeen.add(entry.relative);
      if (["applied", "conflict", "refused"].includes(String(entry.status))) unresolved.delete(entry.relative);
      else if (entry.status !== "needs-reconcile") throw new Error("APPLY_JOURNAL_INVALID");
    } else throw new Error("APPLY_JOURNAL_INVALID");
  }
  return [...unresolved.values()].map(intent => {
    const actual = currentHashes.get(intent.relative) ?? null;
    return { ...intent, observation: actual === intent.after ? "matches-after" : actual === intent.before ? "matches-before" : "diverged", action: "needs-reconcile" };
  });
}
