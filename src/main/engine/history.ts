import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { JsonLineRpc, isObject } from "../../../validation/rpc.js";
import { isolatedEnvironment } from "../../../validation/isolated-env.js";

// Read the engine's own persisted state. No model credential, turn/start, shell
// API or original-project write is available in this reconciliation operation.
export async function verifyCompletedHistory(engine: string, root: string, home: string, threadId: string, turnId: string | null, allowInterrupted = false) {
  let requests = 0, replay = false;
  const gateway = createServer((_request, response) => { requests++; response.writeHead(403); response.end(); });
  await new Promise<void>((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const address = gateway.address(); if (!address || typeof address === "string") throw new Error("ENGINE_HISTORY_GATEWAY_FAILED");
  const child = spawn(engine, ["app-server", "--listen", "stdio://", "--strict-config", "-c", `model_providers.workflow.base_url="http://127.0.0.1:${address.port}/v1"`], {
    cwd: root, env: { ...isolatedEnvironment(root, process.env), CODEX_HOME: home, LCODEX_WORKFLOW_TOKEN: randomUUID() }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  const rpc = new JsonLineRpc(child.stdout, child.stdin, 15_000, 1_048_576, method => {
    if (["turn/started", "item/started", "item/commandExecution/outputDelta"].includes(method)) replay = true;
  }, true);
  child.once("error", () => rpc.abort(new Error("ENGINE_HISTORY_START_FAILED")));
  let matched = false, exit: number | null | undefined, lastStatus = "";
  try {
    await rpc.request("initialize", { clientInfo: { name: "lcodex_history", version: "0.1.0" } }); rpc.notify("initialized", {});
    const history = await rpc.request("thread/read", { threadId, includeTurns: true });
    const thread = isObject(history) && isObject(history.thread) ? history.thread : undefined;
    const last = thread && Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
    lastStatus = isObject(last) && typeof last.status === "string" ? last.status : "";
    if (turnId === null && allowInterrupted && thread?.id === threadId && Array.isArray(thread.turns) && thread.turns.length === 0) { matched = true; lastStatus = "not-started"; }
    else matched = thread?.id === threadId && isObject(last) && last.id === turnId && (lastStatus === "completed" || allowInterrupted && ["interrupted", "failed"].includes(lastStatus));
  } catch {
    throw new Error("ENGINE_HISTORY_UNAVAILABLE");
  } finally {
    rpc.abort(new Error("ENGINE_HISTORY_CLOSED")); child.stdin.end();
    const wait = async (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([closed, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
      finally { clearTimeout(timer); }
    };
    exit = await wait(25_000);
    if (exit === undefined) { child.kill(); await wait(3000); }
    gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
  }
  if (!matched || requests || replay || exit !== 0 || rpc.deniedServerRequests) throw new Error("ENGINE_HISTORY_MISMATCH");
  return lastStatus;
}
