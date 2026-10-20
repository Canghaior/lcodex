import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirmedSessionExit, executeSession } from "../dist/src/main/engine/session.js";
import { localDay } from "../dist/src/main/storage/pricing.js";
import { BudgetLedger } from "../dist/validation/budget.js";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { DESKTOP_MODEL } from "../dist/validation/deepseek-model.js";
import { spawnOwnedEngine } from "../dist/validation/owned-engine.js";

function responseFor(item, n, incomplete = false) {
  const reasoning = { id: `reason-${n}`, type: "reasoning", status: "completed", summary: [], encrypted_content: null,
    content: [{ type: "reasoning_text", text: `Synthetic reasoning ${n}, preserve for next request.` }] };
  const response = { id: `limit-response-${n}`, object: "response", status: incomplete ? "incomplete" : "completed", model: DESKTOP_MODEL.id,
    output: [reasoning, ...(Array.isArray(item) ? item : [item])], usage: { input_tokens: 50, output_tokens: 100, total_tokens: 150, output_tokens_details: { reasoning_tokens: 10 } } };
  const events = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } }];
  for (const [output_index, current] of response.output.entries()) {
    const textItem = ["message", "reasoning"].includes(current.type);
    events.push({ type: "response.output_item.added", output_index, item: textItem ? { ...current, content: [], status: "in_progress" } : current });
    if (textItem) {
      const part = current.content[0], prefix = current.type === "reasoning" ? "response.reasoning_text" : "response.output_text";
      events.push(
        { type: "response.content_part.added", item_id: current.id, output_index, content_index: 0, part: { ...part, text: "" } },
        { type: prefix + ".delta", item_id: current.id, output_index, content_index: 0, delta: part.text },
        { type: prefix + ".done", item_id: current.id, output_index, content_index: 0, text: part.text },
        { type: "response.content_part.done", item_id: current.id, output_index, content_index: 0, part },
      );
    }
    events.push({ type: "response.output_item.done", output_index, item: current });
  }
  events.push({ type: incomplete ? "response.incomplete" : "response.completed", response });
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

// The model is simulated. app-server, Windows MXC, commands and history are real.
// Every ledger here is synthetic and distinct from the paid development ledger.
for (const scenario of ["message", "reaped-message", "function_call", "custom_tool_call", "incomplete", "dsml"]) {
  const finalKind = scenario === "reaped-message" ? "message" : scenario;
  test(`the eighth request permits only a summary: ${scenario}`, { timeout: 120000 }, async () => {
    const run = createRunDirectory("session limit 中文"), workspace = path.join(run.root, "workspace");
    const original = path.join(run.root, "original"), privateDir = path.join(run.root, "private");
    const runtimes = path.resolve(".local/releases/win-unpacked/resources/runtimes");
    const engine = path.join(runtimes, "codex/bin/codex.exe"), shell = path.join(runtimes, "powershell/pwsh.exe"), node = path.join(runtimes, "node/node.exe");
    const marker = ".lcodex-limit-root";
    for (const directory of [workspace, original, privateDir]) mkdirSync(directory);
    writeFileSync(path.join(workspace, marker), "");
    writeFileSync(path.join(workspace, "source.txt"), "ACTUAL_READ_EVIDENCE\n");
    writeFileSync(path.join(original, "source.txt"), "ORIGINAL_UNCHANGED\n");
    const ledgerFile = path.join(privateDir, "mock-budget.jsonl");
    BudgetLedger.initialize(ledgerFile);
    const ledger = new BudgetLedger(ledgerFile), events = [], requests = [], abort = new AbortController();
    let clean = false;
    try {
      const result = await executeSession({ engine, shell, node, root: run.root, workspace, privateDir, original, rootMarker: marker,
        readOnlyAssets: [], readOnlyDirectories: [], mode: "write", prompt: "Read source.txt and report the observed evidence.",
        testCommand: "", key: "sk-synthetic-session-limit-only", ledger, signal: abort.signal, priceConfirmedOn: localDay(),
        onIdentity: () => {}, onEvent: (method, params) => events.push({ method, params }),
        ...(scenario === "reaped-message" ? { spawnImpl: options => {
          const owner = spawnOwnedEngine(options);
          // Fault injection: a completed real engine never receives EOF. The
          // production 25s deadline must reap its job, then use a separate real
          // engine to confirm saved history without making a ninth model call.
          owner.child.stdin.end = () => owner.child.stdin;
          return owner;
        } } : {}),
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://api.deepseek.com/responses");
          const body = JSON.parse(init.body), n = requests.push(body);
          assert.equal(body.model, DESKTOP_MODEL.id);
          assert.deepEqual(body.reasoning, { effort: "high" });
          assert.equal(body.max_output_tokens, 8192);
          assert.equal(body.input.filter(item => item.type === "reasoning" && JSON.stringify(item.content).includes("Synthetic reasoning")).length, n - 1,
            "The actual engine must return all prior thinking content, not just tool results");
          assert.ok(n <= 8, "No ninth model request may be sent");
          assert.equal(body.tool_choice, n === 8 ? "none" : "auto");
          assert.match(JSON.stringify(body.input), /working directory is the selected project root itself/);
          if (n === 8) {
            const outputs = body.input.filter(item => item.type === "function_call_output");
            assert.equal(outputs.length, 7, "Actual tool history must reach the final request");
            assert.ok(outputs.every(item => String(item.output).includes("ACTUAL_READ_EVIDENCE")));
            assert.match(body.input.at(-1).content, /final permitted model request/);
            assert.equal(body.input.at(-1).role, "system");
            assert.deepEqual(body.tools, []);
          }
          const item = n === 8 && ["message", "dsml"].includes(finalKind)
            ? { id: `message-${n}`, type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: finalKind === "dsml" ? "<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"exec_command\">"
                  : "Request limit reached. source.txt was read; tests remain unverified.", annotations: [] }] }
            : n === 8 && finalKind === "custom_tool_call"
              ? { id: `item-${n}`, type: "custom_tool_call", name: "apply_patch", call_id: `call-${n}`, status: "completed",
                  input: "*** Begin Patch\n*** Add File: forbidden.txt\n+must not run\n*** End Patch" }
              : { id: `item-${n}`, type: "function_call", name: "exec_command", call_id: `call-${n}`, status: "completed",
                  arguments: JSON.stringify({ cmd: n === 8 ? "Set-Content -LiteralPath './forbidden.txt' -Value 'must not run'" : "Get-Content -LiteralPath './source.txt' -Raw" }) };
          return responseFor(item, n, n === 8 && finalKind === "incomplete");
        },
      });
      writeFileSync(path.join(run.root, "outcome.json"), JSON.stringify({
        finalKind, result, requests: requests.length, boundaryCalls: events.filter(event => event.method === "boundary/toolPlan").length,
        forbiddenFileExists: existsSync(path.join(workspace, "forbidden.txt")), budget: ledger.summary(),
      }, null, 2));
      assert.equal(requests.length, 8);
      assert.equal(result.requests, 8);
      assert.equal(result.processesEnded, true, JSON.stringify(result));
      assert.equal(confirmedSessionExit(result), true, JSON.stringify(result));
      if (scenario === "reaped-message") { assert.equal(result.cleanExit, false); assert.equal(result.reconciledExit, true); }
      assert.equal(result.status, finalKind === "message" ? "completed" : "failed", JSON.stringify(result));
      assert.equal(result.code, finalKind === "message" ? null : finalKind === "incomplete" ? "API_RESPONSE_INCOMPLETE" : finalKind === "dsml" ? "TASK_FINAL_ANSWER_INVALID" : "TASK_FINAL_RESPONSE_TOOL_REFUSED");
      assert.equal(events.filter(event => event.method === "boundary/toolPlan").length, 7);
      assert.equal(existsSync(path.join(workspace, "forbidden.txt")), false, "A final-call command or patch must never execute");
      assert.equal(readFileSync(path.join(original, "source.txt"), "utf8"), "ORIGINAL_UNCHANGED\n");
      assert.deepEqual(ledger.summary(), { committedMicros: 25200, estimatedMicros: 25200, unknownMicros: 0, pending: 0, overrun: false, requests: 8 });
      clean = true;
    } finally {
      ledger.close();
      if (clean) run.cleanup(); else console.log("Retained session-limit fixture:", path.basename(run.root));
    }
  });
}

for (const obey of [true, false]) test(`the tool count leaves a final summary without a thirteenth execution (obey=${obey})`, { timeout: 120000 }, async () => {
  const run = createRunDirectory("tool count 中文"), workspace = path.join(run.root, "workspace");
  const original = path.join(run.root, "original"), privateDir = path.join(run.root, "private");
  for (const directory of [workspace, original, privateDir]) mkdirSync(directory);
  const marker = ".lcodex-count-root";
  writeFileSync(path.join(workspace, marker), "");
  writeFileSync(path.join(workspace, "source.txt"), "TWELVE_ACTUAL_READS\n");
  const runtimes = path.resolve(".local/releases/win-unpacked/resources/runtimes");
  const engine = path.join(runtimes, "codex/bin/codex.exe"), shell = path.join(runtimes, "powershell/pwsh.exe"), node = path.join(runtimes, "node/node.exe");
  const ledgerFile = path.join(privateDir, "mock-budget.jsonl");
  BudgetLedger.initialize(ledgerFile);
  const ledger = new BudgetLedger(ledgerFile), events = [], requests = [], abort = new AbortController();
  let clean = false;
  const command = index => ({ id: `item-${index}`, type: "function_call", name: "exec_command", call_id: `call-${index}`, status: "completed",
    arguments: JSON.stringify({ cmd: index === 13 ? "Set-Content forbidden.txt unexpected" : "Get-Content source.txt" }) });
  try {
    const result = await executeSession({ engine, shell, node, root: run.root, workspace, privateDir, original, rootMarker: marker,
      readOnlyAssets: [], readOnlyDirectories: [], mode: "read", prompt: "Read the source and explain observed facts.",
      testCommand: "", key: "sk-synthetic-tool-count-only", ledger, signal: abort.signal, priceConfirmedOn: localDay(),
      onIdentity: () => {}, onEvent: (method, params) => events.push({ method, params }),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body), n = requests.push(body);
        assert.ok(n <= 4, "After all twelve tools the next response must end the task");
        assert.match(body.input.at(-1).content, new RegExp(`Remaining tool calls: ${Math.max(0, 12 - (n - 1) * 4)}/12`));
        if (n <= 3) return responseFor(Array.from({ length: 4 }, (_, i) => command((n - 1) * 4 + i + 1)), n);
        assert.equal(body.tool_choice, "none"); assert.deepEqual(body.tools, []);
        const results = body.input.filter(item => item.type === "function_call_output");
        assert.equal(results.length, 12);
        assert.ok(results.every(item => String(item.output).includes("TWELVE_ACTUAL_READS")));
        return responseFor(obey ? { id: "final", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Twelve-tool limit reached. source.txt was read. Tests are unverified.", annotations: [] }] } : command(13), n);
      } });
    assert.equal(result.status, obey ? "completed" : "failed");
    assert.equal(result.code, obey ? null : "TASK_FINAL_RESPONSE_TOOL_REFUSED");
    assert.equal(result.requests, 4); assert.equal(confirmedSessionExit(result), true);
    assert.equal(events.filter(event => event.method === "item/completed" && event.params?.item?.type === "commandExecution").length, 12);
    assert.equal(existsSync(path.join(workspace, "forbidden.txt")), false);
    assert.equal(ledger.summary().requests, 4);
    clean = true;
  } finally { ledger.close(); if (clean) run.cleanup(); }
});

for (const obey of [true, false]) test(`the last tool opportunity is reserved for actual verification (obey=${obey})`, { timeout: 120000 }, async () => {
  const run = createRunDirectory("session verify 中文");
  const workspace = path.join(run.root, "workspace"), original = path.join(run.root, "original"), privateDir = path.join(run.root, "private");
  for (const dir of [workspace, original, privateDir]) mkdirSync(dir);
  writeFileSync(path.join(workspace, ".lcodex-root"), ""); writeFileSync(path.join(workspace, "source.txt"), "READ_EVIDENCE");
  writeFileSync(path.join(original, "source.txt"), "ORIGINAL");
  const runtimes = path.resolve(".local/releases/win-unpacked/resources/runtimes");
  const ledgerFile = path.join(privateDir, "mock-budget.jsonl"); BudgetLedger.initialize(ledgerFile);
  const ledger = new BudgetLedger(ledgerFile), events = [], requests = [];
  const testCommand = "if (Test-Path -LiteralPath './changed.txt') { Write-Output 'VERIFIED'; exit 0 } else { exit 1 }";
  let clean = false;
  try {
    const result = await executeSession({ engine: path.join(runtimes, "codex/bin/codex.exe"), shell: path.join(runtimes, "powershell/pwsh.exe"),
      node: path.join(runtimes, "node/node.exe"), root: run.root, workspace, original, privateDir, rootMarker: ".lcodex-root",
      readOnlyAssets: [], readOnlyDirectories: [], mode: "write", projectFiles: ["source.txt"], prompt: "Make a small change and verify it.",
      testCommand, key: "sk-synthetic-session-verify-only", ledger, signal: new AbortController().signal, priceConfirmedOn: localDay(),
      onIdentity: () => {}, onEvent: (method, params) => events.push({ method, params }),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body), n = requests.push(body);
        if (n === 7) {
          assert.equal(body.tools.length, 1); assert.equal(body.tools[0].name, "exec_command");
          assert.deepEqual(body.tools[0].parameters.properties.cmd.enum, [testCommand]);
          assert.match(body.input.at(-1).content, /Last actual verification exit code: 1/);
        }
        if (n === 8) {
          assert.match(body.input.at(-1).content, /no later tool has invalidated/);
          assert.ok(body.input.some(item => item.type === "function_call_output" && String(item.output).includes("VERIFIED")));
        }
        const item = n === 6 || n === 7 && !obey
          ? { id: `i-${n}`, type: "custom_tool_call", name: "apply_patch", call_id: `c-${n}`, status: "completed",
            input: `*** Begin Patch\n*** Add File: ${n === 6 ? "changed.txt" : "forbidden.txt"}\n+changed\n*** End Patch` }
          : n === 8 ? { id: "answer", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Actual verification completed.", annotations: [] }] }
          : { id: `i-${n}`, type: "function_call", name: "exec_command", call_id: `c-${n}`, status: "completed",
            arguments: JSON.stringify({ cmd: n === 1 || n === 7 ? testCommand : "Get-Content -LiteralPath './source.txt' -Raw" }) };
        return responseFor(item, n);
      },
    });
    writeFileSync(path.join(run.root, "outcome.json"), JSON.stringify({ obey, result, requests: requests.length }));
    assert.equal(result.processesEnded, true, JSON.stringify(result));
    assert.equal(confirmedSessionExit(result), true, JSON.stringify(result));
    assert.equal(result.status, obey ? "completed" : "failed", JSON.stringify(result));
    assert.equal(result.code, obey ? null : "TASK_VERIFICATION_REQUIRED");
    assert.equal(requests.length, obey ? 8 : 7);
    assert.equal(existsSync(path.join(workspace, "forbidden.txt")), false);
    assert.equal(readFileSync(path.join(original, "source.txt"), "utf8"), "ORIGINAL");
    const checks = events.filter(event => event.method === "item/completed" && event.params.item?.type === "commandExecution");
    assert.equal(checks.at(-1).params.item.exitCode, 0);
    clean = true;
  } finally { ledger.close(); if (clean) run.cleanup(); else console.log("Retained verification fixture:", path.basename(run.root)); }
});
