import { appendFileSync, closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Integer micro-yuan avoids floating-point accumulation. These limits are user-authorized.
export const P1_LIMITS = { totalMicros: 10_000_000, trialMicros: 1_000_000, requestsPerTrial: 8 } as const;
type Entry =
  | { type: "init"; version: 1; limits: typeof P1_LIMITS }
  | { type: "reserve"; id: string; trial: string; maxMicros: number }
  | { type: "settle"; id: string; actualMicros: number }
  | { type: "account-unknown"; id: string };
type Request = { trial: string; maxMicros: number; actualMicros?: number; unknownAccounted?: boolean };

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

export class BudgetLedger {
  private lockFd: number;
  private closed = false;
  private poisoned = false;
  private requests = new Map<string, Request>();

  // Explicit one-time initialization. Opening or retrying never creates a missing ledger.
  static initialize(file: string): void {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ type: "init", version: 1, limits: P1_LIMITS })}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  constructor(private file: string) {
    check(existsSync(file), "BUDGET_LEDGER_MISSING");
    this.lockFd = openSync(`${file}.lock`, "wx", 0o600);
    try {
      const contents = readFileSync(file, "utf8");
      check(contents.endsWith("\n"), "BUDGET_CORRUPT");
      const lines = contents.trimEnd().split("\n");
      const init = JSON.parse(lines.shift() ?? "null") as Record<string, unknown> | null;
      check(init?.type === "init" && init.version === 1 && JSON.stringify(init.limits) === JSON.stringify(P1_LIMITS), "BUDGET_WRONG_LIMITS");
      for (const line of lines) this.replay(JSON.parse(line));
    } catch {
      this.close();
      throw new Error("BUDGET_CORRUPT");
    }
  }

  private replay(entry: Entry): void {
    check(entry && typeof entry === "object" && typeof entry.type === "string", "BUDGET_CORRUPT");
    if (entry.type === "reserve") {
      check(typeof entry.id === "string" && !this.requests.has(entry.id) && typeof entry.trial === "string" &&
        /^[a-z0-9-]{1,64}$/.test(entry.trial) && natural(entry.maxMicros) && entry.maxMicros > 0, "BUDGET_CORRUPT");
      // A persisted reservation must have satisfied the limits at its point in history.
      this.checkReservation(entry.trial, entry.maxMicros);
      this.requests.set(entry.id, { trial: entry.trial, maxMicros: entry.maxMicros });
    } else if (entry.type === "settle") {
      const request = this.requests.get(entry.id);
      check(request && request.actualMicros === undefined && !request.unknownAccounted && natural(entry.actualMicros), "BUDGET_CORRUPT");
      request.actualMicros = entry.actualMicros;
    } else if (entry.type === "account-unknown") {
      const request = this.requests.get(entry.id);
      check(request && request.actualMicros === undefined && !request.unknownAccounted, "BUDGET_CORRUPT");
      request.unknownAccounted = true;
    } else throw new Error("BUDGET_CORRUPT");
  }

  summary() {
    let committedMicros = 0;
    let estimatedMicros = 0;
    let pending = 0;
    let overrun = false;
    let unknownMicros = 0;
    for (const request of this.requests.values()) {
      committedMicros += request.actualMicros ?? request.maxMicros;
      estimatedMicros += request.actualMicros ?? 0;
      if (request.actualMicros === undefined && !request.unknownAccounted) pending++;
      if (request.unknownAccounted) unknownMicros += request.maxMicros;
      if (request.actualMicros !== undefined && request.actualMicros > request.maxMicros) overrun = true;
    }
    return { committedMicros, estimatedMicros, unknownMicros, pending, overrun, requests: this.requests.size };
  }

  private checkReservation(trial: string, maxMicros: number): void {
    check(!this.closed && !this.poisoned, "BUDGET_CLOSED");
    check(/^[a-z0-9-]{1,64}$/.test(trial) && natural(maxMicros) && maxMicros > 0, "BUDGET_INVALID_RESERVATION");
    const state = this.summary();
    check(!state.overrun, "BUDGET_ESTIMATE_OVERRUN");
    check(state.pending === 0, "BUDGET_PENDING_RECONCILIATION");
    const trialRequests = [...this.requests.values()].filter((item) => item.trial === trial);
    check(trialRequests.length < P1_LIMITS.requestsPerTrial, "BUDGET_REQUEST_LIMIT");
    const trialCost = trialRequests.reduce((sum, item) => sum + (item.actualMicros ?? item.maxMicros), 0);
    check(state.committedMicros + maxMicros <= P1_LIMITS.totalMicros, "BUDGET_TOTAL_LIMIT");
    check(trialCost + maxMicros <= P1_LIMITS.trialMicros, "BUDGET_TRIAL_LIMIT");
  }

  reserve(trial: string, maxMicros: number): string {
    this.checkReservation(trial, maxMicros);
    const id = randomUUID();
    this.append({ type: "reserve", id, trial, maxMicros });
    this.requests.set(id, { trial, maxMicros });
    return id;
  }

  settle(id: string, actualMicros: number): void {
    check(!this.closed && !this.poisoned, "BUDGET_CLOSED");
    const request = this.requests.get(id);
    check(request && request.actualMicros === undefined && !request.unknownAccounted && natural(actualMicros), "BUDGET_INVALID_SETTLEMENT");
    // An estimate overrun is recorded truthfully, and blocks all further requests.
    this.append({ type: "settle", id, actualMicros });
    request.actualMicros = actualMicros;
  }

  // Explicit supervisor reconciliation only: permanently charge the full validated upper
  // reservation to both budgets. Usage stays unknown; this is not a claim of zero cost or a bill.
  accountUnknown(id: string): void {
    check(!this.closed && !this.poisoned, "BUDGET_CLOSED");
    const request = this.requests.get(id);
    check(request && request.actualMicros === undefined && !request.unknownAccounted, "BUDGET_INVALID_RECONCILIATION");
    this.append({ type: "account-unknown", id });
    request.unknownAccounted = true;
  }

  private append(entry: Entry): void {
    const fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND);
    try {
      appendFileSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd); // Reservation must be durable before the caller sends any HTTP request.
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally { closeSync(fd); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.lockFd);
    unlinkSync(`${this.file}.lock`);
  }
}
