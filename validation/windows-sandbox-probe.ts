import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "./isolated-env.js";
import { createRunDirectory } from "./run-directory.js";
import { isObject } from "./rpc.js";

function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function main() {
  const [binary, shell] = process.argv.slice(2);
  check(binary && shell && path.isAbsolute(binary) && path.isAbsolute(shell), "PROBE_ABSOLUTE_EXECUTABLES_REQUIRED");
  const binaryHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const versions: Record<string, string> = {
    "03e5cf467f4ef2c06360b00cdc9aef64bb79b2028e25e3e122dd0bd2152ace22": "0.140.0",
    "dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f": "0.162.0",
  };
  const version = versions[binaryHash];
  check(version, "PROBE_BINARY_MISMATCH");
  const mode = version === "0.162.0" ? "mxc" : "unelevated";
  const run = createRunDirectory("windows 中文边界");
  for (const dir of ["home", "profile/roaming", "profile/local", "temp", "project", "outside"]) mkdirSync(path.join(run.root, dir), { recursive: true });
  const project = path.join(run.root, "project");
  const outside = path.join(run.root, "outside");
  const scoped = process.argv.includes("--scoped");
  const writable = process.argv.includes("--write");
  check(!writable || scoped, "PROBE_WRITE_REQUIRES_SCOPED_PROFILE");
  writeFileSync(path.join(project, "inside.txt"), "SYNTHETIC_INSIDE");
  writeFileSync(path.join(outside, "outside.txt"), "SYNTHETIC_OUTSIDE_SECRET");
  writeFileSync(path.join(project, ".env"), "SYNTHETIC_ENV_SECRET");
  mkdirSync(path.join(project, ".git"));
  writeFileSync(path.join(project, ".git/index"), "SYNTHETIC_INDEX_BASELINE");
  const link = path.join(project, "outside-link");
  if (scoped && version === "0.162.0") symlinkSync(outside, link, "junction");
  writeFileSync(path.join(run.root, "home/config.toml"), [
    'approval_policy = "never"', 'sandbox_mode = "read-only"', '[analytics]', 'enabled = false',
    '[windows]', `sandbox = "${mode}"`,
    ...(scoped ? ['[permissions.scoped.filesystem]', '":minimal" = "read"', `${quote(project)} = "${writable ? "write" : "read"}"`,
      `${quote(path.join(project, ".env"))} = "deny"`, `${quote(path.join(project, ".git"))} = "read"`,
      `${quote(path.dirname(shell))} = "read"`, '[permissions.scoped.network]', 'enabled = false'] : []), '',
  ].join("\n"));
  const env = isolatedEnvironment(run.root, process.env);
  const attempts: Record<string, unknown>[] = [];
  const execute = (name: string, script: string) => {
    const profileFlag = version === "0.162.0" ? "--permission-profile" : "--permissions-profile";
    const result = spawnSync(binary, ["sandbox", profileFlag, scoped ? "scoped" : ":read-only", "--cd", project, "--", shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env, cwd: project, windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 100_000,
    });
    let payload: unknown;
    try { payload = JSON.parse(result.stdout.trim()); } catch { payload = null; }
    const diagnostics = result.stderr.replaceAll(run.root, "<run>")
      .replace(/[A-Za-z]:\\[^"<>\r\n]*\.local\\runs\\[^"<>\r\n]*/g, "<run-path>")
      .replace(/C:\\Users\\[^\\\s]+/gi, "<user>").slice(0, 1200);
    const attempt = { name, exitCode: result.status, timedOut: result.error?.message.includes("ETIMEDOUT") ?? false, payload, diagnostics };
    attempts.push(attempt);
    return attempt;
  };
  let status = "blocked";
  const control = execute("startup-control", "@{ marker='LCODEX_SANDBOX_READY'; version=$PSVersionTable.PSVersion.ToString(); languageMode=[string]$ExecutionContext.SessionState.LanguageMode } | ConvertTo-Json -Compress");
  let insideWrite = false;
  let outsideWrite = false;
  let sensitiveRead: unknown = "not-tested";
  let linkRead: unknown = "not-tested";
  let indexPreserved: unknown = "not-tested";
  let childStoppedWithForeground: unknown = "not-tested";
  if (control.exitCode === 0 && isObject(control.payload) && control.payload.marker === "LCODEX_SANDBOX_READY") {
    execute("read-project", `try { @{ read=((Get-Content -LiteralPath ${quote(path.join(project, "inside.txt"))} -Raw -ErrorAction Stop) -eq 'SYNTHETIC_INSIDE') } | ConvertTo-Json -Compress } catch { @{read=$false; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress }`);
    execute("write-project", `try { Set-Content -LiteralPath ${quote(path.join(project, "write-marker.txt"))} -Value 'PROBE_WRITE' -NoNewline -ErrorAction Stop; '{"write":true}' } catch { @{write=$false; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress }`);
    execute("read-outside-project", `try { @{ read=((Get-Content -LiteralPath ${quote(path.join(outside, "outside.txt"))} -Raw -ErrorAction Stop) -eq 'SYNTHETIC_OUTSIDE_SECRET') } | ConvertTo-Json -Compress } catch { @{read=$false; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress }`);
    execute("write-outside-project", `try { Set-Content -LiteralPath ${quote(path.join(outside, "write-marker.txt"))} -Value 'PROBE_WRITE' -NoNewline -ErrorAction Stop; '{"write":true}' } catch { @{write=$false; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress }`);
    if (scoped) {
      const secret = execute("read-sensitive-file", `try { @{read=((Get-Content -LiteralPath ${quote(path.join(project, ".env"))} -Raw -ErrorAction Stop) -eq 'SYNTHETIC_ENV_SECRET')} | ConvertTo-Json -Compress } catch { @{read=$false; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress }`);
      sensitiveRead = isObject(secret.payload) ? secret.payload.read : "unknown";
      if (existsSync(link)) {
        const linked = execute("read-through-junction", `try { @{read=((Get-Content -LiteralPath ${quote(path.join(link, "outside.txt"))} -Raw -ErrorAction Stop) -eq 'SYNTHETIC_OUTSIDE_SECRET')} | ConvertTo-Json -Compress } catch { @{read=$false; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress }`);
        linkRead = isObject(linked.payload) ? linked.payload.read : "unknown";
      }
      execute("write-git-index", `try { Set-Content -LiteralPath ${quote(path.join(project, ".git/index"))} -Value 'PROBE_INDEX_CHANGE' -NoNewline -ErrorAction Stop; '{"write":true}' } catch { @{write=$false; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress }`);
      indexPreserved = readFileSync(path.join(project, ".git/index"), "utf8") === "SYNTHETIC_INDEX_BASELINE";
    }
    if (scoped && writable && version === "0.162.0") {
      const startedFile = path.join(project, "child-started.txt");
      const finishedFile = path.join(project, "child-finished.txt");
      // Even if lifecycle isolation fails, this fixed child exits after four seconds.
      const childScript = `Set-Content -LiteralPath ${quote(startedFile)} -Value started; Start-Sleep -Seconds 4; Set-Content -LiteralPath ${quote(finishedFile)} -Value finished`;
      const encoded = Buffer.from(childScript, "utf16le").toString("base64");
      const child = execute("foreground-exit-child", `$p = Start-Process -FilePath ${quote(shell)} -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',${quote(encoded)}) -RedirectStandardOutput ${quote(path.join(project, "child-stdout.txt"))} -RedirectStandardError ${quote(path.join(project, "child-stderr.txt"))} -PassThru -ErrorAction Stop; Start-Sleep -Seconds 1; @{childPid=$p.Id; childStarted=(Test-Path -LiteralPath ${quote(startedFile)})} | ConvertTo-Json -Compress`);
      if (child.exitCode === 0 && isObject(child.payload) && child.payload.childStarted === true && Number.isSafeInteger(child.payload.childPid)) {
        const pid = Number(child.payload.childPid);
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        await new Promise((resolve) => setTimeout(resolve, 4_500));
        childStoppedWithForeground = !alive && !existsSync(finishedFile);
      } else childStoppedWithForeground = "unconfirmed-child-start";
    }
    insideWrite = existsSync(path.join(project, "write-marker.txt"));
    outsideWrite = existsSync(path.join(outside, "write-marker.txt"));
    const reads = attempts.filter((item) => item.name === "read-project" || item.name === "read-outside-project");
    const readInside = isObject(reads[0]?.payload) && reads[0].payload.read === true;
    const readOutside = isObject(reads[1]?.payload) && reads[1].payload.read === true;
    const scopedChecks = !scoped || (sensitiveRead === false && linkRead === false && indexPreserved === true && (!writable || childStoppedWithForeground === true));
    status = readInside && !readOutside && insideWrite === writable && !outsideWrite && scopedChecks ? "passed-scoped-sample" : "scope-not-satisfied";
  }
  const report = { kind: "native-windows-sandbox-command-sample", engineVersion: version, engineSha256: binaryHash, mode, policy: scoped ? (writable ? "scoped-write" : "scoped-readonly") : "read-only", status,
    shellSha256: createHash("sha256").update(readFileSync(shell)).digest("hex"), attempts, insideWriteObserved: insideWrite, outsideWriteObserved: outsideWrite,
    sensitiveRead, linkRead, indexPreserved, childStoppedWithForeground,
    paidRequests: 0, userFilesTargeted: 0, fullSandboxAcceptance: false, appServerInterruptTested: false };
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(`.local/reports/windows-sandbox-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  // A timeout leaves the run for process reconciliation; do not delete possibly active files.
  if (!attempts.some((item) => item.timedOut) && childStoppedWithForeground !== "unconfirmed-child-start") {
    if (existsSync(link)) {
      check(lstatSync(link).isSymbolicLink() && realpathSync(link).toLowerCase() === outside.toLowerCase(), "PROBE_LINK_CHANGED");
      unlinkSync(link);
    }
    run.cleanup();
  }
  console.log(JSON.stringify(report, null, 2));
  if (status !== "passed-scoped-sample") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && /^PROBE_[A-Z_]+$/.test(error.message) ? error.message : "PROBE_FAILED");
  process.exitCode = 1;
});
