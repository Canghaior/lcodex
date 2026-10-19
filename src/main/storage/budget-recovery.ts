import path from "node:path";
import { readPrivate } from "../../../validation/private-files.js";
import { contentHash, type WindowsFileGuard } from "../../../validation/windows-file-guard.js";

// Explicit action, only after the coordinator has no in-flight requests. The
// reservation remains in the ledger; recovering a dead lock does not refund it.
export async function recoverBudgetLock(file: string, guard: WindowsFileGuard) {
  const directory = path.dirname(file), relative = path.basename(file) + ".lock";
  let contents: string, lock;
  try { contents = readPrivate(directory, relative); lock = JSON.parse(contents); }
  catch { throw new Error("BUDGET_LOCK_UNVERIFIED"); }
  if (lock.version !== 1 || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !/^[a-f0-9-]{36}$/.test(lock.token)) throw new Error("BUDGET_LOCK_UNVERIFIED");
  let ended = false;
  try { process.kill(lock.pid, 0); } catch (error) { ended = (error as NodeJS.ErrnoException).code === "ESRCH"; }
  if (!ended) throw new Error("BUDGET_LOCK_OWNER_ACTIVE");
  const result = await guard.apply(directory, relative, contentHash(contents), null);
  if (result.status !== "applied") throw new Error("BUDGET_LOCK_UNVERIFIED");
}
