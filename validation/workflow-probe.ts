import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BudgetLedger } from "./budget.js";
import { MAX_OUTPUT_TOKENS, PRICE_REVIEW_DATE, sendBoundedDeepSeek } from "./deepseek-request.js";
import { prepareEngineModelRequest } from "./engine-model-request.js";
import { isolatedEnvironment } from "./isolated-env.js";
import { validationCatalog } from "./model-catalog.js";
import { assertNoKnownSecrets } from "./outbound-data.js";
import { projectModelTools, projectToolPolicy } from "./project-tool-policy.js";
import { readKey } from "./read-key.js";
import { prepareSerialResponse } from "./serial-response.js";
import { ToolResponseGate } from "./tool-response-gate.js";
import { createProcessTreeFixture, stopAndReadThread, verifyTreeStopped, waitForProcessTree } from "./workflow-lifecycle.js";
import { checkRestart } from "./resume-check.js";
import { prepareResourceFixture, resourceBoundaryCommand } from "./workflow-resources.js";
import { prepareReviewWorkspace } from "./review-workspace.js";
import { isObject, JsonLineRpc } from "./rpc.js";
import { createRunDirectory } from "./run-directory.js";
import { snapshot } from "./fixtures.js";
import { TaskLimits, TASK_LIMITS } from "./task-limits.js";
import { contentHash, WindowsFileGuard } from "./windows-file-guard.js";
import { createWorkflowEvaluator, createWorkflowSample, nodeFlags, psQuote, SampleKind } from "./workflow-sample.js";

function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
let activeLedger: BudgetLedger | undefined;
let activeLimits: TaskLimits | undefined;
function mockWire(item: Record<string, unknown>, sequence: number) {
  const response = { id: `mock-${sequence}`, object: "response", status: "completed", model: "deepseek-flash", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  const message = item.type === "message";
  const text = message ? "Changes prepared and project tests executed. Review before applying." : "";
  const content = { type: "output_text", text, annotations: [] };
  if (message) item.content = [content];
  const events = [
    { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: message ? { ...item, content: [], status: "in_progress" } : item },
    ...(message ? [
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
      { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: content },
    ] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return { response, wire: events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("") };
}

function mockBatchWire(items: Record<string, unknown>[]) {
  const response = { id: "mock-batch", status: "completed", output: items, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    ...items.flatMap((item, output_index) => [{ type: "response.output_item.added", item, output_index }, { type: "response.output_item.done", item, output_index }]),
    { type: "response.completed", response }];
  return { response, wire: events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("") };
}

async function main() {
  const [binary, shell, kind, ...flags] = process.argv.slice(2);
  check(binary && shell && (kind === "bug" || kind === "feature") && flags.every(flag => ["--live", "--serial-batch", "--long-command", "--stop-tree", "--deadline-tree", "--disconnect-after-write", "--resume-continue", "--resources", "--limit-case=requests", "--limit-case=failures", `--price-reviewed=${PRICE_REVIEW_DATE}`].includes(flag)), "WORKFLOW_ARGUMENTS");
  check(contentHash(readFileSync(binary)) === "dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f", "WORKFLOW_ENGINE_VERSION");
  const node = realpathSync(process.execPath);
  check(contentHash(readFileSync(node)) === "3a9ac860c566b7aebf144be914f95e3ec36dc88040aa7acb5d9d1e6e0c7afd5e", "WORKFLOW_NODE_VERSION");
  const live = flags.includes("--live");
  const serialBatch = flags.includes("--serial-batch");
  const longCommand = flags.includes("--long-command");
  const treeMode = flags.includes("--stop-tree") ? "stop" : flags.includes("--deadline-tree") ? "deadline" : undefined;
  const disconnected = flags.includes("--disconnect-after-write");
  const resumeContinue = flags.includes("--resume-continue");
  const resources = flags.includes("--resources");
  const treeDuration = treeMode === "deadline" ? 55_000 : 8_000;
  const limitCase = flags.find(flag => flag.startsWith("--limit-case="))?.slice("--limit-case=".length);
  check(!limitCase || !live, "WORKFLOW_LIMIT_MODE_REFUSED");
  check(!serialBatch || !live && !limitCase, "WORKFLOW_BATCH_MODE_REFUSED");
  check(!longCommand || !live && !limitCase && !serialBatch, "WORKFLOW_LONG_MODE_REFUSED");
  check(!treeMode && !disconnected || !live && !limitCase && !serialBatch && !longCommand && !(treeMode && disconnected), "WORKFLOW_LIFECYCLE_MODE_REFUSED");
  check(!(flags.includes("--stop-tree") && flags.includes("--deadline-tree")), "WORKFLOW_LIFECYCLE_MODE_REFUSED");
  check(!resumeContinue || !treeMode && !disconnected && !limitCase, "WORKFLOW_CONTINUE_MODE_REFUSED");
  check(!resources || !live && !treeMode && !disconnected && !limitCase && !serialBatch && !longCommand, "WORKFLOW_RESOURCE_MODE_REFUSED");
  if (live) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    check(today === PRICE_REVIEW_DATE && flags.includes(`--price-reviewed=${PRICE_REVIEW_DATE}`), "WORKFLOW_PRICE_REVIEW_REQUIRED");
  }
  let key = live ? await readKey() : "";
  const ledger = live ? new BudgetLedger(path.resolve(".local/state/p1-budget.jsonl")) : undefined;
  activeLedger = ledger;
  const run = createRunDirectory("workflow 中文项目");
  for (const dir of ["home", "profile/roaming", "profile/local/Packages", "temp", "project", "state", "evaluator"]) mkdirSync(path.join(run.root, dir), { recursive: true });
  const original = path.join(run.root, "project"), state = path.join(run.root, "state"), token = randomUUID();
  const prompt = createWorkflowSample(original, kind as SampleKind);
  const guard = new WindowsFileGuard(shell, run.root);
  const resourceEvidence = resources ? await prepareResourceFixture(original, guard) : undefined;
  if (treeMode) createProcessTreeFixture(original, treeDuration);
  const originalBefore = snapshot(original);
  const task = await prepareReviewWorkspace(original, state, guard);
  const cwd = task.workspace, policy = projectToolPolicy(cwd, shell, task.rootMarker, task.readOnlyAssets);
  const evaluator = createWorkflowEvaluator(path.join(run.root, "evaluator"), kind as SampleKind);
  const env = { ...isolatedEnvironment(run.root, process.env), LCODEX_WORKFLOW_TOKEN: token };
  const limitsFile = path.join(state, "limits.jsonl"); TaskLimits.create(limitsFile);
  const limits = new TaskLimits(limitsFile), trial = `workflow-${kind}-${randomUUID()}`;
  activeLimits = limits;
  const abort = new AbortController();
  const continuationAbort = new AbortController();
  let continuationMode = false, continuationHistoryMatched = false;
  let failure = "";
  let inFlight = false, requests = 0, activeUpstream: ReturnType<typeof sendBoundedDeepSeek> | undefined;
  const usage: unknown[] = [], toolResults: unknown[] = [], envelopes: unknown[] = [];
  const toolEvents: string[] = [];
  const itemEvents: { method: string; type: string; id: string; status: unknown; exitCode: unknown }[] = [];
  let batchHistoryMatched = false;
  const toolGate = new ToolResponseGate(limits, abort, { failure: code => { failure = code; terminal(null); },
    completed: result => { toolResults.push(result); }, event: (kind, id) => { toolEvents.push(`${kind}:${id}`); } });
  const testCommand = (resources ? `& ${psQuote(node)} ${nodeFlags} './node_modules/typescript/bin/tsc' --strict --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext './src/dependency-check.ts'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ` : "") +
    `& ${psQuote(node)} ${nodeFlags} --test; exit $LASTEXITCODE`;
  const source = readFileSync(path.join(cwd, "src/catalog.mjs"), "utf8");
  const mockCandidate = kind === "bug" ? "export function total(items) { return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0); }\n"
    : source + "export function findByLabel(items, query) { return items.find(item => normalizeLabel(item.label) === normalizeLabel(query)) ?? null; }\n";
  const patch = "*** Begin Patch\n*** Update File: src/catalog.mjs\n@@\n" + source.trimEnd().split("\n").map(line => "-" + line).join("\n") + "\n" + mockCandidate.trimEnd().split("\n").map(line => "+" + line).join("\n") +
    (kind === "feature" ? "\n*** Add File: test/find.test.mjs\n+import test from 'node:test';\n+import assert from 'node:assert/strict';\n+import {findByLabel} from '../src/catalog.mjs';\n+test('find',()=>{assert.equal(findByLabel([{label:'A',id:1}], ' a ').id,1); assert.equal(findByLabel([], 'a'),null);});" : "") + "\n*** End Patch";
  const server = createServer(async (req, res) => {
    let owned = false;
    try {
      check(req.headers.authorization === `Bearer ${token}` && req.method === "POST" && req.url?.endsWith("/responses"), "WORKFLOW_GATEWAY_AUTH");
      check(!inFlight && !failure && (continuationMode || !abort.signal.aborted), "WORKFLOW_GATEWAY_STOPPED"); inFlight = true; owned = true;
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; check(size <= 131_072, "WORKFLOW_RAW_INPUT_LIMIT"); chunks.push(bytes); }
      const body = new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
      const parsed: unknown = JSON.parse(body); check(isObject(parsed) && Array.isArray(parsed.tools), "WORKFLOW_REQUEST_INVALID");
      assertNoKnownSecrets(body, [key, token].filter(Boolean));
      if (continuationMode) {
        continuationHistoryMatched = Array.isArray(parsed.input) && parsed.input.some(item => isObject(item) && ["function_call_output", "custom_tool_call_output"].includes(String(item.type)));
        check(continuationHistoryMatched, "WORKFLOW_CONTINUATION_HISTORY_MISSING");
      }
      if (serialBatch && requests === 1) {
        const input = parsed.input; check(Array.isArray(input), "WORKFLOW_BATCH_HISTORY_MISSING");
        batchHistoryMatched = ["mock-batch-one", "mock-batch-two"].every(id => input.filter(isObject).filter(item => item.type === "function_call_output" && item.call_id === id).length === 1);
        check(batchHistoryMatched, "WORKFLOW_BATCH_HISTORY_MISSING");
      }
      limits.request(); requests++;
      let response: Record<string, unknown>, wire: string;
      if (live && ledger) {
        const tools = continuationMode ? [] : projectModelTools(parsed.tools.filter(isObject), cwd, shell);
        const request = prepareEngineModelRequest(parsed, tools);
        activeUpstream = sendBoundedDeepSeek(ledger, trial, key, request, fetch, continuationMode ? continuationAbort.signal : abort.signal, 49_152);
        const result = await activeUpstream; response = result.response; wire = result.wire; usage.push(result.usage);
      } else {
        const item = limitCase ? { id: `mock-item-${requests}`, type: "function_call", name: "exec_command", call_id: `mock-call-${requests}`, status: "completed", arguments: JSON.stringify({ cmd: limitCase === "failures" ? "exit 1" : "Get-Content -LiteralPath './src/catalog.mjs' -Raw", shell, workdir: cwd, login: false, yield_time_ms: 10000, max_output_tokens: 2048 }) }
          : requests === 2 ? { id: "mock-item-2", type: "custom_tool_call", name: "apply_patch", call_id: "mock-call-2", input: patch, status: "completed" }
          : requests <= 3 ? { id: `mock-item-${requests}`, type: "function_call", name: "exec_command", call_id: `mock-call-${requests}`, status: "completed", arguments: JSON.stringify({ cmd: requests === 1 ? (resourceEvidence ? resourceBoundaryCommand(cwd, resourceEvidence.assetHash) : (longCommand ? "Start-Sleep -Seconds 12; " : "") + "Get-Content -LiteralPath './src/catalog.mjs' -Raw") : testCommand, shell, workdir: cwd, login: false, yield_time_ms: 10000, max_output_tokens: 2048 }) }
          : { id: "mock-final", type: "message", role: "assistant", status: "completed" };
        ({ response, wire } = mockWire(item, requests));
        if (serialBatch && requests === 1) {
          const orderFile = psQuote(path.join(cwd, ".batch-order"));
          const commands = [`Start-Sleep -Milliseconds 150; [IO.File]::WriteAllText(${orderFile}, 'first'); Get-Content -LiteralPath './src/catalog.mjs' -Raw`,
            `if ([IO.File]::ReadAllText(${orderFile}) -cne 'first') { throw 'BATCH_ORDER_FAILED' }; [IO.File]::AppendAllText(${orderFile}, '-second'); Get-Content -LiteralPath './src/catalog.mjs' -Raw`];
          ({ response, wire } = mockBatchWire(commands.map((cmd, index) => ({ type: "function_call", id: `batch-item-${index}`, call_id: index === 0 ? "mock-batch-one" : "mock-batch-two", name: "exec_command", status: "completed",
            arguments: JSON.stringify({ cmd, shell, workdir: cwd, login: false, yield_time_ms: 10000, max_output_tokens: 2048 }) }))));
        }
        if (treeMode && requests === 1) {
          const commands = [`& ${psQuote(node)} ${nodeFlags} './process-tree.mjs' parent; exit $LASTEXITCODE`, "Set-Content -LiteralPath './queued-must-not-run.txt' -Value 'UNEXPECTED'"];
          ({ response, wire } = mockBatchWire(commands.map((cmd, index) => ({ type: "function_call", id: `tree-item-${index}`, call_id: `tree-call-${index}`, name: "exec_command", status: "completed",
            arguments: JSON.stringify({ cmd, shell, workdir: cwd, login: false, yield_time_ms: 10000, max_output_tokens: 2048 }) }))));
        }
        if (disconnected && requests === 1) ({ response, wire } = mockWire({ type: "function_call", id: "effect-item", call_id: "effect-call", name: "exec_command", status: "completed",
          arguments: JSON.stringify({ cmd: "[IO.File]::AppendAllText((Join-Path (Get-Location) 'effect.txt'), 'ONCE'); Get-Content -LiteralPath './src/catalog.mjs' -Raw", shell, workdir: cwd, login: false, yield_time_ms: 10000, max_output_tokens: 2048 }) }, requests));
      }
      limits.check();
      envelopes.push(Array.isArray(response.output) ? response.output.filter(isObject).filter(item => ["function_call", "custom_tool_call"].includes(String(item.type))).map(item => {
        let args: unknown; try { args = JSON.parse(String(item.arguments)); } catch { args = null; }
        return { type: item.type, name: item.name, fields: isObject(args) ? Object.keys(args) : [],
          ...(isObject(args) ? { shellMatches: args.shell === shell, login: args.login, cwdMatches: args.workdir === cwd, yieldMs: args.yield_time_ms, outputTokens: args.max_output_tokens } : {}) };
      }) : []);
      const batch = prepareSerialResponse(wire, response, policy);
      if (continuationMode) check(batch.calls.length === 0, "WORKFLOW_CONTINUATION_TOOL_REFUSED");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (continuationMode) {
        await batch.deliver({ signal: continuationAbort.signal, write: bytes => { res.write(bytes); }, beforeTool: () => { throw new Error("WORKFLOW_CONTINUATION_TOOL_REFUSED"); }, afterTool: async () => {} });
        res.end(); return;
      }
      await toolGate.deliver(batch, bytes => {
        if (disconnected && requests === 1 && bytes.startsWith("event: response.completed\n")) throw new Error("WORKFLOW_SIMULATED_DISCONNECT");
        res.write(bytes);
      }); res.end();
    } catch (error) {
      failure ||= error instanceof Error && /^(WORKFLOW_|TASK_|API_|SSE_|BUDGET_|PROJECT_|PROBE_|BATCH_)[A-Z0-9_]+$/.test(error.message) ? error.message : "WORKFLOW_GATEWAY_FAILED";
      if (res.headersSent) res.destroy();
      else { res.writeHead(400); res.end(JSON.stringify({ error: { message: failure } })); }
    } finally { if (owned) inFlight = false; }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); check(address && typeof address !== "string", "WORKFLOW_NO_PORT");
  const catalog = validationCatalog(true, false, true, true);
  catalog.models[0]!.base_instructions = "You are a coding assistant in an isolated project copy. Read the relevant code, make the requested changes, and test. Execute one tool call at a time. Preserve unrelated files. Never claim validation you did not run.";
  writeFileSync(path.join(run.root, "home/models.json"), JSON.stringify(catalog));
  writeFileSync(path.join(run.root, "home/config.toml"), [
    'model="deepseek-flash"', 'model_provider="workflow"', 'model_reasoning_effort="none"', `model_catalog_json=${psQuote(path.join(run.root, "home/models.json"))}`,
    `project_root_markers=[${psQuote(task.rootMarker)}]`, 'approval_policy="never"', 'default_permissions="scoped"', 'web_search="disabled"', 'allow_login_shell=false',
    '[windows]', 'sandbox="mxc"', '[permissions.scoped.filesystem]', '":minimal"="read"', `${psQuote(cwd)}="write"`,
    `${psQuote(original)}="deny"`, `${psQuote(path.join(task.taskDirectory, "private"))}="deny"`, `${psQuote(path.join(cwd, task.rootMarker))}="read"`,
    ...task.readOnlyAssets.map(relative => `${psQuote(path.join(cwd, relative))}="read"`),
    ...task.readOnlyDirectories.map(relative => `${psQuote(path.join(cwd, relative))}="read"`),
    `${psQuote(path.join(cwd, ".git"))}="deny"`, `${psQuote(path.join(cwd, ".env"))}="deny"`,
    ...[".codex", ".agents"].map(name => `${psQuote(path.join(cwd, name))}="deny"`),
    `${psQuote(evaluator.file)}="read"`, `${psQuote(path.dirname(node))}="read"`, `${psQuote(path.dirname(shell))}="read"`,
    `${psQuote(path.dirname(process.env.COMSPEC ?? "C:/Windows/System32/cmd.exe"))}="read"`, `${psQuote(path.join(run.root, "profile/local/Packages"))}="write"`,
    '[permissions.scoped.network]', 'enabled=false', '[features]', 'multi_agent=false', 'apps=false', 'plugins=false', 'hooks=false', 'goals=false', 'shell_snapshot=false', 'browser_use=false', 'computer_use=false', 'image_generation=false',
    '[shell_environment_policy]', 'inherit="all"', 'ignore_default_excludes=false', '[shell_environment_policy.filters]', 'LCODEX_WORKFLOW_TOKEN="exclude"', 'DEEPSEEK_API_KEY="exclude"',
    '[analytics]', 'enabled=false', '[model_providers.workflow]', 'name="P1 bounded workflow"', `base_url="http://127.0.0.1:${address.port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false', 'env_key="LCODEX_WORKFLOW_TOKEN"', 'request_max_retries=0', 'stream_max_retries=0', '',
  ].join("\n"));
  let baseline: ReturnType<typeof evaluator.run> | undefined, acceptance: ReturnType<typeof evaluator.run> | undefined;
  let result: Record<string, unknown> = { status: "failed" }, threadId: string | undefined, turnId: string | undefined, exitCode: number | null | undefined;
  let stopEvidence: Awaited<ReturnType<typeof stopAndReadThread>> | undefined;
  let treeEvidence: Awaited<ReturnType<typeof verifyTreeStopped>> | undefined;
  let restarted: Awaited<ReturnType<typeof checkRestart>> | undefined;
  let recoveredLimits: unknown;
  let child: ReturnType<typeof spawn> | undefined, rpc: JsonLineRpc | undefined;
  let terminal!: (value: unknown) => void;
  const completed = new Promise<unknown>(resolve => { terminal = resolve; });
  const deadline = setTimeout(() => { failure = "TASK_TIME_LIMIT"; abort.abort(); terminal(null); }, TASK_LIMITS.durationMs);
  let closed: Promise<number | null> | undefined;
  let mayClean = true;
  try {
    baseline = evaluator.run(binary, shell, cwd, env);
    check(baseline.protocolValid && baseline.passed < baseline.total, "WORKFLOW_BASELINE_INVALID");
    child = spawn(binary, ["app-server", "--listen", "stdio://", "--strict-config"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr!.resume(); closed = new Promise(resolve => child!.once("close", resolve));
    rpc = new JsonLineRpc(child.stdout!, child.stdin!, 15_000, 1_048_576, (method, params) => {
      if (method === "turn/completed") terminal(params);
      if (["item/started", "item/completed"].includes(method) && isObject(params) && isObject(params.item)) {
        const item = params.item; if (itemEvents.length < 64) itemEvents.push({ method, type: String(item.type), id: String(item.id), status: item.status, exitCode: item.exitCode });
      }
      toolGate.observe(method, params);
    });
    child.on("error", () => { failure = "WORKFLOW_ENGINE_SPAWN"; terminal(null); });
    await rpc.request("initialize", { clientInfo: { name: "lcodex_workflow", version: "0.0.1" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
    const thread = await rpc.request("thread/start", { cwd, ephemeral: false, approvalPolicy: "never", approvalsReviewer: "user",
      developerInstructions: `Use exactly one tool call per response. For exec_command use shell=${JSON.stringify(shell)}, login=false, workdir=${JSON.stringify(cwd)}, yield_time_ms between 10000 and 30000, max_output_tokens at most 4096. Command execution is independently limited to 45 seconds. Use apply_patch for edits. No escalation, network or dependency installation. Node runtime is ${node}; include ${nodeFlags} before Node arguments in this sandbox. Project test command: ${testCommand}. Stop and summarize after testing. Do not modify the root marker, credentials or user notes.` });
    check(isObject(thread) && isObject(thread.thread) && typeof thread.thread.id === "string", "WORKFLOW_THREAD_INVALID"); threadId = thread.thread.id;
    const started = await rpc.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] });
    check(isObject(started) && isObject(started.turn) && typeof started.turn.id === "string", "WORKFLOW_TURN_INVALID"); turnId = started.turn.id;
    if (treeMode) {
      const tree = await waitForProcessTree(cwd);
      if (treeMode === "stop") { failure = "TASK_USER_STOP"; abort.abort(new Error(failure)); }
      else { await completed; check(failure === "TASK_COMMAND_LIMIT", failure || "WORKFLOW_DEADLINE_NOT_REACHED"); }
      stopEvidence = await stopAndReadThread(rpc, threadId, turnId);
      treeEvidence = await verifyTreeStopped(cwd, tree, treeDuration);
      check(!stopEvidence.needsReconcile && treeEvidence.allEnded && treeEvidence.noLateWrites && requests === 1 &&
        !toolEvents.some(event => event.endsWith(":tree-call-1")) && !existsSync(path.join(cwd, "queued-must-not-run.txt")), "WORKFLOW_TREE_STOP_FAILED");
      result = { status: "passed", expectedStop: failure, taskSucceeded: false, applicationOffered: false };
    } else {
    const done = await completed;
    if (disconnected) {
      check(failure === "WORKFLOW_SIMULATED_DISCONNECT" && toolResults.length === 1 && requests === 1 &&
        readFileSync(path.join(cwd, "effect.txt"), "utf8") === "ONCE", "WORKFLOW_DISCONNECT_EVIDENCE_MISSING");
      stopEvidence = await stopAndReadThread(rpc, threadId, turnId);
      check(!stopEvidence.needsReconcile, "WORKFLOW_DISCONNECT_UNRECONCILED");
      result = { status: "passed", expectedStop: failure, taskSucceeded: false, applicationOffered: false };
    } else {
    check(!failure && isObject(done) && isObject(done.turn) && done.turn.status === "completed", failure || "WORKFLOW_TURN_FAILED");
    limits.check(); check(limits.summary().pending === 0, "WORKFLOW_PENDING_TOOL");
    if (serialBatch) {
      check(batchHistoryMatched && toolEvents.slice(0, 4).join(",") === "started:mock-batch-one,completed:mock-batch-one,started:mock-batch-two,completed:mock-batch-two" &&
        readFileSync(path.join(cwd, ".batch-order"), "utf8") === "first-second", "WORKFLOW_BATCH_ORDER_FAILED");
    }
    const background = await rpc.request("thread/backgroundTerminals/list", { threadId });
    check(isObject(background) && Array.isArray(background.data) && background.data.length === 0, "WORKFLOW_BACKGROUND_ACTIVE");
    acceptance = evaluator.run(binary, shell, cwd, env);
    limits.check();
    check(acceptance.passed === acceptance.total && acceptance.protocolValid, "WORKFLOW_ACCEPTANCE_FAILED");
    check(JSON.stringify(snapshot(original)) === JSON.stringify(originalBefore), "WORKFLOW_ORIGINAL_CHANGED");
    check(contentHash(readFileSync(path.join(cwd, "user-notes.txt"))) === originalBefore["user-notes.txt"], "WORKFLOW_USER_NOTES_CHANGED");
    if (resources) check(toolResults.length === 3 && toolResults.every(item => isObject(item) && item.passed === true), "WORKFLOW_RESOURCE_BOUNDARY_FAILED");
    result = { status: "passed", turnStatus: done.turn.status };
    }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "WORKFLOW_EVALUATOR_PROCESS_UNKNOWN") mayClean = false;
    result = { status: "failed", code: failure || (error instanceof Error && /^(WORKFLOW_|TASK_|RPC_)[A-Z0-9_-]+$/.test(error.message) ? error.message : "WORKFLOW_FAILED") };
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline); toolGate.close(); abort.abort(); await activeUpstream?.catch(() => {});
    if (result.status !== "passed" && rpc && threadId) {
      try {
        await rpc.request("thread/backgroundTerminals/clean", { threadId });
        const background = await rpc.request("thread/backgroundTerminals/list", { threadId });
        if (!isObject(background) || !Array.isArray(background.data) || background.data.length !== 0) mayClean = false;
      } catch { mayClean = false; }
    }
    if (limits.summary().pending || limits.summary().queued) mayClean = false;
    rpc?.abort(new Error("WORKFLOW_CLOSED")); child?.stdin?.end();
    if (closed) {
      let timer: NodeJS.Timeout | undefined;
      exitCode = await Promise.race([closed, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 25_000); })]); clearTimeout(timer);
      if (exitCode === undefined) { child?.kill(); exitCode = await Promise.race([closed, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 3_000); })]); clearTimeout(timer); result = { status: "failed", code: "WORKFLOW_UNCLEAN_EXIT" }; }
    }
  }
  if (resumeContinue && result.status === "passed" && exitCode === 0 && threadId && turnId) {
    continuationMode = true;
    const beforeRestart = snapshot(cwd), previousRequests = requests;
    restarted = await checkRestart(binary, cwd, env, threadId, turnId, "completed", {
      prompt: "Without using tools or making any changes, summarize from this conversation which source file you changed and what behavior you fixed or added. Mention the function name. Do not rerun anything.",
      checkText: text => !live || text.includes("catalog.mjs") && text.includes(kind === "bug" ? "total" : "findByLabel"),
    });
    if (!restarted.passed || !continuationHistoryMatched || requests !== previousRequests + 1 || JSON.stringify(snapshot(cwd)) !== JSON.stringify(beforeRestart))
      result = { status: "failed", code: "WORKFLOW_CONTINUATION_FAILED" };
  }
  continuationAbort.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  if ((treeMode || disconnected) && result.status === "passed" && exitCode === 0 && threadId && turnId && stopEvidence?.status) {
    const beforeRestart = snapshot(cwd), previousRequests = requests;
    restarted = await checkRestart(binary, cwd, env, threadId, turnId, stopEvidence.status);
    if (treeMode) {
      limits.close(); const reopened = new TaskLimits(limitsFile);
      try { reopened.check(); result = { status: "failed", code: "WORKFLOW_LIMITS_REPLAY_ALLOWED" }; }
      catch (error) { recoveredLimits = { code: error instanceof Error ? error.message : "unknown", ...reopened.summary() }; }
      finally { reopened.close(); }
    }
    if (!restarted.passed || previousRequests !== requests || JSON.stringify(snapshot(cwd)) !== JSON.stringify(beforeRestart) ||
        JSON.stringify(snapshot(original)) !== JSON.stringify(originalBefore)) result = { status: "failed", code: "WORKFLOW_RESTART_REPLAY" };
    // Only dispose this generated fixture after actual process exit, history
    // reconciliation and the durable no-replay check. A product task retains it.
    if (result.status === "passed") mayClean = true;
  }
  let reviewedChanges: unknown = null;
  if (limitCase && exitCode === 0 && failure === (limitCase === "requests" ? "TASK_REQUEST_LIMIT" : "TASK_FAILURE_LIMIT") &&
      toolResults.length === (limitCase === "requests" ? TASK_LIMITS.requests : TASK_LIMITS.consecutiveFailures) && JSON.stringify(snapshot(original)) === JSON.stringify(originalBefore)) {
    result = { status: "passed", expectedStop: failure, taskSucceeded: false, applicationOffered: false }; process.exitCode = 0;
  }
  if (result.status === "passed" && exitCode === 0 && !limitCase && !treeMode && !disconnected) {
    try {
      const review = await task.seal(); check(review.changes.length > 0, "WORKFLOW_NO_CHANGES");
      if (kind === "feature") check(review.changes.some(change => change.relative.startsWith("test/") && change.kind !== "delete"), "WORKFLOW_FEATURE_TESTS_MISSING");
      reviewedChanges = review.changes.map(({ relative, kind }) => ({ relative, kind }));
      // This probe retains a reviewable proposal. It does not pretend a human has
      // approved an arbitrary model change or apply it to the product repository.
      task.close();
    } catch { result = { status: "failed", code: "WORKFLOW_REVIEW_FAILED" }; }
  } else if (exitCode === 0 && mayClean) task.close();
  const report = { kind: "multi-step-isolated-workflow", sample: kind, realModel: live, limitCase, serialBatch, longCommand, treeMode, disconnected, resumeContinue, resources, resourceEvidence, continuationHistoryMatched, stopEvidence, treeEvidence, restarted, recoveredLimits, batchHistoryMatched, toolEvents, itemEvents, ...result, baseline, acceptance, reviewedChanges, toolResults, envelopes, requests, usage,
    limits: limits.summary(), budget: ledger?.summary(), billVerified: false, exitCode, suppliedFullSource: false, exactPatchRequired: false,
    humanContextAdditions: 0, humanRepairs: 0, humanTakeovers: 0, originalPreserved: JSON.stringify(snapshot(original)) === JSON.stringify(originalBefore) };
  limits.close(); ledger?.close(); key = "";
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(`.local/reports/workflow-${kind}-${Date.now()}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
  if (exitCode === 0 && mayClean) run.cleanup();
  if (result.status !== "passed") process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error: unknown) => {
  activeLimits?.close(); activeLedger?.close();
  console.error(error instanceof Error && /^(WORKFLOW_|TASK_|GUARD_|REVIEW_|BUDGET_)[A-Z0-9_]+$/.test(error.message) ? error.message : "WORKFLOW_START_FAILED"); process.exitCode = 1;
});
