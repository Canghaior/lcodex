import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import { assertNoKnownSecrets } from "../../../validation/outbound-data.js";
import { projectModelTools, projectToolPolicy } from "../../../validation/project-tool-policy.js";
import { isObject, JsonLineRpc } from "../../../validation/rpc.js";
import { prepareSerialResponse } from "../../../validation/serial-response.js";
import { TaskLimits, TASK_LIMITS } from "../../../validation/task-limits.js";
import { ToolResponseGate } from "../../../validation/tool-response-gate.js";
import { stopAndReadThread } from "../../../validation/workflow-lifecycle.js";
import type { TaskMode } from "../../shared/contracts.js";
import { writePrivate } from "../../../validation/private-files.js";

export type EngineOptions = { engine: string; shell: string; node: string; root: string; workspace: string; privateDir: string; original: string; rootMarker: string;
  readOnlyAssets: string[]; readOnlyDirectories: string[]; mode: TaskMode; prompt: string; testCommand: string; key: string; ledger: BudgetLedger;
  signal: AbortSignal; onEvent: (method: string, params: unknown) => void; onIdentity: (threadId: string, turnId: string) => void;
  fetchImpl?: typeof fetch; historyHome?: string; resume?: { threadId: string; turnId: string }; onProcessStarted?: () => void; priceConfirmedOn: string };
export type EngineResult = { status: "completed" | "stopped" | "failed" | "reconcile"; code: string | null; threadId: string | null; turnId: string | null; cleanExit: boolean; requests: number };
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
  const limitsFile = path.join(root, "limits.jsonl"); TaskLimits.create(limitsFile);
  const limits = new TaskLimits(limitsFile), abort = new AbortController();
  let failure = "", ended = false, inFlight = false, requests = 0, threadId: string | null = null, turnId: string | null = null;
  let dispatchAllowed = false;
  let rpc: JsonLineRpc | undefined, child: ChildProcessWithoutNullStreams | undefined, closed: Promise<number | null> | undefined;
  let resolveTerminal!: (value: unknown) => void;
  const terminal = new Promise<unknown>(resolve => { resolveTerminal = resolve; });
  const fail = (code: string) => { failure ||= code; abort.abort(new Error(code)); resolveTerminal(null); };
  const userStop = () => fail("TASK_USER_STOP"); options.signal.addEventListener("abort", userStop, { once: true });
  const gate = new ToolResponseGate(limits, abort, { failure: fail, completed: () => {} });
  const writePolicy = projectToolPolicy(workspace, shell, options.rootMarker, options.readOnlyAssets);
  const policy = { functionCall: writePolicy.functionCall, patch: mode === "write" ? writePolicy.patch : () => { throw new Error("TASK_READ_ONLY"); } };
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
        const tools = projectModelTools(parsed.tools.filter(isObject), workspace, shell).filter(tool => mode === "write" || tool.name !== "apply_patch");
        const request = prepareEngineModelRequest(parsed, tools);
        activeUpstream = sendBoundedDeepSeek(ledger, trial, key, request, options.fetchImpl ?? fetch, abort.signal, PROJECT_MAX_INPUT_BYTES);
        const result = await activeUpstream;
        limits.check();
        const batch = prepareSerialResponse(result.wire, result.response, policy);
        // Preserve the validated request command by call ID. The engine's display
        // command includes shell quoting and is not an exact command identity.
        if (Array.isArray(result.response.output)) for (const item of result.response.output) {
          if (isObject(item) && item.type === "function_call" && typeof item.arguments === "string") {
            const args = JSON.parse(item.arguments);
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
  let result: EngineResult = { status: "failed", code: null, threadId, turnId, cleanExit: false, requests: 0 };
  const timer = setTimeout(() => fail("TASK_TIME_LIMIT"), TASK_LIMITS.durationMs);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("GATEWAY_NO_PORT");
    const catalog = validationCatalog(true, mode === "read", mode === "write", true);
    catalog.models[0]!.display_name = "DeepSeek Flash";
    catalog.models[0]!.base_instructions = `You are a coding assistant in an isolated project copy. ${mode === "read" ? "This task is read-only. Analyse and explain; do not modify files or install anything." : "Read relevant code, reproduce issues, implement the requested change, and verify."} Preserve unrelated files. Be concise. Report actual results and limitations, never claim tests you did not run. Reply in the user's language.`;
    writePrivate(historyHome, "models.json", JSON.stringify(catalog));
    writePrivate(historyHome, "config.toml", [
      'model="deepseek-flash"', 'model_provider="workflow"', 'model_reasoning_effort="none"', `model_catalog_json=${quote(path.join(historyHome, "models.json"))}`,
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
    child = spawn(engine, ["app-server", "--listen", "stdio://", "--strict-config"], { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    options.onProcessStarted?.();
    child.stderr.resume(); closed = new Promise(resolve => child!.once("close", code => { if (!ended) resolveTerminal(null); resolve(code); }));
    child.on("error", () => fail("ENGINE_START_FAILED"));
    rpc = new JsonLineRpc(child.stdout, child.stdin, 15_000, 1_048_576, (method, params) => {
      // Ignore events from other conversations; do not accept a fabricated UI state.
      if (isObject(params) && typeof params.threadId === "string" && threadId && params.threadId !== threadId) { fail("ENGINE_EVENT_MISMATCH"); return; }
      if (!dispatchAllowed && ["turn/started", "item/started", "item/commandExecution/outputDelta"].includes(method)) { fail("ENGINE_HISTORY_REPLAY_REFUSED"); return; }
      gate.observe(method, params); if (!abort.signal.aborted) options.onEvent(method, params);
      if (method === "turn/completed") resolveTerminal(params);
    }, true);
    await rpc.request("initialize", { clientInfo: { name: "lcodex_desktop", version: "0.1.0" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
    const threadParameters = { cwd: workspace, approvalPolicy: "never", approvalsReviewer: "user",
      developerInstructions: `Work only in the current isolated project copy. It is a fresh snapshot of the original project; previous tool paths and permissions are historical and no longer valid. Mode=${mode}. For exec_command always supply shell=${JSON.stringify(shell)}, login=false, workdir=${JSON.stringify(workspace)}, yield_time_ms=10000, max_output_tokens<=4096. Run one tool at a time. Command limit 45 seconds, task limit 8 model requests. Node executable: ${node}; use --preserve-symlinks --preserve-symlinks-main before its arguments. No network, dependency installation or escalation. ${options.testCommand ? `The user-selected verification command is exactly: ${options.testCommand}. Run it before and after changes as a separate exec_command call with exactly that cmd string; do not prepend or append other commands, so its exit status can be identified.` : "No verification command was configured. Inspect existing project instructions and report which checks you actually ran; missing tests must remain unverified."} Do not modify protected resources, dependencies, root marker, credentials or unrelated user work. Final response: changes, files, actual checks/results, unfinished work and next step. Changes are pending review, never claim the original project was modified.` };
    const thread = options.resume
      ? await rpc.request("thread/resume", { ...threadParameters, threadId: options.resume.threadId, model: "deepseek-flash", modelProvider: "workflow", config: { default_permissions: "scoped" } })
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
      if (code === undefined) { child?.kill(); code = await wait(closed, 3000); result.status = "reconcile"; result.code = "ENGINE_UNCLEAN_EXIT"; }
      result.cleanExit = code === 0;
      if (code !== 0) { result.status = "reconcile"; result.code ??= "ENGINE_UNCLEAN_EXIT"; }
    } else result.cleanExit = true;
    if (limits.summary().pending || limits.summary().queued) { result.status = "reconcile"; result.code ??= "TASK_TOOL_RESULT_UNKNOWN"; }
    limits.close();
  }
  return { ...result, threadId, turnId, requests };
}
