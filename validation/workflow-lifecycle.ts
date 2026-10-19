import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isObject, JsonLineRpc } from "./rpc.js";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const roles = ["parent", "child", "grandchild"] as const;

// A bounded synthetic process tree. Every process exits itself even if the
// stopping implementation fails; late files make that failure observable.
export function createProcessTreeFixture(project: string, durationMs: number) {
  writeFileSync(path.join(project, "process-tree.mjs"), `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const role=process.argv[2];
writeFileSync('pid-'+role+'.json',JSON.stringify({pid:process.pid,started:Date.now()}));
const next=role==='parent'?'child':role==='child'?'grandchild':null;
if(next)spawn(process.execPath,[...process.execArgv,process.argv[1],next],{windowsHide:true,stdio:'ignore'});
setTimeout(()=>{writeFileSync('late-'+role+'.txt','UNEXPECTED_AFTER_STOP');process.exit(0);},${durationMs});
`);
}

export async function waitForProcessTree(workspace: string) {
  const until = Date.now() + 8_000;
  while (!roles.every(role => existsSync(path.join(workspace, `pid-${role}.json`))) && Date.now() < until) await delay(40);
  return roles.map(role => {
    const value: unknown = JSON.parse(readFileSync(path.join(workspace, `pid-${role}.json`), "utf8"));
    if (!isObject(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || !Number.isSafeInteger(value.started)) throw new Error("WORKFLOW_TREE_ID_INVALID");
    return { role, pid: Number(value.pid), started: Number(value.started) };
  });
}

export async function verifyTreeStopped(workspace: string, tree: Awaited<ReturnType<typeof waitForProcessTree>>, durationMs: number) {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  const until = Date.now() + 3_000;
  while (tree.some(item => alive(item.pid)) && Date.now() < until) await delay(40);
  const ended = tree.map(item => !alive(item.pid));
  // Check after the fixture's delayed write would have happened, not just at
  // the instant that the terminal list became empty.
  const latest = Math.max(...tree.map(item => item.started)) + durationMs + 250;
  while (Date.now() < latest) await delay(Math.min(500, latest - Date.now()));
  const noLateWrites = roles.every(role => !existsSync(path.join(workspace, `late-${role}.txt`)));
  return { processCount: tree.length, allEnded: ended.every(Boolean), noLateWrites };
}

// Caller blocks gateway delivery before this starts. An interrupt acknowledgement
// is not a stopped verdict: clean terminals, check pagination and read history.
export async function stopAndReadThread(rpc: JsonLineRpc, threadId: string, turnId: string) {
  let interruptAcknowledged = false;
  try { await rpc.request("turn/interrupt", { threadId, turnId }); interruptAcknowledged = true; } catch { /* Still attempt cleanup and state reconciliation. */ }
  await rpc.request("thread/backgroundTerminals/clean", { threadId });
  let terminals: unknown;
  const until = Date.now() + 3_000;
  do {
    terminals = await rpc.request("thread/backgroundTerminals/list", { threadId });
    if (isObject(terminals) && Array.isArray(terminals.data) && terminals.data.length === 0 && terminals.nextCursor == null) break;
    await delay(50);
  } while (Date.now() < until);
  const empty = isObject(terminals) && Array.isArray(terminals.data) && terminals.data.length === 0 && terminals.nextCursor == null;
  const read = await rpc.request("thread/read", { threadId, includeTurns: true });
  const last = isObject(read) && isObject(read.thread) && Array.isArray(read.thread.turns) ? read.thread.turns.at(-1) : undefined;
  const status = isObject(last) && last.id === turnId && ["interrupted", "failed"].includes(String(last.status)) ? String(last.status) as "interrupted" | "failed" : undefined;
  return { interruptAcknowledged, terminalsEmpty: empty, status, needsReconcile: !empty || !status };
}
