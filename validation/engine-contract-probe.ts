import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { isolatedEnvironment } from "./isolated-env.js";
import { isObject, JsonLineRpc } from "./rpc.js";
import { createRunDirectory } from "./run-directory.js";
import { validationCatalog } from "./model-catalog.js";
import { readKey } from "./read-key.js";
import { BudgetLedger } from "./budget.js";
import { MAX_OUTPUT_TOKENS, PRICE_REVIEW_DATE, sendBoundedDeepSeek } from "./deepseek-request.js";
import { checkDiagnosis, checkResponseWire, READ_COMMAND } from "./readonly-contract.js";
import { evaluatorSource, snapshot } from "./fixtures.js";
import { evaluateInvoiceSource, INVOICE_BASELINE, previewInvoicePatch } from "./patch-contract.js";
import { checkRestart } from "./resume-check.js";
import { mapDeepSeekRoles } from "./deepseek-roles.js";
import { assertNoKnownSecrets } from "./outbound-data.js";

const expectedSha = "03e5cf467f4ef2c06360b00cdc9aef64bb79b2028e25e3e122dd0bd2152ace22";
const candidateSha = "dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f";
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

export function syntheticTextStream(text: string, fault?: string): string {
  const status = fault === "failed" ? "failed" : fault === "incomplete" ? "incomplete" : "completed";
  const message = { id: "msg_synthetic", type: "message", role: "assistant", status: fault ? "incomplete" : "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: "resp_synthetic", object: "response", created_at: 1, model: "deepseek-flash", status,
    output: [message], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } },
    ...(fault === "failed" ? { error: { code: "server_error", message: "Synthetic upstream failure" } } : {}),
    ...(fault === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: "response.output_item.done", output_index: 0, item: message },
    ...(fault === "missing-terminal" ? [] : [{ type: `response.${status}`, response }]),
  ];
  return events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}

async function main() {
  check(process.argv.slice(3).every((arg) => ["--live", "--resume-check", "--read-task", "--edit-task", "--verify-edit", "--compact-check", "--diagnose-exit"].includes(arg) ||
    ["--price-reviewed=", "--tool-case=", "--fault-case=", "--shell="].some((prefix) => arg.startsWith(prefix))), "PROBE_UNKNOWN_OPTION");
  const binary = process.argv[2];
  check(binary && path.isAbsolute(binary), "PROBE_BINARY_REQUIRED");
  const binarySha = createHash("sha256").update(readFileSync(binary)).digest("hex");
  check([expectedSha, candidateSha].includes(binarySha), "PROBE_BINARY_MISMATCH");
  const engineVersion = binarySha === candidateSha ? "0.162.0" : "0.140.0";
  const live = process.argv.includes("--live");
  const diagnoseExit = process.argv.includes("--diagnose-exit");
  const compactCheck = process.argv.includes("--compact-check");
  const restartCheck = process.argv.includes("--resume-check");
  check(!restartCheck || (!live && engineVersion === "0.162.0"), "PROBE_RESTART_MODE_REFUSED");
  const readTask = process.argv.includes("--read-task");
  const editTask = process.argv.includes("--edit-task");
  const verifyEdit = process.argv.includes("--verify-edit");
  check(!verifyEdit || editTask, "PROBE_VERIFY_REQUIRES_EDIT");
  check(!editTask || (!readTask && engineVersion === "0.162.0"), "PROBE_EDIT_TASK_REFUSED");
  check(!readTask || engineVersion === "0.162.0", "PROBE_READ_TASK_REFUSED");
  const toolCase = process.argv.find((arg) => arg.startsWith("--tool-case="))?.slice("--tool-case=".length);
  const faultCase = process.argv.find((arg) => arg.startsWith("--fault-case="))?.slice("--fault-case=".length);
  check(!compactCheck || !restartCheck && !toolCase && !readTask && !editTask && !faultCase && engineVersion === "0.162.0", "PROBE_COMPACT_MODE_REFUSED");
  check(!faultCase || ["failed", "incomplete", "missing-terminal"].includes(faultCase) && !live && !restartCheck && !toolCase && !readTask && !editTask && engineVersion === "0.162.0", "PROBE_FAULT_MODE_REFUSED");
  check(!restartCheck || toolCase !== "interrupt", "PROBE_RESTART_MODE_REFUSED");
  check(Number(readTask) + Number(editTask) + Number(Boolean(toolCase)) <= 1, "PROBE_CONFLICTING_MODES");
  check(!toolCase || (["readonly", "write", "interrupt", "deny", "network-control", "network-denied", "concurrent-edit", "temp-scope", "patch-readonly", "patch-write", "patch-sensitive", "patch-outside", "guard-parallel", "guard-delta"].includes(toolCase) && !live && engineVersion === "0.162.0"), "PROBE_TOOL_CASE_REFUSED");
  const guardCase = toolCase?.startsWith("guard-") === true;
  const patchCase = toolCase?.startsWith("patch-") === true || editTask;
  const networkCase = toolCase?.startsWith("network-") === true;
  const tempCase = toolCase?.startsWith("temp-") === true;
  const environmentCase = networkCase || tempCase;
  const scopedTools = Boolean(toolCase || readTask || editTask);
  const shellPath = process.argv.find((arg) => arg.startsWith("--shell="))?.slice("--shell=".length);
  if (scopedTools) {
    check(shellPath && path.isAbsolute(shellPath), "PROBE_SHELL_PATH_REQUIRED");
    check(createHash("sha256").update(readFileSync(shellPath)).digest("hex") === "362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139", "PROBE_SHELL_HASH_MISMATCH");
  }
  if (live) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    check(today === PRICE_REVIEW_DATE && process.argv.includes(`--price-reviewed=${PRICE_REVIEW_DATE}`), "PROBE_PRICE_REVIEW_REQUIRED");
  }
  let key = live ? await readKey() : "";
  const ledger = live ? new BudgetLedger(path.resolve(".local/state/p1-budget.jsonl")) : undefined;
  try {
  const run = createRunDirectory("engine 中文契约");
  for (const dir of ["home", "profile/roaming", "profile/local", "temp", "workspace", "outside"]) mkdirSync(path.join(run.root, dir), { recursive: true });
  if (scopedTools) mkdirSync(path.join(run.root, "profile/local/Packages"));
  const cwd = path.join(run.root, "workspace");
  const marker = path.join(cwd, "write-marker.txt");
  const pidMarker = path.join(cwd, "process-started.txt");
  const outside = path.join(run.root, "outside/sentinel.txt");
  writeFileSync(path.join(cwd, "inside.txt"), "INSIDE_SYNTHETIC");
  writeFileSync(path.join(cwd, ".env"), "ENV_SYNTHETIC");
  writeFileSync(outside, "OUTSIDE_SYNTHETIC");
  const readMarker = `source-${randomUUID()}`;
  const contextMarker = `context-${randomUUID()}`;
  if (readTask) writeFileSync(path.join(cwd, "invoice.mjs"), `// ${readMarker}\nexport function invoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.priceCents, 0);\n}\n`);
  if (editTask) writeFileSync(path.join(cwd, "invoice.mjs"), INVOICE_BASELINE);
  const baselineChecks = editTask ? evaluateInvoiceSource(INVOICE_BASELINE) : null;
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const evaluatorPath = path.join(run.root, "outside/independent-evaluator.mjs");
  const nodePath = realpathSync(process.execPath);
  if (verifyEdit) {
    check(createHash("sha256").update(readFileSync(nodePath)).digest("hex") === "3a9ac860c566b7aebf144be914f95e3ec36dc88040aa7acb5d9d1e6e0c7afd5e", "PROBE_NODE_HASH_MISMATCH");
    writeFileSync(evaluatorPath, evaluatorSource);
  }
  const verificationCommand = `& ${quote(nodePath)} --preserve-symlinks --preserve-symlinks-main ${quote(evaluatorPath)} ${quote(path.join(cwd, "invoice.mjs"))}; exit $LASTEXITCODE`;
  let fixedCommand = toolCase === "interrupt"
    ? `Set-Content -LiteralPath ${quote(pidMarker)} -Value $PID -NoNewline -ErrorAction Stop; Start-Sleep -Seconds 8; Set-Content -LiteralPath ${quote(marker)} -Value FINISHED -NoNewline`
    : toolCase === "concurrent-edit"
    ? `$old=Get-Content -LiteralPath ${quote(path.join(cwd, "inside.txt"))} -Raw -ErrorAction Stop; Set-Content -LiteralPath ${quote(pidMarker)} -Value $PID -NoNewline -ErrorAction Stop; Start-Sleep -Seconds 3; Set-Content -LiteralPath ${quote(path.join(cwd, "inside.txt"))} -Value ($old + '_AGENT') -NoNewline -ErrorAction Stop`
    : [
    "$r=@{}",
    `try {$r.inside=((Get-Content -LiteralPath ${quote(path.join(cwd, "inside.txt"))} -Raw -ErrorAction Stop) -eq 'INSIDE_SYNTHETIC')} catch {$r.inside=$false}`,
    `try {$r.outside=((Get-Content -LiteralPath ${quote(outside)} -Raw -ErrorAction Stop) -eq 'OUTSIDE_SYNTHETIC')} catch {$r.outside=$false}`,
    `try {$r.sensitive=((Get-Content -LiteralPath ${quote(path.join(cwd, ".env"))} -Raw -ErrorAction Stop) -eq 'ENV_SYNTHETIC')} catch {$r.sensitive=$false}`,
    `try {Set-Content -LiteralPath ${quote(marker)} -Value 'MARKER' -NoNewline -ErrorAction Stop; $r.write=$true} catch {$r.write=$false}`,
    "$r | ConvertTo-Json -Compress",
  ].join("; ");
  const localToken = randomUUID();
  const env = { ...isolatedEnvironment(run.root, process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", LCODEX_LOCAL_PROBE_TOKEN: localToken };
  check(spawnSync("git", ["init", "--quiet", cwd], { env, windowsHide: true, timeout: 10_000 }).status === 0, "PROBE_GIT_INIT_FAILED");
  const beforeFiles = snapshot(cwd);
  const requests: Record<string, unknown>[] = [];
  const upstream: Record<string, unknown>[] = [];
  let gatewayFailure: string | null = null;
  let inFlight = false;
  let stopping = false;
  let blockedAfterStop = 0;
  let toolResult: unknown = null;
  let readCallId: string | undefined;
  let readToolResultMatched = false;
  let editCallId: string | undefined;
  let expectedCandidate: string | undefined;
  let independentChecks: unknown = null;
  let patchResultMatched = false;
  let verificationCallId: string | undefined;
  let verificationResultMatched = false;
  const upstreamAbort = new AbortController();
  let activeUpstream: ReturnType<typeof sendBoundedDeepSeek> | undefined;
  let networkHits = 0;
  let externalEditWritten = false;
  let externalEditPreserved: boolean | "not-tested" = "not-tested";
  const networkCanaryPath = `/network-canary/${randomUUID()}`;
  const server = createServer(async (req, res) => {
    let ownsRequest = false;
    try {
      if (networkCase && req.method === "GET" && req.url === networkCanaryPath) {
        networkHits++; res.writeHead(200, { "content-type": "text/plain" }); res.end("NETWORK_CANARY"); return;
      }
      check(req.headers.authorization === `Bearer ${localToken}`, "PROBE_LOCAL_AUTH_REQUIRED");
      if (stopping) { blockedAfterStop++; throw new Error("PROBE_GATEWAY_STOPPED"); }
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
        contextMarkerPresent: compactCheck ? body.includes(contextMarker) : "not-tested",
      });
      check(requests.length <= (compactCheck || verifyEdit ? 3 : toolCase || readTask || editTask ? 2 : 1), "PROBE_UNEXPECTED_RETRY");
      let wire = syntheticTextStream(faultCase ? "PARTIAL_SYNTHETIC" : "42", faultCase);
      if (compactCheck && requests.length > 1) {
        check(body.includes(contextMarker), "PROBE_CONTEXT_MARKER_LOST");
        wire = syntheticTextStream(requests.length === 2 ? `Remembered reference marker: ${contextMarker}. No tools have run.` : contextMarker);
      }
      if ((toolCase || (readTask || editTask) && !live) && requests.length === 1) {
        check(Array.isArray(parsed.tools), "PROBE_SHELL_TOOL_MISSING");
        let item: Record<string, unknown>;
        if (patchCase) {
          check(parsed.tools.filter(isObject).some((tool) => tool.name === "apply_patch" && tool.type === "custom"), "PROBE_PATCH_TOOL_MISSING");
          const patchPath = toolCase === "patch-sensitive" ? ".env" : (toolCase === "patch-outside" ? outside : "inside.txt");
          const oldText = toolCase === "patch-sensitive" ? "ENV_SYNTHETIC" : (toolCase === "patch-outside" ? "OUTSIDE_SYNTHETIC" : "INSIDE_SYNTHETIC");
          item = { id: "fc_synthetic", call_id: "call_synthetic", type: "custom_tool_call", name: "apply_patch", status: "completed",
            input: `*** Begin Patch\n*** Update File: ${patchPath}\n@@\n-${oldText}\n+EDITED_SYNTHETIC\n*** End Patch` };
          if (editTask) {
            const candidate = "export function invoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);\n}\nexport function applyDiscount(cents, percent) {\n  return Math.round(cents * (100 - percent) / 100);\n}\n";
            item.input = "*** Begin Patch\n*** Update File: invoice.mjs\n@@\n" + INVOICE_BASELINE.trimEnd().split("\n").map((line) => "-" + line).join("\n") + "\n" + candidate.trimEnd().split("\n").map((line) => "+" + line).join("\n") + "\n*** End Patch";
            expectedCandidate = previewInvoicePatch(String(item.input)); editCallId = "call_synthetic";
          }
        } else {
        const shellTool = parsed.tools.filter(isObject).find((tool) => ["shell_command", "exec_command"].includes(String(tool.name)));
        check(shellTool, "PROBE_SHELL_TOOL_MISSING");
        const args = shellTool.name === "exec_command"
          ? { cmd: readTask || guardCase ? READ_COMMAND : fixedCommand, workdir: cwd, yield_time_ms: 10_000, max_output_tokens: 2048, login: false, shell: shellPath,
            ...(toolCase === "deny" ? { sandbox_permissions: "require_escalated", justification: "Synthetic validation request; the client will decline it." } : {}) }
          : { command: fixedCommand, workdir: cwd, timeout_ms: 10_000, login: false };
        item = { id: "fc_synthetic", call_id: "call_synthetic", type: "function_call", name: shellTool.name,
          arguments: JSON.stringify(args), status: "completed" };
        }
        const events = [
          { type: "response.created", response: { id: "resp_tool", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
        ];
        wire = events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
        if (guardCase) {
          const badItem = { ...item, id: "fc_extra", call_id: "call_extra", arguments: JSON.stringify({ cmd: fixedCommand, workdir: cwd, shell: shellPath, login: false }) };
          const output = toolCase === "guard-parallel" ? [item, badItem] : [item];
          const final = { id: "resp_guard", status: "completed", output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
          const guardEvents = toolCase === "guard-parallel"
            ? [...output.flatMap((entry, index) => [{ type: "response.output_item.added", output_index: index, item: entry }, { type: "response.output_item.done", output_index: index, item: entry }]), { type: "response.completed", response: final }]
            : [{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
              { type: "response.function_call_arguments.delta", item_id: item.id, delta: badItem.arguments },
              { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: final }];
          wire = guardEvents.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
          checkResponseWire(wire, final, { cwd, shell: shellPath! });
          throw new Error("PROBE_INVALID_RESPONSE_ADMITTED");
        }
        if (readTask) readCallId = "call_synthetic";
      } else if (verifyEdit && !live && requests.length === 2) {
        const item = { id: "fc_verify", call_id: "call_verify", type: "function_call", name: "exec_command", status: "completed",
          arguments: JSON.stringify({ cmd: verificationCommand, workdir: cwd, shell: shellPath, login: false, yield_time_ms: 10000, max_output_tokens: 2048 }) };
        verificationCallId = item.call_id;
        const events = [{ type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_verify", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }];
        wire = events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
      } else if (toolCase) {
        check(Array.isArray(parsed.input), "PROBE_NO_TOOL_HISTORY");
        const outputs = parsed.input.filter(isObject).filter((item) => item.type === (patchCase ? "custom_tool_call_output" : "function_call_output") && item.call_id === "call_synthetic");
        check(outputs.length === 1 && typeof outputs[0]?.output === "string", "PROBE_TOOL_RESULT_MISSING");
        const output = outputs[0].output as string;
        const json = output.match(/\{[^{}]*"(?:inside|network)"[^{}]*\}/)?.[0];
        toolResult = json ? JSON.parse(json) : { outputMatched: false, outputExcerpt: output.replaceAll(run.root, "<run>").replace(/C:\\Users\\[^\\\s]+/gi, "<user>").slice(0, 800) };
      }
      if (readTask && requests.length === 2) {
          check(Array.isArray(parsed.input) && readCallId, "PROBE_NO_TOOL_HISTORY");
          const outputs = parsed.input.filter(isObject).filter((item) => item.type === "function_call_output" && item.call_id === readCallId);
          readToolResultMatched = outputs.length === 1 && typeof outputs[0]?.output === "string" && outputs[0].output.includes(readMarker) && outputs[0].output.includes("item.priceCents");
          check(readToolResultMatched, "PROBE_TOOL_RESULT_MISSING");
          if (!live) wire = syntheticTextStream(JSON.stringify({ file: "invoice.mjs", ignoresQuantity: true, observedTotal: 125, expectedTotal: 500, marker: readMarker }));
      }
      if (editTask && requests.length === 2) {
        check(Array.isArray(parsed.input) && editCallId, "PROBE_NO_TOOL_HISTORY");
        const outputs = parsed.input.filter(isObject).filter((item) => item.type === "custom_tool_call_output" && item.call_id === editCallId);
        patchResultMatched = outputs.length === 1 && typeof outputs[0]?.output === "string" && outputs[0].output.includes("Success.");
        check(patchResultMatched, "PROBE_PATCH_RESULT_MISSING");
      }
      if (verifyEdit && requests.length === 3) {
        check(Array.isArray(parsed.input) && verificationCallId, "PROBE_NO_TOOL_HISTORY");
        const outputs = parsed.input.filter(isObject).filter((item) => item.type === "function_call_output" && item.call_id === verificationCallId);
        check(outputs.length === 1 && typeof outputs[0]?.output === "string", "PROBE_VERIFY_RESULT_MISSING");
        const output = outputs[0].output;
        const line = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('{"kind":"independent-invoice-checks"'));
        const parsedChecks: unknown = line ? JSON.parse(line) : null;
        const names = ["empty", "single", "quantity", "mixed", "discount", "rounding"];
        verificationResultMatched = isObject(parsedChecks) && Array.isArray(parsedChecks.checks) && parsedChecks.checks.length === 6 && parsedChecks.checks.every((item, index) => isObject(item) && item.name === names[index] && item.passed === true);
        check(verificationResultMatched, "PROBE_VERIFY_CHECKS_FAILED");
      }
      if (live && ledger) {
        check(!body.includes("本项目开发接入 DeepSeek"), "PROBE_ANCESTOR_INSTRUCTIONS");
        assertNoKnownSecrets(body, [localToken, key]);
        const tools = verifyEdit && requests.length === 2 && Array.isArray(parsed.tools)
          ? parsed.tools.filter(isObject).filter((tool) => tool.type === "function" && tool.name === "exec_command")
          : (readTask || editTask) && requests.length === 1 && Array.isArray(parsed.tools)
          ? parsed.tools.filter(isObject).filter((tool) => editTask ? tool.type === "custom" && tool.name === "apply_patch" : tool.type === "function" && tool.name === "exec_command") : [];
        check(!(readTask || editTask) || requests.length !== 1 || tools.length === 1, "PROBE_SHELL_TOOL_MISSING");
        const adapted = mapDeepSeekRoles({
          ...parsed, max_output_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort: "none" }, tools,
          tool_choice: tools.length ? "auto" : "none", parallel_tool_calls: false, store: false,
        });
        activeUpstream = sendBoundedDeepSeek(ledger, verifyEdit ? "engine-edit-verify-v1" : compactCheck ? "engine-compact-v1" : editTask ? "engine-edit-v1" : (readTask ? "engine-read-v1" : "engine-text-v1"), key, adapted, fetch, upstreamAbort.signal);
        const response = await activeUpstream;
        activeUpstream = undefined;
        upstream.push({ terminalType: response.terminalType, events: response.events, usage: response.usage, returnedModel: response.response.model,
          roles: (adapted.input as Record<string, unknown>[]).map((item) => item.role ?? item.type) });
        check(response.terminalType === "response.completed", "PROBE_TOOL_OUTPUT_REFUSED");
        const call = checkResponseWire(response.wire, response.response, verifyEdit && requests.length === 2 ? { cwd, shell: shellPath!, command: verificationCommand } : readTask && requests.length === 1 ? { cwd, shell: shellPath! } : undefined,
          editTask && requests.length === 1 ? (input) => { expectedCandidate = previewInvoicePatch(input); } : undefined);
        if (readTask && requests.length === 1) {
          check(call && typeof call.call_id === "string", "PROBE_READ_NOT_REQUESTED");
          readCallId = call.call_id;
        }
        if (editTask && requests.length === 1) { check(call && typeof call.call_id === "string", "PROBE_PATCH_NOT_REQUESTED"); editCallId = call.call_id; }
        if (verifyEdit && requests.length === 2) { check(call && typeof call.call_id === "string", "PROBE_VERIFY_NOT_REQUESTED"); verificationCallId = call.call_id; }
        // Hold all real SSE bytes until every execution-bearing event passes the contract.
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
  if (environmentCase) fixedCommand = [
    "$r=@{}",
    `try {$r.network=((Invoke-WebRequest -Uri 'http://127.0.0.1:${address.port}${networkCanaryPath}' -NoProxy -TimeoutSec 2 -ErrorAction Stop).Content -eq 'NETWORK_CANARY')} catch {$r.network=$false}`,
    "$r.localTokenVisible=(Test-Path Env:LCODEX_LOCAL_PROBE_TOKEN)",
    "$r.apiKeyVisible=(Test-Path Env:DEEPSEEK_API_KEY)",
    "$r.tempExists=(Test-Path -LiteralPath $env:TEMP)",
    `$r.tempWithinRun=$env:TEMP.StartsWith(${quote(run.root + path.sep)}, [System.StringComparison]::OrdinalIgnoreCase)`,
    "$r.tempExistsAfter=(Test-Path -LiteralPath $env:TEMP)",
    "$r.tempWrite=$false",
    "if ($r.tempWithinRun) { $tempFile=Join-Path $env:TEMP 'lcodex-temp-canary.txt'; try {Set-Content -LiteralPath $tempFile -Value 'TEMP_CANARY' -NoNewline -ErrorAction Stop; $r.tempWrite=$true; Remove-Item -LiteralPath $tempFile -ErrorAction Stop} catch {} }",
    "$r | ConvertTo-Json -Compress",
  ].join("; ");
  const catalogPath = path.join(run.root, "home/models.json");
  writeFileSync(catalogPath, JSON.stringify(validationCatalog(scopedTools, readTask, patchCase, verifyEdit)));
  writeFileSync(path.join(run.root, "home/config.toml"), [
    'model = "deepseek-flash"', 'model_provider = "local_contract"', 'model_reasoning_effort = "none"',
    `model_catalog_json = '${catalogPath}'`,
    `approval_policy = "${toolCase === "deny" ? "on-request" : "never"}"`, ...(scopedTools ? ['default_permissions = "scoped"'] : ['sandbox_mode = "read-only"']),
    'web_search = "disabled"', 'allow_login_shell = false',
    ...(scopedTools ? ['[windows]', 'sandbox = "mxc"', '[permissions.scoped.filesystem]', '":minimal" = "read"',
      `${quote(cwd)} = "${editTask || toolCase && ["write", "deny", "interrupt", "concurrent-edit", "patch-write", "patch-sensitive", "patch-outside"].includes(toolCase) ? "write" : "read"}"`, `${quote(path.join(cwd, ".env"))} = "deny"`,
      `${quote(path.join(cwd, ".git"))} = "read"`,
      `${quote(path.dirname(process.env.COMSPEC ?? "C:/Windows/System32/cmd.exe"))} = "read"`,
      `${quote(path.dirname(shellPath!))} = "read"`,
      ...(verifyEdit ? [`${quote(path.dirname(nodePath))} = "read"`, `${quote(evaluatorPath)} = "read"`] : []),
      `${quote(path.join(run.root, "profile/local/Packages"))} = "write"`,
      '[permissions.scoped.network]', `enabled = ${toolCase === "network-control"}`] : []),
    '[features]', 'multi_agent = false', 'apps = false', 'plugins = false', 'hooks = false', 'goals = false',
    'shell_snapshot = false', 'browser_use = false', 'computer_use = false', 'image_generation = false',
    '[shell_environment_policy]', 'inherit = "all"', 'ignore_default_excludes = false',
    ...(engineVersion === "0.162.0"
      ? ['[shell_environment_policy.filters]', 'LCODEX_LOCAL_PROBE_TOKEN = "exclude"', 'DEEPSEEK_API_KEY = "exclude"']
      : ['exclude = ["LCODEX_LOCAL_PROBE_TOKEN", "DEEPSEEK_API_KEY"]']),
    '[analytics]', 'enabled = false', '[model_providers.local_contract]',
    'name = "Local synthetic protocol probe"', `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', 'env_key = "LCODEX_LOCAL_PROBE_TOKEN"', 'request_max_retries = 0', 'stream_max_retries = 0',
    ...(compactCheck ? ['[model_providers.local_contract.capabilities]', 'remote_compaction = "unsupported"'] : []), '',
  ].join("\n"));
  const child = spawn(binary, ["app-server", "--listen", "stdio://", "--strict-config"], { env: diagnoseExit ? { ...env, RUST_LOG: "codex_app_server=info" } : env, cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stderrBytes = 0;
  let stderrTail = "";
  let processExitEvent: unknown = "not-observed";
  child.once("exit", (code, signal) => { processExitEvent = { code, signal }; });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (diagnoseExit) stderrTail = (stderrTail + chunk.toString("utf8")).slice(-16_384); });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const notifications: string[] = [];
  const itemTypes: string[] = [];
  const commandExitCodes: unknown[] = [];
  const diagnostics: unknown[] = [];
  let complete!: (value: unknown) => void;
  let completed = new Promise<unknown>((resolve) => { complete = resolve; });
  const rpc = new JsonLineRpc(child.stdout, child.stdin, 15_000, 1_048_576, (method, params) => {
    notifications.push(method);
    if (method === "item/completed" && isObject(params) && isObject(params.item) && typeof params.item.type === "string") itemTypes.push(params.item.type);
    if (method === "item/completed" && isObject(params) && isObject(params.item) && params.item.type === "commandExecution") commandExitCodes.push(params.item.exitCode);
    if (["error", "warning"].includes(method) && isObject(params)) {
      const error = isObject(params.error) ? params.error : params;
      diagnostics.push({ method, info: error.codexErrorInfo,
        message: typeof error.message === "string" ? error.message.replaceAll(run.root, "<run>").replaceAll(localToken, "<local-token>").replace(/sk-[A-Za-z0-9_-]+/g, "<redacted>").slice(0, 1500) : null });
    }
    if (method === "turn/completed") complete(params);
  }, toolCase === "deny");
  child.on("error", () => rpc.abort(new Error("PROBE_SPAWN_FAILED")));
  let exitCode: number | null | undefined;
  let completedIdentity: { threadId: string; turnId: string } | undefined;
  let restarted: Awaited<ReturnType<typeof checkRestart>> | undefined;
  let shutdownMilliseconds = 0;
  let forcedExit = false;
  let timer: NodeJS.Timeout | undefined;
  let result: Record<string, unknown> = { status: "failed" };
  let observedTurnStatus: unknown = "not-received";
  let compactionResult: unknown = "not-tested";
  let interruptedProcessEnded: unknown = "not-tested";
  let terminalCounts: unknown = null;
  try {
    await rpc.request("initialize", { clientInfo: { name: "lcodex_contract", version: "0.0.1" }, capabilities: { experimentalApi: toolCase === "interrupt" } });
    rpc.notify("initialized", {});
    const thread = await rpc.request("thread/start", { cwd, ephemeral: false, ...(!scopedTools ? { sandbox: "read-only" } : {}), approvalPolicy: toolCase === "deny" ? "on-request" : "never", approvalsReviewer: "user",
      developerInstructions: verifyEdit ? "SYNTHETIC_DEVELOPER_MARKER. Update invoice.mjs with one apply_patch, then run exactly the user's verification command once using exec_command. Summarize observed results. No other commands or files." : editTask ? "SYNTHETIC_DEVELOPER_MARKER. Only update invoice.mjs with one apply_patch call. No other tools or files. After the tool result, give a concise summary." : (readTask ? "SYNTHETIC_DEVELOPER_MARKER. Read-only code analysis. Execute only the exact read command given by the user, once, then answer from that result." : "SYNTHETIC_DEVELOPER_MARKER. This probe requires only a plain text answer; do not use tools.") });
    check(isObject(thread) && isObject(thread.thread) && typeof thread.thread.id === "string", "PROBE_INVALID_THREAD");
    const prompt = editTask
      ? `Fix invoiceTotal to account for each line's quantity, and add applyDiscount(cents, percent) that returns integer cents rounded with Math.round after a percentage discount. Use only arithmetic expressions. Keep the existing exported function signatures and the items.reduce((sum, item) => expression, 0) form. Apply exactly one apply_patch call, a single Update File: invoice.mjs hunk (one @@), with no other file edits. The complete current file is:\n${INVOICE_BASELINE}\n` + (verifyEdit
        ? `After patch success, run exec_command exactly once with cmd=${JSON.stringify(verificationCommand)}, shell=${JSON.stringify(shellPath)}, workdir=${JSON.stringify(cwd)}, login=false, yield_time_ms=10000, max_output_tokens=2048. Then summarize the observed verification result. Do not run any other commands.`
        : "Do not run commands. After patch success, briefly report the change and say tests have not been run by you.")
      : readTask
      ? `Read invoice.mjs and diagnose invoiceTotal for one line with priceCents=125, quantity=4. Use exec_command exactly once with cmd=${JSON.stringify(READ_COMMAND)}, shell=${JSON.stringify(shellPath)}, login=false, workdir=${JSON.stringify(cwd)}, yield_time_ms=10000, max_output_tokens=2048. No other commands. Return only a JSON object with file, ignoresQuantity (boolean), observedTotal, expectedTotal, and marker (the source comment without // or spaces). Do not modify files.`
      : compactCheck ? `Remember this exact reference marker for later: ${contextMarker}. Reply with only 42. Do not use tools.` : "Reply with only 42. Do not use any tools.";
    const started = await rpc.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: prompt, text_elements: [] }] });
    let commandPid: number | undefined;
    if (toolCase === "concurrent-edit") {
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidMarker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      check(existsSync(pidMarker), "PROBE_COMMAND_START_UNCONFIRMED");
      writeFileSync(path.join(cwd, "inside.txt"), "USER_CONCURRENT_EDIT");
      externalEditWritten = true;
    }
    if (toolCase === "interrupt") {
      check(isObject(started) && isObject(started.turn) && typeof started.turn.id === "string", "PROBE_INVALID_TURN");
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidMarker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      check(existsSync(pidMarker), "PROBE_COMMAND_START_UNCONFIRMED");
      commandPid = Number(readFileSync(pidMarker, "utf8").replace(/^\uFEFF/, "").trim());
      check(Number.isSafeInteger(commandPid) && commandPid > 0, "PROBE_INVALID_COMMAND_PID");
      const beforeStop = await rpc.request("thread/backgroundTerminals/list", { threadId: thread.thread.id });
      check(isObject(beforeStop) && Array.isArray(beforeStop.data), "PROBE_INVALID_TERMINAL_LIST");
      stopping = true;
      await rpc.request("turn/interrupt", { threadId: thread.thread.id, turnId: started.turn.id });
      await rpc.request("thread/backgroundTerminals/clean", { threadId: thread.thread.id });
      let afterStop = await rpc.request("thread/backgroundTerminals/list", { threadId: thread.thread.id });
      const cleanupDeadline = Date.now() + 2_000;
      while (isObject(afterStop) && Array.isArray(afterStop.data) && afterStop.data.length > 0 && Date.now() < cleanupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        afterStop = await rpc.request("thread/backgroundTerminals/list", { threadId: thread.thread.id });
      }
      terminalCounts = { before: beforeStop.data.length, after: isObject(afterStop) && Array.isArray(afterStop.data) ? afterStop.data.length : "invalid" };
      check(isObject(afterStop) && Array.isArray(afterStop.data) && afterStop.data.length === 0, "PROBE_TERMINALS_STILL_RUNNING");
    }
    const terminal = await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROBE_TURN_TIMEOUT")), live ? 70_000 : 30_000); })]);
    check(isObject(terminal) && isObject(terminal.turn), "PROBE_INVALID_TERMINAL");
    observedTurnStatus = terminal.turn.status;
    const expectedStatus = faultCase || guardCase ? "failed" : toolCase === "interrupt" ? "interrupted" : "completed";
    check(terminal.turn.status === expectedStatus, "PROBE_TURN_FAILED");
    check(requests.length === (guardCase ? 1 : verifyEdit ? 3 : readTask || editTask || toolCase && toolCase !== "interrupt" ? 2 : 1) && rpc.deniedServerRequests === (toolCase === "deny" ? 1 : 0), "PROBE_UNEXPECTED_OPERATIONS");
    if (toolCase === "deny") check(!existsSync(marker), "PROBE_DECLINED_COMMAND_EXECUTED");
    if (commandPid) {
      let alive = true;
      const stoppedDeadline = Date.now() + 2_000;
      do {
        try { process.kill(commandPid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
      } while (alive && Date.now() < stoppedDeadline);
      await new Promise((resolve) => setTimeout(resolve, 8_500));
      interruptedProcessEnded = !alive && !existsSync(marker) && requests.length === 1;
      check(interruptedProcessEnded, "PROBE_INTERRUPT_PROCESS_NOT_STOPPED");
    }
    if (networkCase) check(isObject(toolResult) && toolResult.network === (toolCase === "network-control") && networkHits === (toolCase === "network-control" ? 1 : 0) &&
      toolResult.localTokenVisible === false && toolResult.apiKeyVisible === false && toolResult.tempWrite === true, "PROBE_NETWORK_OR_CREDENTIAL_BOUNDARY_FAILED");
    if (tempCase) check(isObject(toolResult) && toolResult.tempWithinRun === true && toolResult.tempExistsAfter === true && toolResult.tempWrite === true &&
      toolResult.localTokenVisible === false && toolResult.apiKeyVisible === false, "PROBE_TEMP_BOOTSTRAP_FAILED");
    if (toolCase === "concurrent-edit") {
      externalEditPreserved = readFileSync(path.join(cwd, "inside.txt"), "utf8").includes("USER_CONCURRENT_EDIT");
      check(externalEditPreserved, "PROBE_EXTERNAL_EDIT_OVERWRITTEN");
    }
    if (patchCase && !editTask) {
      const afterFiles = snapshot(cwd);
      check(readFileSync(path.join(cwd, "inside.txt"), "utf8").trim() === (toolCase === "patch-write" ? "EDITED_SYNTHETIC" : "INSIDE_SYNTHETIC") &&
        readFileSync(outside, "utf8") === "OUTSIDE_SYNTHETIC" && Object.keys(afterFiles).length === Object.keys(beforeFiles).length &&
        Object.entries(beforeFiles).every(([file, hash]) => file === "inside.txt" || afterFiles[file] === hash), "PROBE_PATCH_BOUNDARY_FAILED");
    }
    if (toolCase && !guardCase && !environmentCase && !patchCase && !["interrupt", "deny", "concurrent-edit"].includes(toolCase)) check(isObject(toolResult) && toolResult.inside === true && toolResult.outside === false && toolResult.sensitive === false &&
      toolResult.write === (toolCase === "write") && existsSync(marker) === (toolCase === "write"), "PROBE_EXECUTION_BOUNDARY_FAILED");
    const readBack = await rpc.request("thread/read", { threadId: thread.thread.id, includeTurns: true });
    check(isObject(readBack) && isObject(readBack.thread) && Array.isArray(readBack.thread.turns), "PROBE_INVALID_THREAD_READ");
    const lastTurn = readBack.thread.turns.at(-1);
    check(isObject(lastTurn) && lastTurn.status === expectedStatus, "PROBE_READ_STATUS_MISMATCH");
    if (typeof lastTurn.id === "string" && expectedStatus === "completed") completedIdentity = { threadId: thread.thread.id, turnId: lastTurn.id };
    check(!restartCheck || completedIdentity, "PROBE_RESTART_ID_MISSING");
    if (toolCase !== "interrupt" && !faultCase && !guardCase) check(Array.isArray(lastTurn.items) && lastTurn.items.some((item) => isObject(item) && item.type === "agentMessage" && typeof item.text === "string" &&
      (editTask ? item.text.length > 0 : (readTask ? checkDiagnosis(item.text, readMarker) : item.text === "42"))), "PROBE_READ_TEXT_MISMATCH");
    if (readTask) check(JSON.stringify(snapshot(cwd)) === JSON.stringify(beforeFiles) && readToolResultMatched, "PROBE_READ_FILES_CHANGED");
    if (editTask) {
      const actual = readFileSync(path.join(cwd, "invoice.mjs"), "utf8");
      check(actual === expectedCandidate && patchResultMatched, "PROBE_PATCH_CONTENT_MISMATCH");
      const checks = evaluateInvoiceSource(actual); independentChecks = checks;
      check(checks.every((test) => test.passed), "PROBE_INDEPENDENT_CHECK_FAILED");
      const afterFiles = snapshot(cwd);
      check(Object.keys(afterFiles).length === Object.keys(beforeFiles).length && Object.entries(beforeFiles).every(([file, hash]) => file === "invoice.mjs" || afterFiles[file] === hash), "PROBE_UNRELATED_FILES_CHANGED");
      if (verifyEdit) check(verificationResultMatched && commandExitCodes.length === 1 && commandExitCodes[0] === 0 && readFileSync(evaluatorPath, "utf8") === evaluatorSource, "PROBE_VERIFY_COMMAND_FAILED");
    }
    if (faultCase) check(JSON.stringify(snapshot(cwd)) === JSON.stringify(beforeFiles) && !notifications.some((method) => method.startsWith("item/commandExecution/") || method === "turn/diff/updated"), "PROBE_FAULT_SIDE_EFFECT");
    if (guardCase) check(gatewayFailure === "PROBE_RESPONSE_CONTRACT_REFUSED" && commandExitCodes.length === 0 && !itemTypes.includes("commandExecution") && !existsSync(marker) && JSON.stringify(snapshot(cwd)) === JSON.stringify(beforeFiles), "PROBE_GUARD_EXECUTION_OCCURRED");
    if (compactCheck) {
      const nextTerminal = async (method: string, params: Record<string, unknown>) => {
        clearTimeout(timer);
        completed = new Promise<unknown>((resolve) => { complete = resolve; });
        await rpc.request(method, params);
        const next = await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROBE_COMPACT_TIMEOUT")), live ? 70_000 : 30_000); })]);
        clearTimeout(timer);
        check(isObject(next) && isObject(next.turn) && next.turn.status === "completed", "PROBE_COMPACT_TURN_FAILED");
      };
      await nextTerminal("thread/compact/start", { threadId: thread.thread.id });
      check(itemTypes.includes("contextCompaction") && requests.length === 2, "PROBE_COMPACTION_NOT_OBSERVED");
      await nextTerminal("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Return only the exact reference marker I asked you to remember earlier. No tools.", text_elements: [] }] });
      const compactHistory = await rpc.request("thread/read", { threadId: thread.thread.id, includeTurns: true });
      check(isObject(compactHistory) && isObject(compactHistory.thread) && Array.isArray(compactHistory.thread.turns), "PROBE_COMPACT_HISTORY_MISSING");
      const last = compactHistory.thread.turns.at(-1);
      const markerMatched = isObject(last) && last.status === "completed" && Array.isArray(last.items) && last.items.some((item) => isObject(item) && item.type === "agentMessage" && typeof item.text === "string" && item.text.trim() === contextMarker);
      compactionResult = { markerMatched, requests: requests.length, compactionItemObserved: itemTypes.includes("contextCompaction"), filesUnchanged: JSON.stringify(snapshot(cwd)) === JSON.stringify(beforeFiles) };
      check(markerMatched && Number(requests.length) === 3 && rpc.deniedServerRequests === 0 && JSON.stringify(snapshot(cwd)) === JSON.stringify(beforeFiles), "PROBE_COMPACT_CHECK_FAILED");
    }
    result = { status: "passed", turnStatus: terminal.turn.status, readBack: faultCase || guardCase ? "failure-matched" : toolCase === "interrupt" ? "interrupted-matched" : (editTask ? "completed-and-independent-checks-passed" : (readTask ? "completed-and-diagnosis-matched" : "completed-and-text-matched")) };
  } catch (error) {
    result = { status: "failed", errorCode: error instanceof Error && /^(PROBE_|RPC_)[A-Z0-9_-]+$/.test(error.message) ? error.message : "PROBE_FAILED" };
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    stopping = true;
    upstreamAbort.abort();
    await activeUpstream?.catch(() => {});
    const shutdownStarted = Date.now();
    rpc.abort(new Error("PROBE_CLOSED"));
    child.stdin.end();
    let exitTimer: NodeJS.Timeout | undefined;
    // Pinned 0.162.0 drains background tasks and then threads, each with a 10s
    // bound. Allow those phases to finish instead of killing at their first deadline.
    exitCode = await Promise.race([closed, new Promise<undefined>((resolve) => { exitTimer = setTimeout(() => resolve(undefined), 25_000); })]);
    clearTimeout(exitTimer);
    if (exitCode === undefined) {
      forcedExit = true;
      child.kill();
      exitCode = await Promise.race([closed, new Promise<undefined>((resolve) => { exitTimer = setTimeout(() => resolve(undefined), 3_000); })]);
      clearTimeout(exitTimer);
    }
    shutdownMilliseconds = Date.now() - shutdownStarted;
    if (restartCheck && exitCode === 0 && result.status === "passed" && completedIdentity) {
      const beforeRestart = JSON.stringify(snapshot(cwd));
      restarted = await checkRestart(binary, cwd, env, completedIdentity.threadId, completedIdentity.turnId);
      if (!restarted.passed || blockedAfterStop !== 0 || JSON.stringify(snapshot(cwd)) !== beforeRestart) {
        result = { status: "failed", errorCode: "PROBE_RESTART_CHECK_FAILED" }; process.exitCode = 1;
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  key = "";
  if (toolCase === "interrupt" && interruptedProcessEnded !== true) await new Promise((resolve) => setTimeout(resolve, 8_500));
  const budget = ledger?.summary();
  ledger?.close();
  if (exitCode !== 0) result = { taskResult: result, status: "failed", errorCode: "PROBE_UNCLEAN_EXIT" };
  const shutdownDiagnostics = diagnoseExit ? {
    processorExited: stderrTail.includes("processor task exited"), outboundRouterExited: stderrTail.includes("outbound router task exited"),
    remoteControlLoopExited: stderrTail.includes("remote control websocket loop exited"),
    backgroundDrainTimeout: /timed out waiting.*background/i.test(stderrTail), threadShutdownTimeout: /timed out waiting.*thread/i.test(stderrTail),
    stdioCloseObserved: stderrTail.includes("stdio_connection_closed"), processExitEvent,
  } : "not-enabled";
  const report = { kind: live ? (editTask ? "engine-deepseek-bounded-edit-task" : (readTask ? "engine-deepseek-bounded-read-task" : "engine-deepseek-text-only")) : (scopedTools ? "engine-fixed-command-boundary" : "engine-local-synthetic-response-only"), ...result, engineVersion, engineSha256: binarySha,
    requests, notifications, diagnostics, compactCheck, compactionResult, deniedServerRequests: rpc.deniedServerRequests, stderrBytes, processExit: exitCode, shutdownMilliseconds, forcedExit, shutdownDiagnostics, restarted,
    upstream, gatewayFailure, budget, billVerified: false, realModel: live, toolsStrippedForTextProbe: live && !readTask && !editTask,
    upstreamOutputLimit: live ? MAX_OUTPUT_TOKENS : null, toolCase, faultCase, observedTurnStatus, toolResult, markerExists: existsSync(marker),
    interruptedProcessEnded, terminalCounts, blockedAfterStop, networkHits, externalEditWritten, externalEditPreserved,
    readTask, readToolResultMatched, filesUnchanged: readTask || faultCase || guardCase ? JSON.stringify(snapshot(cwd)) === JSON.stringify(beforeFiles) : "not-tested",
    editTask, verifyEdit, patchResultMatched, baselineChecks, independentChecks, commandExitCodes, verificationResultMatched,
    toolExecutionTested: scopedTools, sandboxEnforcement: scopedTools ? "MXC scoped; see bounded results" : "not-tested" };
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(`.local/reports/engine-contract-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  if (exitCode === 0 && (!restartCheck || restarted?.exitCode === 0)) run.cleanup();
  else process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
  } finally { key = ""; ledger?.close(); }
}

main().catch(() => { console.error("PROBE_START_FAILED"); process.exitCode = 1; });
