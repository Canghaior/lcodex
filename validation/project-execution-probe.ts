import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFixture, repairedExample, snapshot } from "./fixtures.js";
import { isolatedEnvironment } from "./isolated-env.js";
import { isObject } from "./rpc.js";

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

function main() {
  const [binary, shell] = process.argv.slice(2);
  check(binary && shell && path.isAbsolute(binary) && path.isAbsolute(shell), "PROBE_ABSOLUTE_PATHS_REQUIRED");
  check(digest(readFileSync(binary)) === "dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f", "PROBE_ENGINE_HASH_MISMATCH");
  check(digest(readFileSync(shell)) === "362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139", "PROBE_SHELL_HASH_MISMATCH");
  check(process.version === "v24.8.0", "PROBE_NODE_VERSION_MISMATCH");
  const node = realpathSync(process.execPath);
  const nodeHash = digest(readFileSync(node));
  const attempts: Record<string, unknown>[] = [];
  for (const withGit of [false, true]) {
    const fixture = createFixture(withGit);
    let mayClean = true;
    const sample: Record<string, unknown> = { withGit, status: "failed" };
    try {
      for (const dir of ["home", "profile/roaming", "profile/local/Packages"]) mkdirSync(path.join(fixture.root, dir), { recursive: true });
      const env = isolatedEnvironment(fixture.root, process.env);
      writeFileSync(path.join(fixture.root, "home/config.toml"), [
        'approval_policy = "never"', 'default_permissions = "scoped"', '[windows]', 'sandbox = "mxc"',
        '[permissions.scoped.filesystem]', '":minimal" = "read"', `${quote(fixture.project)} = "write"`,
        `${quote(path.join(fixture.project, ".env"))} = "deny"`, `${quote(path.join(fixture.project, ".git"))} = "read"`,
        `${quote(fixture.evaluator)} = "read"`, `${quote(path.dirname(node))} = "read"`, `${quote(path.dirname(shell))} = "read"`,
        `${quote(path.dirname(process.env.COMSPEC ?? "C:/Windows/System32/cmd.exe"))} = "read"`,
        `${quote(path.join(fixture.root, "profile/local/Packages"))} = "write"`,
        '[permissions.scoped.network]', 'enabled = false', '[analytics]', 'enabled = false', '',
      ].join("\n"));
      const execute = (script: string) => {
        check(digest(readFileSync(fixture.evaluator)) === fixture.evaluatorHash, "PROBE_EVALUATOR_CHANGED");
        const result = spawnSync(binary, ["sandbox", "--permission-profile", "scoped", "--cd", fixture.project, "--", shell,
          "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { env, cwd: fixture.project, windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 100_000 });
        if (result.error || result.signal) mayClean = false;
        sample.lastExitCode = result.status;
        sample.lastStderrBytes = Buffer.byteLength(result.stderr ?? "");
        sample.lastDiagnostic = (result.stderr ?? "").replaceAll(fixture.root, "<run>").replace(/C:\\Users\\[^\\\s]+/gi, "<user>").slice(0, 1500);
        check(!result.error && !result.signal, "PROBE_PROCESS_UNCONFIRMED");
        check(digest(readFileSync(fixture.evaluator)) === fixture.evaluatorHash, "PROBE_EVALUATOR_CHANGED");
        let value: unknown;
        try { value = JSON.parse(result.stdout.trim()); } catch { throw new Error("PROBE_INVALID_OUTPUT"); }
        check(isObject(value), "PROBE_INVALID_OUTPUT");
        return { exitCode: result.status, value };
      };
      const runTests = () => {
        const result = execute(`& ${quote(node)} --preserve-symlinks --preserve-symlinks-main ${quote(fixture.evaluator)} ${quote(fixture.sourceFile)}; exit $LASTEXITCODE`);
        const expected = ["empty", "single", "quantity", "mixed", "discount", "rounding"];
        check(result.value.kind === "independent-invoice-checks" && Array.isArray(result.value.checks) && result.value.checks.length === expected.length, "PROBE_MISSING_CHECKS");
        const checks = result.value.checks;
        check(checks.every((item, index) => isObject(item) && item.name === expected[index] && typeof item.passed === "boolean"), "PROBE_INVALID_CHECKS");
        const passed = checks.filter((item) => item.passed).length;
        check(result.exitCode === (passed === expected.length ? 0 : 1), "PROBE_EXIT_RESULT_MISMATCH");
        return { exitCode: result.exitCode, passed, failed: expected.length - passed };
      };
      sample.baseline = runTests();
      check(isObject(sample.baseline) && sample.baseline.passed === 2, "PROBE_BASELINE_MISMATCH");
      const tamper = execute(`$r=@{}; try { Set-Content -LiteralPath ${quote(fixture.evaluator)} -Value 'tampered' -NoNewline -ErrorAction Stop; $r.evaluatorWrite=$true } catch {$r.evaluatorWrite=$false}; try { Remove-Item -LiteralPath ${quote(fixture.evaluator)} -ErrorAction Stop; $r.evaluatorDelete=$true } catch {$r.evaluatorDelete=$false}; try {$r.sensitiveRead=((Get-Content -LiteralPath ${quote(path.join(fixture.project, ".env"))} -Raw -ErrorAction Stop).Length -gt 0)} catch {$r.sensitiveRead=$false}; $r | ConvertTo-Json -Compress`);
      sample.protection = tamper.value;
      check(tamper.exitCode === 0 && tamper.value.evaluatorWrite === false && tamper.value.evaluatorDelete === false && tamper.value.sensitiveRead === false, "PROBE_PROTECTION_FAILED");
      // This is a trusted reference prepared by the coordinator, not an Agent repair.
      writeFileSync(fixture.sourceFile, repairedExample);
      sample.reference = runTests();
      check(isObject(sample.reference) && sample.reference.passed === 6, "PROBE_REFERENCE_FAILED");
      const after = snapshot(fixture.project);
      sample.unrelatedFilesPreserved = Object.keys(after).length === Object.keys(fixture.baseline).length &&
        Object.entries(fixture.baseline).every(([file, hash]) => file === "invoice.mjs" || after[file] === hash);
      sample.indexPreserved = !withGit || digest(readFileSync(path.join(fixture.project, ".git/index"))) === fixture.gitState?.indexSha256;
      check(sample.unrelatedFilesPreserved && sample.indexPreserved, "PROBE_EXISTING_CHANGES_LOST");
      sample.status = "passed";
    } catch (error) {
      sample.errorCode = error instanceof Error && /^(PROBE_|FIXTURE_)[A-Z0-9_]+$/.test(error.message) ? error.message : "PROBE_FAILED";
      process.exitCode = 1;
    }
    attempts.push(sample);
    if (mayClean) fixture.cleanup();
    if (sample.status !== "passed") break;
  }
  check(digest(readFileSync(node)) === nodeHash, "PROBE_NODE_CHANGED");
  const report = { kind: "native-windows-project-tests", status: attempts.length === 2 && attempts.every((item) => item.status === "passed") ? "passed" : "failed",
    engineVersion: "0.162.0", sandbox: "MXC", nodeVersion: process.version, nodeSha256: nodeHash, nodeFlags: ["--preserve-symlinks", "--preserve-symlinks-main"], shellVersion: "7.6.5", attempts,
    paidRequests: 0, realModel: false, agentRepair: false, appServerCommandPath: false };
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(".local/reports/project-execution-" + Date.now() + ".json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

try { main(); } catch (error) {
  console.error(error instanceof Error && /^PROBE_[A-Z0-9_]+$/.test(error.message) ? error.message : "PROBE_FAILED"); process.exitCode = 1;
}
