import { spawn } from "node:child_process";
import { JsonLineRpc, isObject } from "./rpc.js";

// Restart the same private engine home, load history and resume without a new
// turn. The caller keeps its model endpoint closed to new calls and checks files.
export async function checkRestart(binary: string, cwd: string, env: NodeJS.ProcessEnv, threadId: string, turnId: string, expectedStatus: "completed" | "interrupted" | "failed" = "completed",
  continuation?: { prompt: string; checkText: (text: string) => boolean }) {
  const child = spawn(binary, ["app-server", "--listen", "stdio://", "--strict-config"], {
    cwd, env: { ...env, RUST_LOG: "codex_app_server=info" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const notifications: string[] = [];
  let stderrBytes = 0;
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; stderrTail = (stderrTail + chunk.toString("utf8")).slice(-16_384); });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let continuationStart = Infinity, resolveContinuation: ((value: unknown) => void) | undefined;
  let continuationTools = 0, continued = false;
  const rpc = new JsonLineRpc(child.stdout, child.stdin, 15_000, 1_048_576, (method, params) => {
    notifications.push(method);
    if (Number.isFinite(continuationStart)) {
      if (method === "item/started" && isObject(params) && isObject(params.item) && ["commandExecution", "fileChange"].includes(String(params.item.type))) continuationTools++;
      if (method === "turn/completed") resolveContinuation?.(params);
    }
  });
  child.on("error", () => rpc.abort(new Error("PROBE_RESTART_SPAWN_FAILED")));
  let passed = false;
  let errorCode: string | undefined;
  let history: Record<string, unknown> | undefined;
  try {
    await rpc.request("initialize", { clientInfo: { name: "lcodex_restart_check", version: "0.0.1" } });
    rpc.notify("initialized", {});
    const resumed = await rpc.request("thread/resume", { threadId });
    if (!isObject(resumed) || !isObject(resumed.thread) || resumed.thread.id !== threadId) throw new Error("PROBE_RESTART_ID_MISMATCH");
    const read = await rpc.request("thread/read", { threadId, includeTurns: true });
    if (!isObject(read) || !isObject(read.thread) || !Array.isArray(read.thread.turns)) throw new Error("PROBE_RESTART_HISTORY_MISSING");
    const last = read.thread.turns.at(-1);
    history = { turns: read.thread.turns.length, lastStatus: isObject(last) ? last.status : "missing", sameTurnId: isObject(last) && last.id === turnId };
    passed = isObject(last) && last.id === turnId && last.status === expectedStatus && Array.isArray(last.items) &&
      (expectedStatus !== "completed" || last.items.some((item) => isObject(item) && item.type === "agentMessage"));
    if (passed && continuation) {
      continuationStart = notifications.length;
      const next = new Promise<unknown>(resolve => { resolveContinuation = resolve; });
      const started = await rpc.request("turn/start", { threadId, input: [{ type: "text", text: continuation.prompt, text_elements: [] }] });
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([next, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 60_000); })]); clearTimeout(timer);
      const text = isObject(done) && isObject(done.turn) && Array.isArray(done.turn.items)
        ? done.turn.items.filter(isObject).filter(item => item.type === "agentMessage").map(item => String(item.text)).join("\n") : "";
      continued = isObject(started) && isObject(started.turn) && isObject(done) && isObject(done.turn) &&
        done.turn.id === started.turn.id && done.turn.id !== turnId && done.turn.status === "completed" && continuationTools === 0 && continuation.checkText(text);
      passed = passed && continued;
    }
  } catch (error) { passed = false; errorCode = error instanceof Error && /^(RPC_|PROBE_)[A-Z0-9_-]+$/.test(error.message) ? error.message : "PROBE_RESTART_FAILED"; }
  rpc.abort(new Error("PROBE_RESTART_CLOSED"));
  child.stdin.end();
  let timer: NodeJS.Timeout | undefined;
  let exitCode = await Promise.race([closed, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 25_000); })]);
  clearTimeout(timer);
  let forcedExit = false;
  if (exitCode === undefined) {
    forcedExit = true; child.kill();
    exitCode = await Promise.race([closed, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 3_000); })]);
    clearTimeout(timer);
  }
  const replayEvents = notifications.slice(0, continuationStart).filter((method) => ["turn/started", "item/started", "item/commandExecution/outputDelta"].includes(method));
  const shutdownMessages = [...new Set(stderrTail.split(/\r?\n/).flatMap((line) => {
    if (/timed out waiting.*background/i.test(line)) return ["background-drain-timeout"];
    if (/timed out waiting.*thread/i.test(line)) return ["thread-shutdown-timeout"];
    if (/processor task exited/i.test(line)) return ["processor-exited"];
    if (/remote control websocket loop exited/i.test(line)) return ["remote-control-loop-exited"];
    return [];
  }))];
  return { passed: passed && exitCode === 0 && replayEvents.length === 0 && rpc.deniedServerRequests === 0,
    historyMatched: history?.sameTurnId === true && history?.lastStatus === expectedStatus, history, expectedStatus, continued, continuationTools,
    errorCode, exitCode, forcedExit, stderrBytes, shutdownMessages, replayEvents, notifications };
}
