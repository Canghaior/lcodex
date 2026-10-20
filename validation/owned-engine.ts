import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isObject } from "./rpc.js";
import { writePrivate } from "./private-files.js";

export type OwnedExit = { processesEnded: true; forced: boolean; engineExitCode: number | null };
export function spawnOwnedEngine(options: { engine: string; shell: string; root: string; cwd: string; env: NodeJS.ProcessEnv; args: string[]; scriptDirectory?: string }) {
  const control = path.join(options.root, "owner-" + randomUUID()); mkdirSync(control);
  const request = "request.json", stopFile = path.join(control, "stop"), resultFile = path.join(control, "result.json");
  writePrivate(control, request, JSON.stringify({ executable: options.engine, arguments: options.args, cwd: options.cwd, parentPid: process.pid, stopFile, resultFile }));
  const child = spawn(options.shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(options.scriptDirectory ?? path.resolve("validation"), "windows-process-owner.ps1"), "-RequestFile", path.join(control, request)],
    { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return {
    child,
    stop: () => { writeFileSync(stopFile, "", { flag: "a" }); },
    result: (): OwnedExit | null => {
      try {
        const value: unknown = JSON.parse(readFileSync(resultFile, "utf8"));
        if (!isObject(value) || value.version !== 1 || value.processesEnded !== true || typeof value.forced !== "boolean" ||
          !(value.forced ? value.engineExitCode === null : Number.isInteger(value.engineExitCode))) return null;
        return { processesEnded: true, forced: value.forced, engineExitCode: value.engineExitCode as number | null };
      } catch { return null; }
    },
  };
}
