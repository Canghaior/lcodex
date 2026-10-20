import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeSession } from "../dist/src/main/engine/session.js";
import { localDay } from "../dist/src/main/storage/pricing.js";
import { BudgetLedger } from "../dist/validation/budget.js";
import { createRunDirectory } from "../dist/validation/run-directory.js";
import { DESKTOP_MODEL } from "../dist/validation/deepseek-model.js";

function responseFor(item, n, incomplete = false) {
  const reasoning = { id: `reason-${n}`, type: "reasoning", status: "completed", summary: [], encrypted_content: null,
    content: [{ type: "reasoning_text", text: `Synthetic reasoning ${n}, preserve for next request.` }] };
  const response = { id: `limit-response-${n}`, object: "response", status: incomplete ? "incomplete" : "completed", model: DESKTOP_MODEL.id,
    output: [reasoning, item], usage: { input_tokens: 50, output_tokens: 100, total_tokens: 150, output_tokens_details: { reasoning_tokens: 10 } } };
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
for (const finalKind of ["message", "function_call", "custom_tool_call", "incomplete"]) {
  test(`the eighth request permits only a summary: ${finalKind}`, { timeout: 120000 }, async () => {
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
          const item = n === 8 && finalKind === "message"
            ? { id: `message-${n}`, type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: "Request limit reached. source.txt was read; tests remain unverified.", annotations: [] }] }
            : n === 8 && finalKind === "custom_tool_call"
              ? { id: `item-${n}`, type: "custom_tool_call", name: "apply_patch", call_id: `call-${n}`, status: "completed",
                  input: "*** Begin Patch\n*** Add File: forbidden.txt\n+must not run\n*** End Patch" }
              : { id: `item-${n}`, type: "function_call", name: "exec_command", call_id: `call-${n}`, status: "completed",
                  arguments: JSON.stringify({ cmd: n === 8 ? "Set-Content -LiteralPath './forbidden.txt' -Value 'must not run'" : "Get-Content -LiteralPath './source.txt' -Raw",
                    shell, login: false, workdir: workspace, yield_time_ms: 10000, max_output_tokens: 2048 }) };
          return responseFor(item, n, n === 8 && finalKind === "incomplete");
        },
      });
      writeFileSync(path.join(run.root, "outcome.json"), JSON.stringify({
        finalKind, result, requests: requests.length, boundaryCalls: events.filter(event => event.method === "boundary/toolPlan").length,
        forbiddenFileExists: existsSync(path.join(workspace, "forbidden.txt")), budget: ledger.summary(),
      }, null, 2));
      assert.equal(requests.length, 8);
      assert.equal(result.requests, 8);
      assert.equal(result.cleanExit, true, JSON.stringify(result));
      assert.equal(result.status, finalKind === "message" ? "completed" : "failed", JSON.stringify(result));
      assert.equal(result.code, finalKind === "message" ? null : finalKind === "incomplete" ? "API_RESPONSE_INCOMPLETE" : "TASK_FINAL_RESPONSE_TOOL_REFUSED");
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
