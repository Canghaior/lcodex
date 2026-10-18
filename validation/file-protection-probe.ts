import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFixture, snapshot } from "./fixtures.js";
import { isolatedEnvironment } from "./isolated-env.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

// Trusted coordinator experiment on one disposable ordinary file, not a product API.
async function lockedWrite(shell: string, root: string, file: string, expected: string, replacement: string,
  whileLocked?: () => void) {
  const script = [
    "$ErrorActionPreference='Stop'; $stream=$null",
    "try {",
    "$stream=[System.IO.File]::Open(" + quote(file) + ",[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)",
    "$bytes=New-Object byte[] $stream.Length; $stream.ReadExactly($bytes)",
    "$hash=[System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()",
    "if ($hash -ne " + quote(expected) + ") {[Console]::WriteLine('CONFLICT'); exit 0}",
    "[Console]::WriteLine('LOCKED')",
    "if ([Console]::ReadLine() -ne 'APPLY') {throw 'NO_APPLY'}",
    "$replacement=[System.Convert]::FromBase64String('" + Buffer.from(replacement).toString("base64") + "')",
    "$stream.Position=0; $stream.Write($replacement,0,$replacement.Length); $stream.SetLength($replacement.Length); $stream.Flush($true)",
    "[Console]::WriteLine('APPLIED')",
    "} catch {[Console]::WriteLine('LOCK_FAILED'); exit 2} finally {if ($null -ne $stream) {$stream.Dispose()}}",
  ].join("\n");
  const child = spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    cwd: root, env: isolatedEnvironment(root, process.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let buffer = "", callbackError: unknown;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      lines.push(line);
      if (line === "LOCKED") {
        try { whileLocked?.(); child.stdin.end("APPLY\n"); }
        catch (error) { callbackError = error; child.stdin.end("CANCEL\n"); }
      }
    }
  });
  child.stderr.resume();
  const timer = setTimeout(() => { child.stdin.destroy(); child.kill(); }, 5_000);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (callbackError) throw callbackError;
  return { exitCode, lines };
}

async function main() {
  const shell = process.argv[2];
  check(shell && path.isAbsolute(shell), "PROTECTION_SHELL_REQUIRED");
  check(sha(readFileSync(shell)) === "362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139", "PROTECTION_SHELL_MISMATCH");
  const results = [];
  for (const withGit of [false, true]) {
    const fixture = createFixture(withGit);
    const source = readFileSync(fixture.sourceFile, "utf8");
    const originalIndex = withGit ? sha(readFileSync(path.join(fixture.project, ".git/index"))) : null;
    const candidate = source + "\n// AGENT_CANDIDATE\n";
    const userVersion = source + "\n// USER_CONCURRENT_EDIT\n";
    const candidateDir = path.join(fixture.root, "candidate");
    mkdirSync(candidateDir);
    const candidateFile = path.join(candidateDir, "invoice.mjs");
    copyFileSync(fixture.sourceFile, candidateFile);
    writeFileSync(candidateFile, candidate);
    check(JSON.stringify(snapshot(fixture.project)) === JSON.stringify(fixture.baseline), "PROTECTION_COPY_CHANGED_ORIGINAL");
    writeFileSync(fixture.sourceFile, userVersion);
    const conflict = await lockedWrite(shell, fixture.root, fixture.sourceFile, sha(source), candidate);
    check(conflict.exitCode === 0 && conflict.lines.join() === "CONFLICT" && readFileSync(fixture.sourceFile, "utf8") === userVersion, "PROTECTION_CONFLICT_OVERWRITTEN");
    writeFileSync(fixture.sourceFile, source); // reset our synthetic case only
    let blockedExternalWrite = false;
    const applied = await lockedWrite(shell, fixture.root, fixture.sourceFile, sha(source), candidate, () => {
      try { writeFileSync(fixture.sourceFile, userVersion); }
      catch (error) { blockedExternalWrite = ["EBUSY", "EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code)); }
      check(blockedExternalWrite, "PROTECTION_EXCLUSIVE_LOCK_FAILED");
    });
    check(applied.exitCode === 0 && applied.lines.join() === "LOCKED,APPLIED" && readFileSync(fixture.sourceFile, "utf8") === candidate, "PROTECTION_APPLY_FAILED");
    const restored = await lockedWrite(shell, fixture.root, fixture.sourceFile, sha(candidate), source);
    check(restored.exitCode === 0 && JSON.stringify(snapshot(fixture.project)) === JSON.stringify(fixture.baseline), "PROTECTION_RESTORE_FAILED");
    writeFileSync(fixture.sourceFile, userVersion);
    const restoreConflict = await lockedWrite(shell, fixture.root, fixture.sourceFile, sha(candidate), source);
    check(restoreConflict.exitCode === 0 && restoreConflict.lines.join() === "CONFLICT" && readFileSync(fixture.sourceFile, "utf8") === userVersion, "PROTECTION_RESTORE_CONFLICT_OVERWRITTEN");
    if (withGit) check(sha(readFileSync(path.join(fixture.project, ".git/index"))) === originalIndex, "PROTECTION_INDEX_CHANGED");
    check(sha(readFileSync(fixture.evaluator)) === fixture.evaluatorHash, "PROTECTION_EVALUATOR_CHANGED");
    results.push({ withGit, isolatedCandidatePreservedOriginal: true, applyConflictRefused: true, blockedExternalWrite,
      modifiedFileRestored: true, restoreConflictRefused: true, indexPreserved: withGit ? true : "not-applicable",
      evaluatorPreserved: true, sourceBytes: Buffer.byteLength(source), candidateBytes: Buffer.byteLength(candidate) });
    fixture.cleanup();
  }
  const report = { kind: "synthetic-single-file-lock-feasibility", status: "passed", results, realModel: false,
    limitations: ["not-a-product-apply-api", "no-new-file-or-delete-restore", "no-crash-consistency", "no-multi-file-transaction", "no-link-or-rename-race-validation"] };
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(".local/reports/file-protection-" + Date.now() + ".json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error && /^PROTECTION_[A-Z_]+$/.test(error.message) ? error.message : "PROTECTION_FAILED"); process.exitCode = 1; });
