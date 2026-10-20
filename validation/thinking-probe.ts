import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BudgetLedger } from "./budget.js";
import { DESKTOP_MODEL } from "./deepseek-model.js";
import { PRICE_REVIEW_DATE, sendBoundedDeepSeek } from "./deepseek-request.js";
import { prepareEngineModelRequest } from "./engine-model-request.js";
import { readKey } from "./read-key.js";
import { isObject } from "./rpc.js";
import { ResponsesStream } from "./responses-stream.js";
import { prepareSerialResponse } from "./serial-response.js";

async function main() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!process.argv.includes("--live") || today !== PRICE_REVIEW_DATE || !process.argv.includes(`--price-reviewed=${today}`)) throw new Error("PROBE_LIVE_PRICE_REQUIRED");
  let key = await readKey();
  const trial = process.argv.find(arg => arg.startsWith("--trial="))?.slice(8) ?? `thinking-${randomUUID()}`;
  if (!/^thinking-[a-f0-9-]{36}$/.test(trial)) throw new Error("PROBE_TRIAL_INVALID");
  const ledger = new BudgetLedger(path.resolve(".local/state/p1-budget.jsonl"));
  const records: Record<string, unknown>[] = [], before = ledger.summary(), started = Date.now();
  let status = "failed", error: string | null = null;
  try {
    const input: unknown[] = [{ role: "user", content: "Read the synthetic invoice using read_invoice, then report totalCents = unitCents * quantity and repeat its marker exactly. No filesystem, shell or network tool is available." }];
    const tools = [{ type: "function", name: "read_invoice", description: "Returns the synthetic invoice.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }];
    const marker = `SYNTHETIC_${randomUUID().slice(0, 8)}`;
    for (let round = 0; round < 2; round++) {
      const request = prepareEngineModelRequest({ model: DESKTOP_MODEL.id, input }, round === 0 ? tools : []);
      request.tool_choice = round === 0 ? "auto" : "none";
      const result = await sendBoundedDeepSeek(ledger, trial, key, request, async (url, init) => {
        const response = await fetch(url, init);
        if (!response.ok) {
          // This probe sends synthetic input only. Retain fixed diagnostic
          // categories, never arbitrary upstream text, input or credentials.
          const raw = await response.clone().text();
          if (Buffer.byteLength(raw) <= 8192) {
            let value: unknown; try { value = JSON.parse(raw); } catch {}
            const provider = isObject(value) && isObject(value.error) ? value.error : {};
            const message = String(provider.message ?? "");
            records.push({ httpStatus: response.status,
              errorType: typeof provider.type === "string" && /^[a-z_]{1,64}$/.test(provider.type) ? provider.type : "unknown",
              diagnosticTerms: ["model", "tool", "required", "thinking", "token", "support", "reasoning", "invalid", "exist", "parameter", "high", "budget"].filter(word => message.toLowerCase().includes(word)) });
          }
        }
        return response;
      });
      const shapes = new Map<string, { count: number; keys: string[] }>();
      const parser = new ResponsesStream(event => {
        const type = String(event.type), existing = shapes.get(type);
        shapes.set(type, { count: (existing?.count ?? 0) + 1, keys: Object.keys(event).sort() });
      });
      parser.push(result.wire); parser.finish();
      let adapter = "passed";
      try {
        prepareSerialResponse(result.wire, result.response, {
          patch: () => { throw new Error("PROBE_PATCH_REFUSED"); },
          functionCall: (name, args) => { assert.equal(name, "read_invoice"); assert.deepEqual(args, {}); },
        });
      } catch (failure) { adapter = failure instanceof Error && /^[A-Z_]+$/.test(failure.message) ? failure.message : "PROBE_ADAPTER_FAILED"; }
      records.push({ round: round + 1, requestedModel: result.requestedModel, reasoning: DESKTOP_MODEL.effort,
        terminal: result.terminalType, usage: result.usage, adapter, eventShapes: Object.fromEntries(shapes),
        outputShape: Array.isArray(result.response.output) ? result.response.output.filter(isObject).map(item => ({
          type: item.type, keys: Object.keys(item).sort(), contentTypes: Array.isArray(item.content) ? item.content.filter(isObject).map(part => part.type) : [],
        })) : [] });
      assert.equal(result.terminalType, "response.completed");
      assert.ok(Array.isArray(result.response.output));
      const output = result.response.output.filter(isObject);
      if (round === 0) {
        const calls = output.filter(item => item.type === "function_call");
        assert.equal(calls.length, 1); assert.equal(calls[0]!.name, "read_invoice");
        assert.equal(typeof calls[0]!.call_id, "string");
        input.push(...output, { type: "function_call_output", call_id: calls[0]!.call_id,
          output: JSON.stringify({ unitCents: 125, quantity: 4, marker }) });
      } else {
        const answer = output.filter(item => item.type === "message").flatMap(item => Array.isArray(item.content)
          ? item.content.filter(isObject).map(part => String(part.text ?? "")) : []).join("");
        assert.ok(answer.includes("500") && answer.includes(marker));
      }
    }
    assert.ok(records.some(record => isObject(record.usage) && Number(record.usage.reasoningTokens) > 0), "Thinking usage was not reported");
    assert.ok(records.every(record => record.adapter === "passed"), "Adapter did not accept thinking events");
    status = "passed";
  } catch (failure) {
    error = failure instanceof Error && /^(API_|SSE_|BUDGET_|PROBE_)[A-Z0-9_]+$/.test(failure.message) ? failure.message : "PROBE_ASSERTION_FAILED";
    process.exitCode = 1;
  } finally {
    key = "";
    const report = { trial, status, error, model: DESKTOP_MODEL, realModel: true, toolResults: "synthetic",
      filesSent: 0, before, after: ledger.summary(), durationMs: Date.now() - started, records, billVerified: false };
    ledger.close(); mkdirSync(".local/reports", { recursive: true });
    writeFileSync(path.resolve(".local/reports", `${trial}-${Date.now()}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && /^(API_|SSE_|BUDGET_|PROBE_)[A-Z0-9_]+$/.test(error.message) ? error.message : "PROBE_FAILED");
  process.exitCode = 1;
});
