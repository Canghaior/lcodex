import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFixture } from "./fixtures.js";
import { isolatedEnvironment } from "./isolated-env.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

// Disposable coordinator experiment, never a general file-recovery API.
async function scriptRun(shell: string, root: string, script: string, onLocked?: () => void, crashAtPartial = false) {
  const child = spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { cwd: root, env: isolatedEnvironment(root, process.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let pending = "", timedOut = false, deliberatelyKilled = false, callbackError: unknown;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1); lines.push(line);
      if (line === "LOCKED") {
        try { onLocked?.(); child.stdin.end("APPLY\n"); }
        catch (error) { callbackError = error; child.stdin.end("CANCEL\n"); }
      }
      if (line === "PARTIAL" && crashAtPartial) { deliberatelyKilled = child.kill(); }
    }
  });
  child.stderr.resume();
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
  if (callbackError) throw callbackError;
  check(!timedOut, "RECOVERY_PROCESS_TIMEOUT");
  return { code, lines, deliberatelyKilled };
}

const nativeDelete = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OwnedFileDelete {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [StructLayout(LayoutKind.Sequential)]
  public struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass, ref Disposition disposition, uint size);
}
'@
`;

async function main() {
  const shell = process.argv[2];
  check(shell && path.isAbsolute(shell) && hash(readFileSync(shell)) === "362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139", "RECOVERY_SHELL_MISMATCH");
  const results: Record<string, unknown>[] = [];
  for (const withGit of [false, true]) {
    const fixture = createFixture(withGit);
    const original = readFileSync(fixture.sourceFile, "utf8");
    const backup = path.join(fixture.root, "private-backup.txt");
    copyFileSync(fixture.sourceFile, backup);
    const newFile = path.join(fixture.project, "task-created.txt");
    const expected = "TASK_CREATED_CONTENT";
    const userVersion = "USER_REPLACEMENT_CONTENT";
    const deleteScript = nativeDelete + [
      "$ErrorActionPreference='Stop'; $stream=$null; $handle=$null",
      "try {",
      `$handle=[OwnedFileDelete]::CreateFileW(${quote(newFile)},[uint32]3221291008,0,[IntPtr]::Zero,3,[uint32]2097152,[IntPtr]::Zero)`,
      "if ($handle.IsInvalid) {throw 'OPEN_FAILED'}",
      `$attributes=[IO.File]::GetAttributes(${quote(newFile)}); if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'LINK_REFUSED'}`,
      "$stream=[IO.FileStream]::new($handle,[IO.FileAccess]::ReadWrite,4096,$false)",
      "$bytes=New-Object byte[] $stream.Length; $stream.ReadExactly($bytes)",
      `$actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant(); if ($actual -ne ${quote(hash(expected))}) {[Console]::WriteLine('CONFLICT'); exit 0}`,
      "[Console]::WriteLine('LOCKED'); if ([Console]::ReadLine() -ne 'APPLY') {throw 'CANCELLED'}",
      "$disposition=[OwnedFileDelete+Disposition]::new(); $disposition.DeleteFile=$true",
      "if (-not [OwnedFileDelete]::SetFileInformationByHandle($handle,4,[ref]$disposition,4)) {throw 'DELETE_FAILED'}",
      "$stream.Dispose(); $stream=$null; [Console]::WriteLine('DELETED')",
      "} catch {[Console]::WriteLine('FAILED'); exit 2} finally {if ($null -ne $stream) {$stream.Dispose()}; if ($null -ne $handle) {$handle.Dispose()}}",
    ].join("\n");
    writeFileSync(newFile, userVersion);
    const conflict = await scriptRun(shell, fixture.root, deleteScript);
    check(conflict.code === 0 && conflict.lines.join() === "CONFLICT" && readFileSync(newFile, "utf8") === userVersion, "RECOVERY_DELETE_CONFLICT_LOST");
    writeFileSync(newFile, expected);
    let externalWriteBlocked = false;
    const deleted = await scriptRun(shell, fixture.root, deleteScript, () => {
      try { writeFileSync(newFile, userVersion); } catch (error) { externalWriteBlocked = ["EPERM", "EACCES", "EBUSY"].includes(String((error as NodeJS.ErrnoException).code)); }
      check(externalWriteBlocked, "RECOVERY_DELETE_LOCK_FAILED");
    });
    check(deleted.code === 0 && deleted.lines.join() === "LOCKED,DELETED" && !existsSync(newFile), "RECOVERY_DELETE_FAILED");

    const prepared = path.join(fixture.root, "prepared-restore.txt");
    const restoredFile = path.join(fixture.project, "task-deleted.txt");
    copyFileSync(backup, prepared);
    const restoreScript = `try {[IO.File]::Move(${quote(prepared)},${quote(restoredFile)},$false); [Console]::WriteLine('RESTORED')} catch [IO.IOException] {[Console]::WriteLine('CONFLICT')}`;
    writeFileSync(restoredFile, userVersion);
    const restoreConflict = await scriptRun(shell, fixture.root, restoreScript);
    check(restoreConflict.code === 0 && restoreConflict.lines.join() === "CONFLICT" && readFileSync(restoredFile, "utf8") === userVersion, "RECOVERY_RESTORE_CONFLICT_LOST");
    // Use a second initially absent path; do not remove the conflicting version.
    const emptyTarget = path.join(fixture.project, "restore-into-empty.txt");
    const restored = await scriptRun(shell, fixture.root, restoreScript.replace(quote(restoredFile), quote(emptyTarget)));
    check(restored.code === 0 && restored.lines.join() === "RESTORED" && readFileSync(emptyTarget, "utf8") === original, "RECOVERY_EMPTY_RESTORE_FAILED");

    const partial = "PARTIAL_TASK_BYTES";
    const crashScript = `$s=[IO.File]::Open(${quote(fixture.sourceFile)},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $s.SetLength(0); $b=[Text.Encoding]::UTF8.GetBytes(${quote(partial)}); $s.Write($b,0,$b.Length); $s.Flush($true); [Console]::WriteLine('PARTIAL'); [Console]::ReadLine() | Out-Null; $s.Dispose()`;
    const crashed = await scriptRun(shell, fixture.root, crashScript, undefined, true);
    check(crashed.deliberatelyKilled && readFileSync(fixture.sourceFile, "utf8") === partial && readFileSync(backup, "utf8") === original, "RECOVERY_CRASH_NOT_OBSERVED");
    check(!withGit || hash(readFileSync(path.join(fixture.project, ".git/index"))) === fixture.gitState?.indexSha256, "RECOVERY_INDEX_CHANGED");
    results.push({ withGit, taskCreatedFileRemoved: true, deletionConflictRefused: true, externalWriteBlocked,
      deletedFileRestoredIntoEmptyPath: true, occupiedRestorePathPreserved: true,
      crashLeftPartialFile: true, backupPreserved: true, automaticCrashRecovery: false, indexPreserved: withGit ? true : "not-applicable" });
    fixture.cleanup();
  }
  const report = { kind: "ordinary-file-recovery-feasibility", status: "observations-confirmed", results,
    productRecoveryReady: false, paidRequests: 0, limitations: ["no-parent-rename-or-link-race-proof", "no-durable-recovery-journal", "no-crash-atomic-in-place-write", "no-multi-file-transaction", "no-capacity-benchmark"] };
  writeFileSync(path.resolve(".local/reports/recovery-feasibility-" + Date.now() + ".json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error && /^RECOVERY_[A-Z_]+$/.test(error.message) ? error.message : "RECOVERY_FAILED"); process.exitCode = 1; });
