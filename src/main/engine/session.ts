import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BudgetLedger } from "../../../validation/budget.js";
import { PROJECT_MAX_INPUT_BYTES, sendBoundedDeepSeek } from "../../../validation/deepseek-request.js";
import { localDay } from "../storage/pricing.js";
import { prepareEngineModelRequest } from "../../../validation/engine-model-request.js";
import { isolatedEnvironment } from "../../../validation/isolated-env.js";
import { validationCatalog } from "../../../validation/model-catalog.js";
import { DESKTOP_MODEL } from "../../../validation/deepseek-model.js";
import { assertNoKnownSecrets } from "../../../validation/outbound-data.js";
import { desktopCommandContract, desktopCommandHistory } from "../../../validation/desktop-command-contract.js";
import { SessionProgress, assertFinalAnswer } from "../../../validation/session-progress.js";
import { terminateOwnedProcessTree } from "../../../validation/process-tree-stop.js";
import { isObject, JsonLineRpc } from "../../../validation/rpc.js";
import { TaskLimits, TASK_LIMITS } from "../../../validation/task-limits.js";
import { ToolResponseGate } from "../../../validation/tool-response-gate.js";
import { stopAndReadThread } from "../../../validation/workflow-lifecycle.js";
import type { TaskMode } from "../../shared/contracts.js";
import { writePrivate } from "../../../validation/private-files.js";
import { spawnOwnedEngine } from "../../../validation/owned-engine.js";
import { verifyCompletedHistory } from "./history.js";

export type EngineOptions = { engine: string; shell: string; node: string; root: string; workspace: string; privateDir: string; original: string; rootMarker: string;
  readOnlyAssets: string[]; readOnlyDirectories: string[]; mode: TaskMode; prompt: string; testCommand: string; key: string; ledger: BudgetLedger;
  signal: AbortSignal; onEvent: (method: string, params: unknown) => void; onIdentity: (threadId: string, turnId: string) => void;
  fetchImpl?: typeof fetch; historyHome?: string; resume?: { threadId: string; turnId: string }; onProcessStarted?: () => void; priceConfirmedOn: string; projectFiles?: string[]; scriptDirectory?: string;
  spawnImpl?: typeof spawnOwnedEngine };
export type EngineResult = { status: "completed" | "stopped" | "failed" | "reconcile"; code: string | null; threadId: string | null; turnId: string | null; cleanExit: boolean; processesEnded: boolean; reconciledExit: boolean; requests: number };
export const confirmedSessionExit = (value: Record<string, unknown>) => value.cleanExit === true || value.processesEnded === true && value.reconciledExit === true;
export const safeCode = (error: unknown, fallback: string) => error instanceof Error && /^[A-Z][A-Z0-9_-]{2,80}$/.test(error.message) ? error.message : fallback;
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const requireValue = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
const wait = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); } finally { clearTimeout(timer); } };

// Uses the P1 request, permission, scheduling and budget components. The engine
// still owns the conversation/tool loop; this adapter only enforces its boundary.
export async function executeSession(options: EngineOptions): Promise<EngineResult> {
  const { engine, shell, node, root, workspace, original, key, ledger, mode } = options;
  const historyHome = options.historyHome ?? path.join(root, "home");
  requireValue(localDay() === options.priceConfirmedOn, "PRICE_REVIEW_REQUIRED");
  requireValue(!options.signal.aborted, "TASK_USER_STOP");
  assertNoKnownSecrets(options.prompt, [key]);
  for (const relative of ["home", "profile/roaming", "profile/local/Packages", "temp"]) mkdirSync(path.join(root, relative), { recursive: true });
  mkdirSync(historyHome, { recursive: true });
  const token = randomUUID(), trial = `desktop-${randomUUID()}`;
  const env: NodeJS.ProcessEnv = { ...isolatedEnvironment(root, process.env), CODEX_HOME: historyHome, LCODEX_WORKFLOW_TOKEN: token };
  env.PATH = [path.dirname(node), path.dirname(shell), path.join(process.env.SystemRoot ?? "C:/Windows", "System32"), process.env.SystemRoot ?? "C:/Windows"].join(path.delimiter);
  env.NODE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main";
  // npm 11 enables Node's disk compile cache on startup. In the fixed MXC
  // profile that path can stall before any command output; no cache is needed
  // for a bounded task. Do not broaden filesystem grants to accommodate it.
  env.NODE_DISABLE_COMPILE_CACHE = "1";
  env.NPM_CONFIG_CACHE = path.join(root, "profile/local/Packages/npm-cache");
  env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  env.NPM_CONFIG_FUND = "false";
  // Retain only fixed lifecycle flags, never engine stderr text or tool data.
  env.RUST_LOG = "error,codex_app_server=info";
  const shutdownTrace = { processorExited: false, outboundExited: false, stdioClosed: false, backgroundTimeout: false, threadTimeout: false };
  const limitsFile = path.join(root, "limits.jsonl"); TaskLimits.create(limitsFile);
  const limits = new TaskLimits(limitsFile), abort = new AbortController();
  let failure = "", ended = false, inFlight = false, requests = 0, threadId: string | null = null, turnId: string | null = null;
  let dispatchAllowed = false;
  let rpc: JsonLineRpc | undefined, child: ChildProcessWithoutNullStreams | undefined, closed: Promise<number | null> | undefined;
  let owner: ReturnType<typeof spawnOwnedEngine> | undefined;
  let resolveTerminal!: (value: unknown) => void;
  const terminal = new Promise<unknown>(resolve => { resolveTerminal = resolve; });
  const fail = (code: string) => { failure ||= code; abort.abort(new Error(code)); resolveTerminal(null); };
  const userStop = () => fail("TASK_USER_STOP"); options.signal.addEventListener("abort", userStop, { once: true });
  const progress = new SessionProgress(options.testCommand, mode === "write");
  const gate = new ToolResponseGate(limits, abort, { failure: fail,
    completed: result => progress.completed(result), event: kind => { if (kind === "started") progress.started(); } });
  let activeUpstream: ReturnType<typeof sendBoundedDeepSeek> | undefined;
  let activeRequest: Promise<void> | undefined;
  const server = createServer((req, res) => {
    const handle = async () => {
      let owned = false;
      try {
        requireValue(req.headers.authorization === `Bearer ${token}` && req.method === "POST" && req.url === "/v1/responses", "GATEWAY_AUTH_REFUSED");
        requireValue(dispatchAllowed && !inFlight && !failure && !abort.signal.aborted, "GATEWAY_STOPPED"); owned = true; inFlight = true;
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; requireValue(size <= 131_072, "GATEWAY_INPUT_LIMIT"); chunks.push(bytes); }
        const body = new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
        assertNoKnownSecrets(body, [key, token]);
        const parsed: unknown = JSON.parse(body);
        if (!isObject(parsed) || !Array.isArray(parsed.tools)) throw new Error("GATEWAY_REQUEST_INVALID");
        limits.request(); requests++;
        const usage = limits.summary();
        const remainingTools = TASK_LIMITS.tools - usage.tools;
        const remainingRounds = TASK_LIMITS.toolRounds - usage.toolRounds;
        const contract = desktopCommandContract({ workspace, shell, rootMarker: options.rootMarker, readOnlyAssets: options.readOnlyAssets,
          readOnly: mode === "read", ...(progress.verificationOnly(requests, remainingTools, remainingRounds) ? { verifyCommand: options.testCommand } : {}) });
        const tools = contract.tools(parsed.tools.filter(isObject));
        // An exhausted tool budget also leaves only a summary, even if fewer
        // than eight model requests were used. Never permit a thirteenth tool.
        const finalResponseOnly = requests === TASK_LIMITS.requests || remainingTools === 0 || remainingRounds === 0;
        const request = prepareEngineModelRequest({ ...parsed, input: desktopCommandHistory(parsed.input) }, tools,
          { finalResponseOnly, progressInstruction: progress.instruction(requests, remainingTools, remainingRounds) });
        activeUpstream = sendBoundedDeepSeek(ledger, trial, key, request, options.fetchImpl ?? fetch, abort.signal, PROJECT_MAX_INPUT_BYTES);
        const result = await activeUpstream;
        limits.check();
        requireValue(result.terminalType === "response.completed", result.terminalType === "response.incomplete" ? "API_RESPONSE_INCOMPLETE" : "API_RESPONSE_FAILED");
        const adapted = contract.response(result.wire, result.response), batch = adapted.batch;
        // tool_choice and instructions are not enforcement. Refuse all tool
        // events before exposing any bytes if the model ignores the final call.
        requireValue(!finalResponseOnly || batch.calls.length === 0, "TASK_FINAL_RESPONSE_TOOL_REFUSED");
        if (finalResponseOnly) assertFinalAnswer(adapted.response.output);
        // Preserve the validated request command by call ID. The engine's display
        // command includes shell quoting and is not an exact command identity.
        if (Array.isArray(adapted.response.output)) for (const item of adapted.response.output) {
          if (isObject(item) && item.type === "function_call" && typeof item.arguments === "string") {
            const args = JSON.parse(item.arguments);
            progress.plan(String(item.call_id), args.cmd);
            options.onEvent("boundary/toolPlan", { id: item.call_id, command: args.cmd });
          }
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        await gate.deliver(batch, bytes => { res.write(bytes); }); res.end();
      } catch (error) {
        if (owned) fail(safeCode(error, "GATEWAY_FAILED"));
        if (res.headersSent) res.destroy(); else { res.writeHead(400); res.end(JSON.stringify({ error: { message: owned ? failure : "GATEWAY_AUTH_REFUSED" } })); }
      } finally { if (owned) inFlight = false; }
    };
    const primary = !inFlight; const handling = handle(); if (primary) activeRequest = handling;
  });
  server.requestTimeout = 65_000; server.headersTimeout = 10_000; server.maxConnections = 4;
  let result: EngineResult = { status: "failed", code: null, threadId, turnId, cleanExit: false, processesEnded: false, reconciledExit: false, requests: 0 };
  const timer = setTimeout(() => fail("TASK_TIME_LIMIT"), TASK_LIMITS.durationMs);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("GATEWAY_NO_PORT");
    const catalog = validationCatalog(true, mode === "read", mode === "write", true);
    catalog.models[0]!.slug = DESKTOP_MODEL.id;
    catalog.models[0]!.display_name = `${DESKTOP_MODEL.label} · 高强度思考`;
    catalog.models[0]!.default_reasoning_level = DESKTOP_MODEL.effort;
    catalog.models[0]!.supported_reasoning_levels = [{ effort: DESKTOP_MODEL.effort, description: "High thinking for coding tasks" }];
    catalog.models[0]!.base_instructions = `You are a coding assistant in an isolated project copy. ${mode === "read" ? "This task is read-only. Analyse and explain; do not modify files or install anything." : "Read relevant code, reproduce issues, implement the requested change, and verify."} When the user names a source path, inspect that path first and avoid repeated directory inventories. Keep reads focused on relevant excerpts. Preserve unrelated files. Be concise. Report actual results and limitations, never claim tests you did not run. Reply in the user's language.`;
    writePrivate(historyHome, "models.json", JSON.stringify(catalog));
    writePrivate(historyHome, "config.toml", [
      `model=${quote(DESKTOP_MODEL.id)}`, 'model_provider="workflow"', `model_reasoning_effort=${quote(DESKTOP_MODEL.effort)}`, `model_catalog_json=${quote(path.join(historyHome, "models.json"))}`,
      `project_root_markers=[${quote(options.rootMarker)}]`, 'approval_policy="never"', 'default_permissions="scoped"', 'web_search="disabled"', 'allow_login_shell=false',
      '[windows]', 'sandbox="mxc"', '[permissions.scoped.filesystem]', '":minimal"="read"', `${quote(workspace)}="${mode === "read" ? "read" : "write"}"`,
      `${quote(original)}="deny"`, `${quote(options.privateDir)}="deny"`, `${quote(historyHome)}="deny"`, `${quote(path.join(workspace, options.rootMarker))}="read"`,
      ...options.readOnlyAssets.map(relative => `${quote(path.join(workspace, relative))}="read"`), ...options.readOnlyDirectories.map(relative => `${quote(path.join(workspace, relative))}="read"`),
      ...[".git", ".env", ".codex", ".agents"].map(relative => `${quote(path.join(workspace, relative))}="deny"`),
      `${quote(path.dirname(node))}="read"`, `${quote(path.dirname(shell))}="read"`, `${quote(path.dirname(process.env.COMSPEC ?? "C:/Windows/System32/cmd.exe"))}="read"`, `${quote(path.join(root, "profile/local/Packages"))}="write"`,
      '[permissions.scoped.network]', 'enabled=false', '[features]', 'multi_agent=false', 'apps=false', 'plugins=false', 'hooks=false', 'goals=false', 'shell_snapshot=false', 'browser_use=false', 'computer_use=false', 'image_generation=false',
      '[shell_environment_policy]', 'inherit="all"', 'ignore_default_excludes=false', '[shell_environment_policy.filters]', 'LCODEX_WORKFLOW_TOKEN="exclude"', 'DEEPSEEK_API_KEY="exclude"',
      '[analytics]', 'enabled=false', '[model_providers.workflow]', 'name="lcodex bounded DeepSeek"', `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false', 'env_key="LCODEX_WORKFLOW_TOKEN"', 'request_max_retries=0', 'stream_max_retries=0', '',
    ].join("\n"));
    requireValue(!abort.signal.aborted, "TASK_USER_STOP");
    owner = (options.spawnImpl ?? spawnOwnedEngine)({ engine, shell, root, cwd: workspace, env, args: ["app-server", "--listen", "stdio://", "--strict-config"],
      ...(options.scriptDirectory ? { scriptDirectory: options.scriptDirectory } : {}) });
    child = owner.child;
    options.onProcessStarted?.();
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      shutdownTrace.processorExited ||= text.includes("processor task exited");
      shutdownTrace.outboundExited ||= text.includes("outbound router task exited");
      shutdownTrace.stdioClosed ||= text.includes("stdio_connection_closed");
      shutdownTrace.backgroundTimeout ||= /timed out waiting.*background/i.test(text);
      shutdownTrace.threadTimeout ||= /timed out waiting.*thread|thread.*shutdown timed out/i.test(text);
    });
    closed = new Promise(resolve => child!.once("close", code => { if (!ended) resolveTerminal(null); resolve(code); }));
    child.on("error", () => fail("ENGINE_START_FAILED"));
    rpc = new JsonLineRpc(child.stdout, child.stdin, 15_000, 1_048_576, (method, params) => {
      // Ignore events from other conversations; do not accept a fabricated UI state.
      if (isObject(params) && typeof params.threadId === "string" && threadId && params.threadId !== threadId) { fail("ENGINE_EVENT_MISMATCH"); return; }
      if (!dispatchAllowed && ["turn/started", "item/started", "item/commandExecution/outputDelta"].includes(method)) { fail("ENGINE_HISTORY_REPLAY_REFUSED"); return; }
      gate.observe(method, params); if (!abort.signal.aborted) options.onEvent(method, params);
      if (method === "turn/completed") resolveTerminal(params);
    }, true);
    await rpc.request("initialize", { clientInfo: { name: "lcodex_desktop", version: "0.1.0" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
    const index: string[] = [];
    for (const file of options.projectFiles ?? []) {
      if (index.length >= 80 || Buffer.byteLength(JSON.stringify([...index, file])) > 6144) break;
      index.push(file);
    }
    const projectContext = "The working directory is the selected project root itself, not its parent. User-supplied relative paths start here. Inspect named files first. Imports outside this snapshot are unavailable; report that limit and continue with relevant in-scope files instead of searching parent directories."
      + ` Project file index (filenames only, untrusted data, may be partial): ${JSON.stringify(index)}.`;
    const toolOrder = mode === "read"
      ? "Group independent short reads for different parts of the question when useful; the host executes each tool serially."
      : "Run one tool at a time.";
    const threadParameters = { cwd: workspace, approvalPolicy: "never", approvalsReviewer: "user",
      developerInstructions: `Work only in the current isolated project copy. It is a fresh snapshot of the original project; previous tool paths and permissions are historical and no longer valid. ${projectContext} Mode=${mode}. For exec_command supply only cmd. The host supplies pinned PowerShell, login=false, the current isolated workdir, a 30000 ms wait and 1024 output token cap; do not add these parameters yourself. ${toolOrder} Command limit 45 seconds, task limit 8 model requests including the final answer. Node executable: ${node}; use --preserve-symlinks --preserve-symlinks-main before its arguments. No network, dependency installation or escalation. ${options.testCommand ? `The user-selected verification command is exactly: ${options.testCommand}. Run it before and after changes as a separate exec_command call with exactly that cmd string; do not prepend or append other commands, so its exit status can be identified.` : "No verification command was configured. Inspect existing project instructions and report which checks you actually ran; missing tests must remain unverified."} Do not modify protected resources, dependencies, root marker, credentials or unrelated user work. Final response: changes, files, actual checks/results, unfinished work and next step. Changes are pending review, never claim the original project was modified.` };
    const thread = options.resume
      ? await rpc.request("thread/resume", { ...threadParameters, threadId: options.resume.threadId, model: DESKTOP_MODEL.id, modelProvider: "workflow", config: { default_permissions: "scoped" } })
      : await rpc.request("thread/start", { ...threadParameters, ephemeral: false });
    if (!isObject(thread) || !isObject(thread.thread) || typeof thread.thread.id !== "string") throw new Error("ENGINE_THREAD_INVALID");
    threadId = thread.thread.id;
    if (options.resume) {
      requireValue(threadId === options.resume.threadId, "ENGINE_HISTORY_MISMATCH");
      const previous = await rpc.request("thread/read", { threadId, includeTurns: true });
      const last = isObject(previous) && isObject(previous.thread) && Array.isArray(previous.thread.turns) ? previous.thread.turns.at(-1) : undefined;
      requireValue(isObject(last) && last.id === options.resume.turnId && last.status === "completed", "ENGINE_HISTORY_MISMATCH");
    }
    requireValue(!abort.signal.aborted, "TASK_USER_STOP");
    dispatchAllowed = true;
    const started = await rpc.request("turn/start", { threadId, cwd: workspace, input: [{ type: "text", text: options.prompt, text_elements: [] }] });
    if (!isObject(started) || !isObject(started.turn) || typeof started.turn.id !== "string") throw new Error("ENGINE_TURN_INVALID");
    turnId = started.turn.id; options.onIdentity(threadId, turnId);
    const done = await terminal;
    if (failure) throw new Error(failure);
    if (!isObject(done) || !isObject(done.turn) || done.turn.id !== turnId || done.turn.status !== "completed") throw new Error("ENGINE_TURN_FAILED");
    limits.check(); requireValue(limits.summary().pending === 0 && limits.summary().queued === 0, "TASK_TOOL_RESULT_UNKNOWN");
    const background = await rpc.request("thread/backgroundTerminals/list", { threadId });
    requireValue(isObject(background) && Array.isArray(background.data) && background.data.length === 0 && background.nextCursor == null, "ENGINE_TERMINALS_ACTIVE");
    const history = await rpc.request("thread/read", { threadId, includeTurns: true });
    const last = isObject(history) && isObject(history.thread) && Array.isArray(history.thread.turns) ? history.thread.turns.at(-1) : undefined;
    requireValue(isObject(last) && last.id === turnId && last.status === "completed", "ENGINE_STATE_MISMATCH");
    result.status = "completed";
  } catch (error) {
    failure ||= safeCode(error, "ENGINE_TASK_FAILED");
    result.code = failure;
    if (rpc && threadId && turnId) {
      try { const stopped = await stopAndReadThread(rpc, threadId, turnId); result.status = stopped.needsReconcile ? "reconcile" : failure === "TASK_USER_STOP" ? "stopped" : "failed"; }
      catch { result.status = "reconcile"; }
    } else result.status = child ? "reconcile" : failure === "TASK_USER_STOP" ? "stopped" : "failed";
  } finally {
    ended = true; clearTimeout(timer); options.signal.removeEventListener("abort", userStop); abort.abort(); gate.close();
    await activeUpstream?.catch(() => {});
    server.closeAllConnections(); await wait(activeRequest ?? Promise.resolve(), 2000);
    await new Promise<void>(resolve => server.close(() => resolve()));
    rpc?.abort(new Error("ENGINE_SESSION_CLOSED")); child?.stdin.end();
    if (closed) {
      let code = await wait(closed, 25_000);
      if (code === undefined) {
        writePrivate(root, "shutdown-diagnostic.json", JSON.stringify({
          version: 1, ownerPid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null,
          stdoutEnded: child?.stdout.readableEnded ?? false, stderrEnded: child?.stderr.readableEnded ?? false,
          pendingTools: limits.summary().pending, queuedTools: limits.summary().queued, threadId, turnId, ...shutdownTrace,
        }));
        owner?.stop(); code = await wait(closed, 8000);
        if (code === undefined) {
          try { if (child) await terminateOwnedProcessTree(child); } catch { result.code = "ENGINE_TREE_STOP_FAILED"; }
          code = await wait(closed, 3000);
        }
      }
      const exited = owner?.result();
      result.processesEnded = code === 0 && exited?.processesEnded === true;
      result.cleanExit = result.processesEnded && exited?.forced === false && exited.engineExitCode === 0;
      if (!result.cleanExit) {
        // A forced exit is never completion evidence. Reconcile only an already
        // acknowledged terminal result, with no pending tools, using a fresh
        // engine that has no model credential or execution entry point.
        if (result.processesEnded && result.status !== "reconcile" && threadId && turnId && !limits.summary().pending && !limits.summary().queued) {
          try {
            const state = await verifyCompletedHistory(engine, root, historyHome, threadId, turnId, result.status !== "completed", shell, options.scriptDirectory);
            requireValue(result.status === "completed" ? state === "completed" : ["interrupted", "failed"].includes(state), "ENGINE_STATE_MISMATCH");
            result.reconciledExit = true;
          } catch { result.status = "reconcile"; result.code ??= "ENGINE_UNCLEAN_EXIT"; }
        } else { result.status = "reconcile"; result.code ??= "ENGINE_UNCLEAN_EXIT"; }
      }
    } else { result.cleanExit = true; result.processesEnded = true; }
    if (limits.summary().pending || limits.summary().queued) { result.status = "reconcile"; result.code ??= "TASK_TOOL_RESULT_UNKNOWN"; }
    limits.close();
  }
  return { ...result, threadId, turnId, requests };
}
