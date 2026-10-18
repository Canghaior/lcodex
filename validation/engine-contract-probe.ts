import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { isolatedEnvironment } from "./isolated-env.js";
import { isObject, JsonLineRpc } from "./rpc.js";
import { createRunDirectory } from "./run-directory.js";
import { validationCatalog } from "./model-catalog.js";
import { readKey } from "./read-key.js";
import { BudgetLedger } from "./budget.js";
import { MAX_OUTPUT_TOKENS, PRICE_REVIEW_DATE, sendBoundedDeepSeek } from "./deepseek-request.js";

const expectedSha = "03e5cf467f4ef2c06360b00cdc9aef64bb79b2028e25e3e122dd0bd2152ace22";
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

export function syntheticTextStream(text: string): string {
  const message = { id: "msg_synthetic", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: "resp_synthetic", object: "response", created_at: 1, model: "deepseek-flash", status: "completed",
    output: [message], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];
  return events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}

async function main() {
  const binary = process.argv[2];
  check(binary && path.isAbsolute(binary), "PROBE_BINARY_REQUIRED");
  check(createHash("sha256").update(readFileSync(binary)).digest("hex") === expectedSha, "PROBE_BINARY_MISMATCH");
  const live = process.argv.includes("--live");
  if (live) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    check(today === PRICE_REVIEW_DATE && process.argv.includes(`--price-reviewed=${PRICE_REVIEW_DATE}`), "PROBE_PRICE_REVIEW_REQUIRED");
  }
  let key = live ? await readKey() : "";
  const ledger = live ? new BudgetLedger(path.resolve(".local/state/p1-budget.jsonl")) : undefined;
  try {
  const run = createRunDirectory("engine 中文契约");
  for (const dir of ["home", "profile/roaming", "profile/local", "temp", "workspace"]) mkdirSync(path.join(run.root, dir), { recursive: true });
  const cwd = path.join(run.root, "workspace");
  const localToken = randomUUID();
  const env = { ...isolatedEnvironment(run.root, process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", LCODEX_LOCAL_PROBE_TOKEN: localToken };
  check(spawnSync("git", ["init", "--quiet", cwd], { env, windowsHide: true, timeout: 10_000 }).status === 0, "PROBE_GIT_INIT_FAILED");
  const requests: Record<string, unknown>[] = [];
  const upstream: Record<string, unknown>[] = [];
  let gatewayFailure: string | null = null;
  let inFlight = false;
  const server = createServer(async (req, res) => {
    let ownsRequest = false;
    try {
      check(req.headers.authorization === `Bearer ${localToken}`, "PROBE_LOCAL_AUTH_REQUIRED");
      check(!inFlight && gatewayFailure === null, "PROBE_GATEWAY_STOPPED");
      inFlight = true;
      ownsRequest = true;
      check(req.method === "POST" && req.url === "/v1/responses", "PROBE_UNEXPECTED_ENDPOINT");
      req.setEncoding("utf8");
      let body = "";
      for await (const chunk of req) { body += String(chunk); check(Buffer.byteLength(body) <= 262_144, "PROBE_BODY_TOO_LARGE"); }
      const parsed: unknown = JSON.parse(body);
      check(isObject(parsed), "PROBE_INVALID_BODY");
      requests.push({ bytes: Buffer.byteLength(body), fields: Object.keys(parsed).sort(), model: parsed.model,
        reasoning: parsed.reasoning, maxOutputTokens: parsed.max_output_tokens ?? null,
        store: parsed.store, parallelToolCalls: parsed.parallel_tool_calls,
        roles: Array.isArray(parsed.input) ? parsed.input.filter(isObject).map((item) => item.role ?? item.type) : [],
        tools: Array.isArray(parsed.tools) ? parsed.tools.filter(isObject).map((tool) => ({ type: tool.type, name: tool.name })) : [],
        ancestorInstructionsDetected: body.includes("本项目开发接入 DeepSeek"),
        developerMarkerPresent: body.includes("SYNTHETIC_DEVELOPER_MARKER"),
      });
      check(requests.length <= 1, "PROBE_UNEXPECTED_RETRY");
      let wire = syntheticTextStream("42");
      if (live && ledger) {
        check(!body.includes("本项目开发接入 DeepSeek"), "PROBE_ANCESTOR_INSTRUCTIONS");
        const response = await sendBoundedDeepSeek(ledger, "engine-text-v1", key, {
          ...parsed, max_output_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort: "none" }, tools: [], tool_choice: "none", store: false,
        });
        upstream.push({ terminalType: response.terminalType, events: response.events, usage: response.usage, returnedModel: response.response.model });
        check(response.terminalType === "response.completed" && Array.isArray(response.response.output) &&
          response.response.output.every((item) => isObject(item) && ["message", "reasoning"].includes(String(item.type))), "PROBE_TOOL_OUTPUT_REFUSED");
        // Text-only probe buffers the actual SSE until it is verified to contain no tool calls.
        wire = response.wire;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(wire);
    } catch (error) {
      gatewayFailure = error instanceof Error && /^(PROBE_|API_|SSE_|BUDGET_)[A-Z0-9_]+$/.test(error.message) ? error.message : "PROBE_GATEWAY_FAILED";
      res.writeHead(400); res.end(JSON.stringify({ error: { message: gatewayFailure } }));
    } finally { if (ownsRequest) inFlight = false; }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  check(address && typeof address !== "string", "PROBE_NO_PORT");
  const catalogPath = path.join(run.root, "home/models.json");
  writeFileSync(catalogPath, JSON.stringify(validationCatalog()));
  writeFileSync(path.join(run.root, "home/config.toml"), [
    'model = "deepseek-flash"', 'model_provider = "local_contract"', 'model_reasoning_effort = "none"',
    `model_catalog_json = '${catalogPath}'`,
    'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
    '[features]', 'multi_agent = false', 'apps = false', 'plugins = false', 'hooks = false', 'goals = false',
    'shell_snapshot = false', 'browser_use = false', 'computer_use = false', 'image_generation = false',
    '[analytics]', 'enabled = false', '[model_providers.local_contract]',
    'name = "Local synthetic protocol probe"', `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', 'env_key = "LCODEX_LOCAL_PROBE_TOKEN"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
  ].join("\n"));
  const child = spawn(binary, ["app-server", "--listen", "stdio://", "--strict-config"], { env, cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const notifications: string[] = [];
  const diagnostics: unknown[] = [];
  let complete!: (value: unknown) => void;
  const completed = new Promise<unknown>((resolve) => { complete = resolve; });
  const rpc = new JsonLineRpc(child.stdout, child.stdin, 15_000, 1_048_576, (method, params) => {
    notifications.push(method);
    if (["error", "warning"].includes(method) && isObject(params)) {
      const error = isObject(params.error) ? params.error : params;
      diagnostics.push({ method, info: error.codexErrorInfo,
        message: typeof error.message === "string" ? error.message.replaceAll(run.root, "<run>").replaceAll(localToken, "<local-token>").replace(/sk-[A-Za-z0-9_-]+/g, "<redacted>").slice(0, 1500) : null });
    }
    if (method === "turn/completed") complete(params);
  });
  child.on("error", () => rpc.abort(new Error("PROBE_SPAWN_FAILED")));
  let exitCode: number | null | undefined;
  let timer: NodeJS.Timeout | undefined;
  let result: Record<string, unknown> = { status: "failed" };
  try {
    await rpc.request("initialize", { clientInfo: { name: "lcodex_contract", version: "0.0.1" }, capabilities: { experimentalApi: false } });
    rpc.notify("initialized", {});
    const thread = await rpc.request("thread/start", { cwd, ephemeral: false, sandbox: "read-only", approvalPolicy: "never",
      developerInstructions: "SYNTHETIC_DEVELOPER_MARKER. This probe requires only a plain text answer; do not use tools." });
    check(isObject(thread) && isObject(thread.thread) && typeof thread.thread.id === "string", "PROBE_INVALID_THREAD");
    await rpc.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Reply with only 42. Do not use any tools.", text_elements: [] }] });
    const terminal = await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROBE_TURN_TIMEOUT")), live ? 70_000 : 30_000); })]);
    check(isObject(terminal) && isObject(terminal.turn), "PROBE_INVALID_TERMINAL");
    check(terminal.turn.status === "completed", "PROBE_TURN_FAILED");
    check(requests.length === 1 && rpc.deniedServerRequests === 0, "PROBE_UNEXPECTED_OPERATIONS");
    const readBack = await rpc.request("thread/read", { threadId: thread.thread.id, includeTurns: true });
    check(isObject(readBack) && isObject(readBack.thread) && Array.isArray(readBack.thread.turns), "PROBE_INVALID_THREAD_READ");
    const lastTurn = readBack.thread.turns.at(-1);
    check(isObject(lastTurn) && lastTurn.status === "completed", "PROBE_READ_STATUS_MISMATCH");
    check(Array.isArray(lastTurn.items) && lastTurn.items.some((item) => isObject(item) && item.type === "agentMessage" && item.text === "42"), "PROBE_READ_TEXT_MISMATCH");
    result = { status: "passed", turnStatus: terminal.turn.status, readBack: "completed-and-text-matched" };
  } catch (error) {
    result = { status: "failed", errorCode: error instanceof Error && /^(PROBE_|RPC_)[A-Z0-9_-]+$/.test(error.message) ? error.message : "PROBE_FAILED" };
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    rpc.abort(new Error("PROBE_CLOSED"));
    child.stdin.end();
    let exitTimer: NodeJS.Timeout | undefined;
    exitCode = await Promise.race([closed, new Promise<undefined>((resolve) => { exitTimer = setTimeout(() => resolve(undefined), 3_000); })]);
    clearTimeout(exitTimer);
    if (exitCode === undefined) {
      child.kill();
      exitCode = await Promise.race([closed, new Promise<undefined>((resolve) => { exitTimer = setTimeout(() => resolve(undefined), 3_000); })]);
      clearTimeout(exitTimer);
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  key = "";
  const budget = ledger?.summary();
  ledger?.close();
  if (exitCode !== 0) result = { status: "failed", errorCode: "PROBE_UNCLEAN_EXIT" };
  const report = { kind: live ? "engine-deepseek-text-only" : "engine-local-synthetic-response-only", ...result, engineVersion: "0.140.0", engineSha256: expectedSha,
    requests, notifications, diagnostics, deniedServerRequests: rpc.deniedServerRequests, stderrBytes, processExit: exitCode,
    upstream, gatewayFailure, budget, billVerified: false, realModel: live, toolsStrippedForTextProbe: live,
    upstreamOutputLimit: live ? MAX_OUTPUT_TOKENS : null, toolExecutionTested: false, sandboxEnforcement: "not-tested" };
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(`.local/reports/engine-contract-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  if (exitCode === 0) run.cleanup();
  else process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
  } finally { key = ""; ledger?.close(); }
}

main().catch(() => { console.error("PROBE_START_FAILED"); process.exitCode = 1; });
