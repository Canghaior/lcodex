import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { BudgetLedger } from "./budget.js";
import { createRunDirectory } from "./run-directory.js";
import { sendBoundedModel } from "./deepseek-request.js";
import { prepareEngineModelRequest } from "./engine-model-request.js";
import { OPENAI_MODEL, providerProfile, validProviderKey } from "../src/shared/providers.js";
import { commandProvider, validCommand } from "../src/shared/contracts.js";
import { prepareSerialResponse } from "./serial-response.js";
import { ResponsesStream } from "./responses-stream.js";

const key = `sk-proj-${"synthetic".repeat(30)}`;
const terminal = (usage: unknown = { input_tokens: 100, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 1800 } }) =>
  new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response: { status: "completed", output: [], usage } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
const request = () => prepareEngineModelRequest({ model: OPENAI_MODEL.id, input: [{ role: "user", content: "synthetic" }] }, [], { provider: "openai" });

test("OpenAI preserves native roles, encrypted reasoning, tool IDs and current instructions", () => {
  const input = [{ role: "developer", content: "trusted instructions" }, { role: "user", content: "read" },
    { id: "r1", type: "reasoning", summary: [], encrypted_content: "synthetic-encrypted-item" },
    { type: "function_call", name: "exec_command", call_id: "c1", arguments: '{"cmd":"Get-Content file"}' },
    { type: "function_call_output", call_id: "c1", output: "source" }];
  const before = JSON.stringify(input);
  const prepared = prepareEngineModelRequest({ model: OPENAI_MODEL.id, input, instructions: "original", store: true, service_tier: "priority" }, [{ type: "function", name: "exec_command" }], { provider: "openai", progressInstruction: "current boundary", finalResponseOnly: true });
  assert.deepEqual(prepared.input, input); assert.equal(JSON.stringify(input), before);
  assert.deepEqual(prepared.tools, []); assert.equal(prepared.tool_choice, "none");
  assert.match(String(prepared.instructions), /^original\ncurrent boundary/);
  assert.match(String(prepared.instructions), /final permitted/);
  assert.equal(prepared.store, false);
  assert.equal(prepared.service_tier, "default");
  assert.deepEqual(prepared.prompt_cache_options, { mode: "explicit" });
  assert.deepEqual(prepared.include, ["reasoning.encrypted_content"]);
  assert.throws(() => prepareEngineModelRequest({ model: "deepseek-v4-pro" }, [], { provider: "openai" }), /MODEL_MISMATCH/);
  assert.throws(() => prepareEngineModelRequest({ model: OPENAI_MODEL.id, previous_response_id: "remote" }, [], { provider: "openai" }), /UNSUPPORTED_ENGINE_STATE/);
});

test("USD and legacy CNY ledgers cannot be confused or reset when opening", () => {
  const run = createRunDirectory("provider currency");
  const usd = path.join(run.root, "usd.jsonl"), cny = path.join(run.root, "cny.jsonl");
  try {
    BudgetLedger.initialize(usd, undefined, "personal", "USD"); BudgetLedger.initialize(cny);
    const ledger = new BudgetLedger(usd, "personal", "USD");
    const id = ledger.reserve("first", 400_000); ledger.settle(id, 100_000); ledger.close();
    const before = readFileSync(usd, "utf8");
    assert.throws(() => new BudgetLedger(usd), /CORRUPT/);
    assert.throws(() => new BudgetLedger(usd, "personal", "CNY"), /CORRUPT/);
    assert.throws(() => new BudgetLedger(cny, "personal", "USD"), /CORRUPT/);
    assert.equal(readFileSync(usd, "utf8"), before);
    const restored = new BudgetLedger(usd, "personal", "USD");
    try { assert.equal(restored.summary().committedMicros, 100_000); assert.equal(restored.currency, "USD"); } finally { restored.close(); }
    assert.throws(() => BudgetLedger.initialize(path.join(run.root, "invalid.jsonl"), undefined, "development", "USD"), /CURRENCY_MISMATCH/);
  } finally { run.cleanup(); }
});

test("OpenAI routes only to its official endpoint, pre-reserves USD and counts reasoning once", async () => {
  const run = createRunDirectory("openai request"), file = path.join(run.root, "usd.jsonl");
  BudgetLedger.initialize(file, undefined, "personal", "USD");
  const ledger = new BudgetLedger(file, "personal", "USD");
  const body = request();
  let calls = 0;
  try {
    const result = await sendBoundedModel(ledger, "test", key, body, async (url, init) => {
      calls++; assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(init?.redirect, "error"); assert.deepEqual(JSON.parse(String(init?.body)), body);
      assert.equal(ledger.pendingRequests()[0]!.maxMicros, (Buffer.byteLength(JSON.stringify(body)) + 1024) * 8 + 8192 * 40);
      return terminal();
    }, undefined, 16_384, "openai");
    assert.equal(calls, 1); assert.equal(result.usage.estimatedMicros, 80_800);
    assert.equal(result.usage.reasoningTokens, 1800); assert.equal(ledger.summary().pending, 0);
    const before = ledger.summary();
    await assert.rejects(sendBoundedModel(ledger, "wrong", key, body, undefined, undefined, 16_384, "deepseek"), /CURRENCY_MISMATCH/);
    for (const changed of [{ model: "other" }, { service_tier: "priority" }, { prompt_cache_options: { mode: "implicit" } },
      { reasoning: { effort: "none" } }, { store: true }, { max_output_tokens: 8193 },
      { input: [{ role: "user", content: "synthetic", prompt_cache_breakpoint: {} }] }]) {
      await assert.rejects(sendBoundedModel(ledger, "invalid", key, { ...body, ...changed }, async () => { calls++; return terminal(); }, undefined, 16_384, "openai"), /API_/);
    }
    assert.equal(calls, 1); assert.deepEqual(ledger.summary(), before);
  } finally { ledger.close(); run.cleanup(); }
});

test("OpenAI cannot call above budget and retains failed or unexpected-charge reservations", async () => {
  for (const failure of ["network", "cache-write", "budget"]) {
    const run = createRunDirectory(`openai ${failure}`), file = path.join(run.root, "usd.jsonl");
    BudgetLedger.initialize(file, { totalMicros: 2_000_000, trialMicros: failure === "budget" ? 250_000 : 1_000_000, requestsPerTrial: 8 }, "personal", "USD");
    const ledger = new BudgetLedger(file, "personal", "USD"); let calls = 0;
    try {
      await assert.rejects(sendBoundedModel(ledger, "first", key, request(), async () => {
        calls++;
        if (failure === "network") throw new Error("synthetic");
        return terminal({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cache_write_tokens: 10 } });
      }, undefined, 16_384, "openai"), failure === "budget" ? /BUDGET_TRIAL_LIMIT/ : failure === "network" ? /USAGE_UNKNOWN/ : /CACHE_USAGE_UNEXPECTED/);
      assert.equal(calls, failure === "budget" ? 0 : 1);
      assert.equal(ledger.summary().pending, failure === "budget" ? 0 : 1);
      if (failure !== "budget") assert.throws(() => ledger.reserve("retry", 1), /PENDING_RECONCILIATION/);
    } finally { ledger.close(); run.cleanup(); }
  }
});

test("model selection and key validation are bounded to the two supported providers", () => {
  assert.equal(validCommand({ type: "set-provider", provider: "openai" }), true);
  assert.equal(validCommand({ type: "set-provider", provider: "https://example.com" }), false);
  assert.equal(validProviderKey(key, "openai"), true); assert.equal(validProviderKey(key, "deepseek"), false);
  assert.equal(validCommand({ type: "set-key", key }), true);
  assert.equal(providerProfile().id, "deepseek-v4-pro"); assert.equal(providerProfile("openai").currency, "USD");
  assert.equal(commandProvider({ type: "set-key", key }), "deepseek");
  assert.equal(commandProvider({ type: "set-key", key, provider: "openai" }), "openai");
  assert.equal(validCommand({ type: "delete-key", provider: "openai" }), true);
  assert.equal(validCommand({ type: "delete-key", provider: "unknown" }), false);
});

test("encrypted reasoning and refusal SSE survive delivery without granting tool access", async () => {
  const reasoning = { id: "r1", type: "reasoning", summary: [], content: null, encrypted_content: "final-encrypted" };
  const part = { type: "refusal", refusal: "Synthetic refusal for a protocol test." };
  const message = { id: "m1", type: "message", role: "assistant", status: "completed", content: [part] };
  const response = { status: "completed", output: [reasoning, message] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: "intermediate" } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
    { type: "response.content_part.added", output_index: 1, item_id: "m1", content_index: 0, part: { type: "refusal", refusal: "" } },
    { type: "response.refusal.delta", output_index: 1, item_id: "m1", content_index: 0, delta: part.refusal },
    { type: "response.refusal.done", output_index: 1, item_id: "m1", content_index: 0, refusal: part.refusal },
    { type: "response.content_part.done", output_index: 1, item_id: "m1", content_index: 0, part },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response },
  ];
  const wire = events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
  const prepared = prepareSerialResponse(wire, response, { patch: () => assert.fail(), functionCall: () => assert.fail() });
  const chunks: string[] = [];
  await prepared.deliver({ write: bytes => { chunks.push(bytes); }, beforeTool: () => assert.fail(), afterTool: async () => assert.fail(), signal: new AbortController().signal });
  const parser = new ResponsesStream(); parser.push(chunks.join(""));
  assert.deepEqual(parser.finish().response.output, response.output);
  const run = createRunDirectory("openai refusal history"), file = path.join(run.root, "usd.jsonl");
  BudgetLedger.initialize(file, undefined, "personal", "USD"); const ledger = new BudgetLedger(file, "personal", "USD");
  try {
    await sendBoundedModel(ledger, "continue", key, { ...request(), input: [reasoning, message, { role: "user", content: "continue safely" }] }, async (_, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).input[1], message); return terminal();
    }, undefined, 16_384, "openai");
  } finally { ledger.close(); run.cleanup(); }
});
