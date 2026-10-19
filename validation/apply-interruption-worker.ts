import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { WindowsFileGuard, ApplyResult } from "./windows-file-guard.js";
import { prepareReviewWorkspace } from "./review-workspace.js";
import { isolatedEnvironment } from "./isolated-env.js";
import { psQuote } from "./workflow-sample.js";

// Only invoked by the synthetic crash test. The production guard bridge exposes
// no checkpoint operation, arbitrary script or process-termination API.
async function main() {
  const [project, state, runRoot, shell] = process.argv.slice(2);
  if (!project || !state || !runRoot || !shell || !path.resolve(runRoot).startsWith(path.resolve(".local/runs") + path.sep) ||
      path.resolve(project) !== path.join(path.resolve(runRoot), "project with space") || path.resolve(state) !== path.join(path.resolve(runRoot), "state")) throw new Error("INTERRUPT_WORKER_SCOPE");
  const validatedShell = shell, validationRoot = runRoot;
  class InterruptedGuard extends WindowsFileGuard {
    override async apply(root: string, relative: string, expected: string | null, bytes: Buffer | null): Promise<ApplyResult> {
      if (relative !== "interrupted.txt" || !bytes || expected === null) throw new Error("INTERRUPT_WORKER_INPUT");
      const input = JSON.stringify({ root, relative, expected, bytes: bytes.toString("base64") });
      const script = [
        "$ErrorActionPreference='Stop'", "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
        `Add-Type -Path ${psQuote(path.resolve("validation/windows-file-guard.cs"))}`,
        "$r=[Console]::ReadLine() | ConvertFrom-Json", "$g=[WindowsFileGuard]::new()",
        "$g.Prepare($r.root,$r.relative,$r.expected,$false)", "if($g.status -ne 'ready'){exit 3}",
        "$checkpoint=[Action]{[Console]::WriteLine('PARTIAL'); [Console]::Out.Flush(); Start-Sleep -Seconds 30}",
        "$g.ApplyWithCheckpoint([Convert]::FromBase64String($r.bytes),$false,$checkpoint)", "$g.Dispose(); exit 4",
      ].join("\n");
      const child = spawn(validatedShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { env: isolatedEnvironment(validationRoot, process.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let partial = false, output = "";
      child.stderr.resume(); child.stdout.setEncoding("utf8"); child.stdin.on("error", () => {});
      child.stdout.on("data", chunk => {
        output += String(chunk);
        if (output.includes("PARTIAL")) { partial = true; child.kill(); }
        if (output.length > 8192) child.kill();
      });
      child.stdin.end(input + "\n");
      const timer = setTimeout(() => child.kill(), 15_000);
      await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); }).finally(() => clearTimeout(timer));
      // Terminate the coordinator before it can append a result. Its durable
      // intent, original baseline and full candidate must survive independently.
      process.exit(partial ? 17 : 18);
    }
  }
  const task = await prepareReviewWorkspace(project, state, new InterruptedGuard(shell, runRoot));
  writeFileSync(path.join(task.workspace, "interrupted.txt"), "b".repeat(256 * 1024));
  const review = await task.seal();
  console.log(JSON.stringify({ taskDirectory: task.taskDirectory }));
  await task.apply(review.id, ["interrupted.txt"]);
  throw new Error("INTERRUPT_WORKER_UNEXPECTED_RETURN");
}
main().catch(() => { console.error("INTERRUPT_WORKER_FAILED"); process.exitCode = 1; });
