import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "./isolated-env.js";

export type CapturedFile = { relative: string; sha256: string; base64: string; kind: "text" | "binary" };
export type CapturedTree = { files: CapturedFile[]; excluded: string[] };
export type ApplyResult = { status: "applied" | "conflict" | "refused"; code?: string; mayHaveChanged?: boolean };
export const contentHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// Coordinator-only P1 adapter. The script and its native source are trusted code,
// not available for model modification. Every process is bounded and reaped.
export class WindowsFileGuard {
  constructor(private readonly shell: string, private readonly environmentRoot: string) {
    if (process.platform !== "win32" || !path.isAbsolute(shell) ||
      contentHash(readFileSync(shell)) !== "362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139") throw new Error("GUARD_RUNTIME_MISMATCH");
  }
  private async invoke(request: object, onLocked?: () => void, dependencyCapture = false): Promise<unknown> {
    const child = spawn(this.shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.resolve("validation/windows-file-guard.ps1")],
      { env: isolatedEnvironment(this.environmentRoot, process.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", size = 0, result: unknown, failure = "", locked = false;
    child.stdout.setEncoding("utf8"); child.stderr.resume();
    child.stdin.on("error", () => { failure ||= "GUARD_INPUT_FAILED"; });
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > (dependencyCapture ? 96 : 24) * 1024 * 1024) { failure = "GUARD_OUTPUT_LIMIT"; child.kill(); return; }
      output += chunk;
      let end: number;
      while ((end = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, end).trim(); output = output.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (typeof value === "object" && value !== null && "status" in value && value.status === "locked") {
            if (locked || result) throw new Error();
            locked = true; onLocked?.(); child.stdin.end("APPLY\n");
          } else { if (result) throw new Error(); result = value; child.stdin.end(); }
        } catch { failure = "GUARD_PROTOCOL_FAILED"; child.stdin.end("CANCEL\n"); }
      }
    });
    const timer = setTimeout(() => { failure = "GUARD_TIMEOUT_RECONCILE"; child.kill(); }, dependencyCapture ? 30_000 : 15_000);
    child.stdin.write(JSON.stringify(request) + "\n");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve); child.once("error", () => reject(new Error("GUARD_SPAWN_FAILED")));
    }).finally(() => clearTimeout(timer));
    if (failure || output.trim() || !result || exitCode !== 0 && exitCode !== 2) throw new Error(failure || "GUARD_EXIT_RECONCILE");
    return result;
  }
  async capture(root: string): Promise<CapturedTree> {
    return this.captureTree(root, false);
  }
  async captureDependencies(root: string): Promise<CapturedTree> {
    return this.captureTree(root, true);
  }
  private async captureTree(root: string, dependencies: boolean): Promise<CapturedTree> {
    const value = await this.invoke({ mode: dependencies ? "dependencies" : "capture", root: path.resolve(root) }, undefined, dependencies) as Partial<CapturedTree> & Partial<ApplyResult>;
    if (value.status === "refused") throw new Error(value.code || "GUARD_CAPTURE_REFUSED");
    if (!Array.isArray(value.files) || !Array.isArray(value.excluded) || value.files.some(file =>
      typeof file.relative !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !["text", "binary"].includes(file.kind) || typeof file.base64 !== "string" || contentHash(Buffer.from(file.base64, "base64")) !== file.sha256)) throw new Error("GUARD_CAPTURE_INVALID");
    return { files: value.files, excluded: value.excluded };
  }
  async apply(root: string, relative: string, expected: string | null, contents: Buffer | null, onLocked?: () => void): Promise<ApplyResult> {
    if (expected === null && contents === null || expected !== null && !/^[a-f0-9]{64}$/.test(expected)) throw new Error("GUARD_APPLY_INVALID");
    if (contents && (contents.length > 1024 * 1024 || contents.includes(0))) throw new Error("GUARD_CONTENT_REFUSED");
    if (contents) new TextDecoder("utf-8", { fatal: true }).decode(contents);
    const result = await this.invoke({ mode: "apply", root: path.resolve(root), relative, expected, base64: contents?.toString("base64") ?? null }, onLocked) as ApplyResult;
    if (!["applied", "conflict", "refused"].includes(result.status) || result.code && !/^GUARD_[A-Z_]+$/.test(result.code)) throw new Error("GUARD_RESULT_INVALID");
    return result;
  }
}
