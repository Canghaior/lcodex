import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { BudgetLedger } from "./budget.js";
import { createRunDirectory } from "./run-directory.js";
import { PROJECT_MAX_INPUT_BYTES, requestDeepSeek, sendBoundedDeepSeek } from "./deepseek-request.js";
import { ResponsesStream } from "./responses-stream.js";
import { DESKTOP_MODEL } from "./deepseek-model.js";

const fakeKey = `sk-${"synthetic".repeat(2)}`;
const frame = (type: string, sequence_number: number, response?: unknown) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, sequence_number, response })}\r\n\r\n`;
const terminal = { status: "completed", usage: { input_tokens: 100, output_tokens: 20 }, output: [] };

test("Pro high thinking reserves its output budget and charges reasoning tokens exactly once", async () => {
  const run = createRunDirectory("pro thinking budget"), file = path.join(run.root, "ledger.jsonl");
  BudgetLedger.initialize(file); const ledger = new BudgetLedger(file);
  const body = { model: DESKTOP_MODEL.id, stream: true, store: false, tools: [],
    input: [{ role: "user", content: "合成测试" }], reasoning: { effort: "high" }, max_output_tokens: 8192 };
  let calls = 0;
  const fakeFetch: typeof fetch = async (_, options) => {
    calls++;
    assert.deepEqual(JSON.parse(String(options?.body)), body);
    assert.equal(ledger.pendingRequests()[0]!.maxMicros, (Buffer.byteLength(JSON.stringify(body)) + 1024) * 9 + 8192 * 27);
    return new Response(frame("response.completed", 0, { ...terminal,
      usage: { input_tokens: 100, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 1800 } } }),
    { headers: { "content-type": "text/event-stream" } });
  };
  try {
    for (const change of [{ reasoning: { effort: "none" } }, { reasoning: undefined }, { max_output_tokens: 8193 }]) {
      await assert.rejects(sendBoundedDeepSeek(ledger, "pro", fakeKey, { ...body, ...change }, fakeFetch), /REQUEST_BOUNDS_REQUIRED/);
    }
    assert.equal(calls, 0); assert.equal(ledger.summary().requests, 0);
    const result = await sendBoundedDeepSeek(ledger, "pro", fakeKey, body, fakeFetch);
    assert.equal(result.requestedModel, DESKTOP_MODEL.id);
    assert.equal(result.usage.reasoningTokens, 1800);
    assert.equal(result.usage.estimatedMicros, 54_900);
    assert.equal(ledger.summary().estimatedMicros, 54_900);
    assert.equal(ledger.summary().pending, 0);
    await assert.rejects(sendBoundedDeepSeek(ledger, "pro", fakeKey,
      { ...body, input: [{ role: "user", content: "x".repeat(90_000) }] }, fakeFetch, undefined, PROJECT_MAX_INPUT_BYTES), /BUDGET_TRIAL_LIMIT/);
    assert.equal(calls, 1, "An unaffordable reservation cannot start HTTP or silently reduce thinking");
  } finally { ledger.close(); run.cleanup(); }
});

test("Pro failed requests retain the model-specific reservation for reconciliation", async () => {
  const run = createRunDirectory("pro unknown"), file = path.join(run.root, "ledger.jsonl");
  BudgetLedger.initialize(file); const ledger = new BudgetLedger(file);
  const body = { model: DESKTOP_MODEL.id, stream: true, store: false, tools: [],
    input: [{ role: "user", content: "synthetic" }], reasoning: { effort: "high" }, max_output_tokens: 8192 };
  try {
    await assert.rejects(sendBoundedDeepSeek(ledger, "pro", fakeKey, body, async () => { throw new Error("synthetic disconnect"); }), /USAGE_UNKNOWN/);
    assert.equal(ledger.summary().pending, 1);
    assert.equal(ledger.summary().committedMicros, (Buffer.byteLength(JSON.stringify(body)) + 1024) * 9 + 8192 * 27);
    assert.throws(() => ledger.reserve("later", 1), /PENDING_RECONCILIATION/);
  } finally { ledger.close(); run.cleanup(); }
});

test("larger workflow context is explicit and still refuses oversized input before budget reservation", async () => {
  const run = createRunDirectory("workflow context"), file = path.join(run.root, "ledger.jsonl"); BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file); let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response(frame("response.completed", 0, terminal), { headers: { "content-type": "text/event-stream" } }); };
  const body = { model: "deepseek-flash", stream: true, store: false, max_output_tokens: 1024, tools: [], input: [{ role: "user", content: "x".repeat(20_000) }] };
  try {
    await assert.rejects(sendBoundedDeepSeek(ledger, "context", fakeKey, body, fakeFetch), /INPUT_SIZE_LIMIT/);
    assert.equal(ledger.summary().requests, 0);
    await sendBoundedDeepSeek(ledger, "context", fakeKey, body, fakeFetch, undefined, 49_152);
    await assert.rejects(sendBoundedDeepSeek(ledger, "context", fakeKey, { ...body, input: [{ role: "user", content: "x".repeat(50_000) }] }, fakeFetch, undefined, 49_152), /INPUT_SIZE_LIMIT/);
    assert.equal(calls, 1); assert.equal(ledger.summary().requests, 1);
  } finally { ledger.close(); run.cleanup(); }
});

test("desktop context stays within the same reservation and rejects excess before HTTP", async () => {
  const run = createRunDirectory("desktop context"), file = path.join(run.root, "ledger.jsonl"); BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file); let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++; assert.equal(ledger.pendingRequests()[0]!.maxMicros, 250_000);
    return new Response(frame("response.completed", 0, { ...terminal, usage: { input_tokens: 100_000, output_tokens: 1024 } }), { headers: { "content-type": "text/event-stream" } });
  };
  const body = { model: "deepseek-flash", stream: true, store: false, max_output_tokens: 1024, tools: [], input: [{ role: "user", content: "x".repeat(70_000) }] };
  try {
    await assert.rejects(sendBoundedDeepSeek(ledger, "context", fakeKey, body, fakeFetch, undefined, 49_152), /INPUT_SIZE_LIMIT/);
    await sendBoundedDeepSeek(ledger, "context", fakeKey, body, fakeFetch, undefined, PROJECT_MAX_INPUT_BYTES);
    assert.equal(ledger.summary().estimatedMicros, 208_192); assert.equal(ledger.summary().pending, 0);
    await assert.rejects(sendBoundedDeepSeek(ledger, "context", fakeKey, { ...body, input: [{ role: "user", content: "x".repeat(PROJECT_MAX_INPUT_BYTES) }] }, fakeFetch, undefined, PROJECT_MAX_INPUT_BYTES), /INPUT_SIZE_LIMIT/);
    assert.equal(calls, 1); assert.equal(ledger.summary().requests, 1);
  } finally { ledger.close(); run.cleanup(); }
});

test("SSE handles fragments and keeps failed/incomplete terminal distinct", () => {
  for (const status of ["completed", "failed", "incomplete"]) {
    const parser = new ResponsesStream();
    const data = frame("response.created", 0) + frame(`response.${status}`, 1, { ...terminal, status });
    for (const char of data) parser.push(char);
    assert.equal(parser.finish().response.status, status);
  }
});

test("missing terminal, duplicate sequence and mismatched status fail closed", () => {
  const missing = new ResponsesStream();
  missing.push(frame("response.created", 0));
  assert.throws(() => missing.finish(), /MISSING_TERMINAL/);
  assert.throws(() => missing.push(frame("response.created", 0)), /INVALID_SEQUENCE/);
  const mismatch = new ResponsesStream();
  assert.throws(() => mismatch.push(frame("response.completed", 0, { status: "failed" })), /STATUS_MISMATCH/);
});

test("actual request wrapper reserves before HTTP and settles returned usage", async () => {
  const run = createRunDirectory("request-test");
  const file = path.join(run.root, "synthetic-ledger.jsonl");
  BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file);
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(ledger.summary().pending, 1);
    assert.equal(url, "https://api.deepseek.com/responses");
    assert.equal(options?.redirect, "error");
    assert.equal(JSON.parse(String(options?.body)).max_output_tokens, 1024);
    assert.deepEqual(JSON.parse(String(options?.body)).reasoning, { effort: "none" });
    return new Response(frame("response.created", 0) + frame("response.completed", 1, terminal), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await requestDeepSeek(ledger, "test", fakeKey, [{ role: "user", content: "synthetic" }], [], "none", fakeFetch);
    assert.equal(calls, 1);
    assert.equal(result.usage.estimatedMicros, 360);
    assert.equal(ledger.summary().pending, 0);
  } finally { ledger.close(); run.cleanup(); }
});

test("HTTP errors leave unknown usage reserved, block retries and do not expose body", async () => {
  const run = createRunDirectory("request-fail-test");
  const file = path.join(run.root, "synthetic-ledger.jsonl");
  BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file);
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response("private response", { status: 401 }); };
  try {
    await assert.rejects(requestDeepSeek(ledger, "test", fakeKey, [], [], "none", fakeFetch), /API_HTTP_401/);
    assert.equal(ledger.summary().committedMicros, 250_000);
    await assert.rejects(requestDeepSeek(ledger, "test", fakeKey, [], [], "none", fakeFetch), /PENDING_RECONCILIATION/);
    assert.equal(calls, 1);
  } finally { ledger.close(); run.cleanup(); }
});

test("oversized input and server-side tools are refused before HTTP", async () => {
  const run = createRunDirectory("request-bounds-test");
  const file = path.join(run.root, "synthetic-ledger.jsonl");
  BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file);
  const fakeFetch: typeof fetch = async () => { throw new Error("should not be called"); };
  try {
    await assert.rejects(requestDeepSeek(ledger, "test", fakeKey, [{ content: "x".repeat(20_000) }], [], "none", fakeFetch), /INPUT_SIZE_LIMIT/);
    await assert.rejects(requestDeepSeek(ledger, "test", fakeKey, [], [{ type: "web_search" }], "auto", fakeFetch), /SERVER_TOOLS_REFUSED/);
    await assert.rejects(requestDeepSeek(ledger, "test", fakeKey, [], [{ type: "custom", name: "arbitrary" }], "auto", fakeFetch), /SERVER_TOOLS_REFUSED/);
    assert.equal(ledger.summary().requests, 0);
  } finally { ledger.close(); run.cleanup(); }
});

test("cancellation blocks unsent requests and retains the reservation of an in-flight request", async () => {
  const run = createRunDirectory("request-cancel-test");
  const file = path.join(run.root, "synthetic-ledger.jsonl");
  BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file);
  const body = { model: "deepseek-flash", stream: true, store: false, input: [{ role: "user", content: "42" }], tools: [], max_output_tokens: 1024 };
  let calls = 0;
  const fakeFetch: typeof fetch = async (_, options) => {
    calls++;
    return new Promise<Response>((_, reject) => {
      assert.ok(options?.signal);
      options.signal.addEventListener("abort", () => reject(new Error("synthetic cancellation")), { once: true });
    });
  };
  try {
    const before = new AbortController(); before.abort();
    await assert.rejects(sendBoundedDeepSeek(ledger, "cancel", fakeKey, body, fakeFetch, before.signal), /ABORTED_BEFORE_REQUEST/);
    assert.equal(ledger.summary().requests, 0);
    assert.equal(calls, 0);
    const during = new AbortController();
    const pending = sendBoundedDeepSeek(ledger, "cancel", fakeKey, body, fakeFetch, during.signal);
    during.abort();
    await assert.rejects(pending, /USAGE_UNKNOWN/);
    assert.equal(calls, 1);
    assert.equal(ledger.summary().pending, 1);
    assert.equal(ledger.summary().committedMicros, 250_000);
  } finally { ledger.close(); run.cleanup(); }
});

test("engine entry requires bounded stateless requests and preserves supplied instructions", async () => {
  const run = createRunDirectory("engine-gate-test");
  const file = path.join(run.root, "synthetic-ledger.jsonl");
  BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file);
  const body = { model: "deepseek-flash", stream: true, store: false, input: [{ role: "user", content: "42" }], tools: [],
    max_output_tokens: 1024, instructions: "synthetic instruction", reasoning: { effort: "none" } };
  let calls = 0;
  const fakeFetch: typeof fetch = async (_, options) => {
    calls++;
    assert.equal(JSON.parse(String(options?.body)).instructions, "synthetic instruction");
    return new Response(frame("response.completed", 0, terminal), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    for (const changed of [{ max_output_tokens: undefined }, { max_output_tokens: 0 }, { max_output_tokens: 1025 }, { max_output_tokens: 1.5 }, { previous_response_id: "previous" }, { background: true }, { model: "unknown" }]) {
      await assert.rejects(sendBoundedDeepSeek(ledger, "engine-test", fakeKey, { ...body, ...changed }, fakeFetch), /REQUEST_BOUNDS_REQUIRED/);
    }
    assert.equal(ledger.summary().requests, 0);
    const result = await sendBoundedDeepSeek(ledger, "engine-test", fakeKey, body, fakeFetch);
    assert.equal(calls, 1);
    assert.ok(result.wire.includes("response.completed"));
  } finally { ledger.close(); run.cleanup(); }
});

test("known credentials in messages or tool results are refused before reservation and HTTP", async () => {
  const run = createRunDirectory("outbound-secret-test");
  const file = path.join(run.root, "synthetic-ledger.jsonl");
  BudgetLedger.initialize(file);
  const ledger = new BudgetLedger(file);
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; throw new Error("should not be called"); };
  try {
    for (const input of [
      [{ role: "user", content: `copied credential: ${fakeKey}` }],
      [{ type: "function_call_output", call_id: "read", output: `command output: ${fakeKey}` }],
      [{ type: "custom_tool_call_output", call_id: "patch", output: fakeKey }],
      [{ role: "user", content: Buffer.from(fakeKey).toString("base64") }],
    ]) {
      await assert.rejects(requestDeepSeek(ledger, "secret", fakeKey, input, [], "none", fakeFetch), { message: "API_SENSITIVE_INPUT_REFUSED" });
    }
    await assert.rejects(requestDeepSeek(ledger, "secret", fakeKey, [], [{ type: "function", name: "read", description: fakeKey }], "none", fakeFetch), { message: "API_SENSITIVE_INPUT_REFUSED" });
    assert.equal(calls, 0);
    assert.equal(ledger.summary().requests, 0);
  } finally { ledger.close(); run.cleanup(); }
});
