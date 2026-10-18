import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BudgetLedger, P1_LIMITS } from "./budget.js";
import { PRICE_REVIEW_DATE, requestDeepSeek } from "./deepseek-request.js";
import { isObject } from "./rpc.js";

async function readKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (!process.stdin.isTTY) throw new Error("PROBE_KEY_REQUIRED");
  process.stdout.write("Enter DeepSeek key (hidden input; memory only):\n");
  return new Promise((resolve, reject) => {
    let key = "";
    const done = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (error) reject(error); else resolve(key);
    };
    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\u0003") { done(new Error("PROBE_KEY_CANCELLED")); return; }
        if (char === "\r" || char === "\n") { done(); return; }
        if (char === "\u007f" || char === "\b") key = key.slice(0, -1);
        else key += char;
        if (key.length > 256) { done(new Error("PROBE_KEY_INVALID")); return; }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const stateDirectory = path.resolve(".local/state");
  mkdirSync(stateDirectory, { recursive: true });
  if (realpathSync(stateDirectory).toLowerCase() !== stateDirectory.toLowerCase()) throw new Error("PROBE_REDIRECTED_STATE");
  const ledgerPath = path.join(stateDirectory, "p1-budget.jsonl");
  if (process.argv.includes("--initialize-budget")) {
    BudgetLedger.initialize(ledgerPath);
    console.log(JSON.stringify({ initialized: true, limits: P1_LIMITS, requests: 0 }));
    return;
  }
  const reconciliationIndex = process.argv.indexOf("--account-unknown-reservation");
  if (reconciliationIndex >= 0) {
    const id = process.argv[reconciliationIndex + 1];
    if (!id) throw new Error("PROBE_RESERVATION_ID_REQUIRED");
    const ledger = new BudgetLedger(ledgerPath);
    try { ledger.accountUnknown(id); console.log(JSON.stringify({ accountedAtFullReservation: true, budget: ledger.summary(), billVerified: false })); }
    finally { ledger.close(); }
    return;
  }
  if (process.argv.includes("--list-models")) {
    let key = await readKey();
    try {
      const response = await fetch("https://api.deepseek.com/models", {
        headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`API_HTTP_${response.status}`); }
      const text = await response.text();
      if (Buffer.byteLength(text) > 16_384) throw new Error("PROBE_MODELS_TOO_LARGE");
      const body: unknown = JSON.parse(text);
      if (!isObject(body) || !Array.isArray(body.data)) throw new Error("PROBE_MODELS_INVALID");
      const models = body.data.filter(isObject).map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && /^deepseek-[a-z0-9.-]{1,80}$/.test(id));
      const report = { kind: "authenticated-model-metadata-only", models, inferenceRequests: 0 };
      mkdirSync(path.resolve(".local/reports"), { recursive: true });
      writeFileSync(path.resolve(".local/reports/model-list.json"), `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify(report, null, 2));
      return;
    } finally { key = ""; }
  }
  if (!process.argv.includes("--live") || !process.argv.includes(`--price-reviewed=${PRICE_REVIEW_DATE}`)) throw new Error("PROBE_LIVE_FLAGS_REQUIRED");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (today !== PRICE_REVIEW_DATE) throw new Error("PROBE_PRICE_REVIEW_EXPIRED");
  let key = await readKey();
  const ledger = new BudgetLedger(ledgerPath);
  const trial = "responses-add-v1";
  const requests: Record<string, unknown>[] = [];
  let status = "failed";
  let errorCode: string | null = null;
  try {
    const input = [{ role: "user", content: "Use the add tool to calculate 19 + 23. After receiving the result, reply with only the number." }];
    const tool = { type: "function", name: "add", description: "Add two integers in this synthetic protocol test.",
      parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false }, strict: true };
    const first = await requestDeepSeek(ledger, trial, key, input, [tool], { type: "function", name: "add" });
    requests.push({ terminalType: first.terminalType, events: first.events, usage: first.usage, returnedModel: first.response.model });
    if (first.terminalType !== "response.completed" || !Array.isArray(first.response.output)) throw new Error("PROBE_FIRST_TURN_INCOMPLETE");
    const calls = first.response.output.filter((item) => isObject(item) && item.type === "function_call");
    if (calls.length !== 1) throw new Error("PROBE_TOOL_COUNT_MISMATCH");
    const call = calls[0] as Record<string, unknown>;
    if (call.name !== "add" || typeof call.call_id !== "string" || typeof call.arguments !== "string") throw new Error("PROBE_TOOL_MISMATCH");
    let args: unknown;
    try { args = JSON.parse(call.arguments); } catch { throw new Error("PROBE_TOOL_ARGUMENTS_INVALID"); }
    if (!isObject(args) || args.a !== 19 || args.b !== 23) throw new Error("PROBE_TOOL_ARGUMENTS_INVALID");
    const second = await requestDeepSeek(ledger, trial, key,
      [...input, ...first.response.output, { type: "function_call_output", call_id: call.call_id, output: "42" }], [], "none");
    requests.push({ terminalType: second.terminalType, events: second.events, usage: second.usage, returnedModel: second.response.model });
    if (second.terminalType !== "response.completed" || !Array.isArray(second.response.output)) throw new Error("PROBE_SECOND_TURN_INCOMPLETE");
    const text = second.response.output.filter(isObject).filter((item) => item.type === "message")
      .flatMap((item) => Array.isArray(item.content) ? item.content.filter(isObject) : [])
      .filter((item) => item.type === "output_text").map((item) => item.text).join("").trim();
    if (text !== "42") throw new Error("PROBE_RESULT_MISMATCH");
    status = "passed";
  } catch (error) {
    errorCode = error instanceof Error && /^(PROBE_|API_|SSE_|BUDGET_)[A-Z0-9_]+$/.test(error.message)
      ? error.message : "PROBE_UNCLASSIFIED_FAILURE";
    process.exitCode = 1;
  } finally {
    key = "";
    const budget = ledger.summary();
    ledger.close();
    const report = { kind: "direct-deepseek-synthetic-protocol-probe", trial, status, errorCode, priceReviewDate: PRICE_REVIEW_DATE,
      requestedModel: "deepseek-flash", requests, budget, billVerified: false, engineIntegration: "not-tested", projectFilesSent: 0 };
    const reportDirectory = path.resolve(".local/reports");
    mkdirSync(reportDirectory, { recursive: true });
    // Preserve every attempt rather than overwriting an earlier failure.
    writeFileSync(path.join(reportDirectory, `responses-add-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^(PROBE_|API_|SSE_|BUDGET_)[A-Z0-9_]+$/.test(error.message) ? error.message : "PROBE_START_FAILED";
  console.error(JSON.stringify({ status: "failed", code }));
  process.exitCode = 1;
});
