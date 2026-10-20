import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

// Only accept the ChildProcess handle returned by our own spawn. Killing just
// app-server can orphan its filesystem helper and keep the runtime image locked.
// This is a last resort, not proof that a task completed or can be replayed.
export async function terminateOwnedProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) throw new Error("ENGINE_PROCESS_ID_UNKNOWN");
  if (process.platform !== "win32") { child.kill(); return; }
  try {
    await promisify(execFile)(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  } catch {
    // The owned parent can finish naturally while taskkill starts. Never retry
    // a stale PID or expose command output; callers still verify process exit.
    if (child.exitCode === null && child.signalCode === null) throw new Error("ENGINE_TREE_STOP_FAILED");
  }
}
