import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isObject } from "./rpc.js";
import { MAX_BATCH_TOOLS } from "./serial-response.js";

export const TASK_LIMITS = { requests: 8, tools: 12, toolRounds: 8, consecutiveFailures: 2, durationMs: 180_000, commandMs: 45_000 } as const;
type Event = { type: "request" } | { type: "batch"; ids: string[] } | { type: "tool"; id: string } | { type: "result"; id: string; passed: boolean } | { type: "halt"; reason: string };
export class TaskLimits {
  private readonly fd: number;
  private readonly lockFd: number;
  private started = 0;
  private requests = 0;
  private tools = new Map<string, boolean | undefined>();
  private failures = 0;
  private halted = "";
  private closed = false;
  private batchPlanned = false;
  private queued: string[] = [];
  private rounds = 0;
  private recoveredUnfinished = false;
  static create(file: string, now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("TASK_CLOCK_INVALID");
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 2, started: now, limits: TASK_LIMITS }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.lockFd = openSync(file + ".lock", "wx", 0o600);
    try {
      const text = readFileSync(file, "utf8");
      if (!text.endsWith("\n") || Buffer.byteLength(text) > 65_536) throw new Error();
      const entries: unknown[] = text.trimEnd().split("\n").map(line => JSON.parse(line) as unknown), init = entries.shift();
      if (!isObject(init) || init.version !== 2 || !Number.isSafeInteger(init.started) || Number(init.started) < 0 || JSON.stringify(init.limits) !== JSON.stringify(TASK_LIMITS)) throw new Error();
      this.started = Number(init.started);
      for (const event of entries) this.replay(event);
      this.recoveredUnfinished = this.hasPending() || this.queued.length > 0;
      this.fd = openSync(file, "a");
    } catch { closeSync(this.lockFd); unlinkSync(file + ".lock"); throw new Error("TASK_STATE_INVALID"); }
  }
  private replay(value: unknown) {
    if (!isObject(value) || this.halted) throw new Error("TASK_EVENT_INVALID");
    if (value.type === "request" && !this.queued.length && !this.hasPending()) { this.requests++; this.batchPlanned = false; }
    else if (value.type === "batch" && this.requests > 0 && !this.batchPlanned && this.validBatch(value.ids)) {
      this.queued = [...value.ids]; this.batchPlanned = true; this.rounds++;
    } else if (value.type === "tool" && this.batchPlanned && this.queued[0] === value.id && typeof value.id === "string" && !this.tools.has(value.id) && !this.hasPending()) {
      this.queued.shift(); this.tools.set(value.id, undefined);
    } else if (value.type === "result" && typeof value.id === "string" && this.tools.has(value.id) && this.tools.get(value.id) === undefined && typeof value.passed === "boolean") {
      this.tools.set(value.id, value.passed); this.failures = value.passed ? 0 : this.failures + 1;
    } else if (value.type === "halt" && typeof value.reason === "string" && /^TASK_[A-Z_]+$/.test(value.reason)) this.halted = value.reason;
    else throw new Error("TASK_EVENT_INVALID");
    if (this.requests > TASK_LIMITS.requests || this.tools.size + this.queued.length > TASK_LIMITS.tools || this.rounds > TASK_LIMITS.toolRounds) throw new Error("TASK_STATE_OVERRUN");
  }
  private hasPending() { return [...this.tools.values()].some(value => value === undefined); }
  private validBatch(ids: unknown): ids is string[] {
    return Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_BATCH_TOOLS && new Set(ids).size === ids.length &&
      ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 256 && !this.tools.has(id));
  }
  private append(event: Event) {
    if (this.closed) throw new Error("TASK_CLOSED");
    try { writeFileSync(this.fd, JSON.stringify(event) + "\n"); fsyncSync(this.fd); this.replay(event); }
    catch { this.halted = "TASK_STATE_RECONCILE"; throw new Error(this.halted); }
  }
  halt(reason: string): never {
    if (!/^TASK_[A-Z_]+$/.test(reason)) throw new Error("TASK_HALT_INVALID");
    if (!this.halted) this.append({ type: "halt", reason });
    throw new Error(this.halted);
  }
  check() {
    if (this.closed) throw new Error("TASK_CLOSED");
    if (this.halted) throw new Error(this.halted);
    if (this.recoveredUnfinished) this.halt(this.hasPending() ? "TASK_TOOL_RESULT_UNKNOWN" : "TASK_BATCH_RECONCILE");
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < this.started) this.halt("TASK_CLOCK_RECONCILE");
    if (now - this.started >= TASK_LIMITS.durationMs) this.halt("TASK_TIME_LIMIT");
    if (this.failures >= TASK_LIMITS.consecutiveFailures) this.halt("TASK_FAILURE_LIMIT");
  }
  request() {
    this.check();
    if (this.hasPending()) this.halt("TASK_TOOL_RESULT_UNKNOWN");
    if (this.queued.length) this.halt("TASK_BATCH_RECONCILE");
    if (this.requests >= TASK_LIMITS.requests) this.halt("TASK_REQUEST_LIMIT");
    this.append({ type: "request" });
  }
  planBatch(ids: string[]) {
    this.check();
    if (!this.requests || this.batchPlanned || this.hasPending() || !this.validBatch(ids)) this.halt("TASK_TOOL_SEQUENCE_REFUSED");
    if (this.tools.size + ids.length > TASK_LIMITS.tools || this.rounds >= TASK_LIMITS.toolRounds) this.halt("TASK_TOOL_LIMIT");
    this.append({ type: "batch", ids: [...ids] });
  }
  tool(id: string) {
    this.check();
    if (!this.batchPlanned) this.planBatch([id]);
    if (this.queued[0] !== id || this.tools.has(id) || this.hasPending()) this.halt("TASK_TOOL_SEQUENCE_REFUSED");
    this.append({ type: "tool", id });
  }
  result(id: string, passed: boolean) {
    if (this.halted) throw new Error(this.halted);
    if (this.recoveredUnfinished) this.halt("TASK_TOOL_RESULT_UNKNOWN");
    if (!this.tools.has(id) || this.tools.get(id) !== undefined) this.halt("TASK_RESULT_REFUSED");
    this.append({ type: "result", id, passed });
  }
  summary() { return { requests: this.requests, tools: this.tools.size, toolRounds: this.rounds, queued: this.queued.length, consecutiveFailures: this.failures, pending: [...this.tools.values()].filter(value => value === undefined).length, halted: this.halted || null, limits: TASK_LIMITS }; }
  close() { if (!this.closed) { this.closed = true; closeSync(this.fd); closeSync(this.lockFd); unlinkSync(this.file + ".lock"); } }
}
