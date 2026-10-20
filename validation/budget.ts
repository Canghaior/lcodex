import { appendFileSync, closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { privatePath, readPrivate } from "./private-files.js";

// Integer micro-yuan avoids floating-point accumulation. These limits are user-authorized.
export const P1_LIMITS = { totalMicros: 10_000_000, trialMicros: 1_000_000, requestsPerTrial: 8 } as const;
export type BudgetLimits = { totalMicros: number; trialMicros: number; requestsPerTrial: number };
export type BudgetScope = "development" | "personal";
type Entry =
  | { type: "init"; version: 1 | 2; limits: BudgetLimits; scope?: BudgetScope }
  | { type: "limits"; limits: BudgetLimits }
  | { type: "authorize-trial"; trial: string; limitMicros: number; decision: string }
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
  private lockContents: string;
  private closed = false;
  private poisoned = false;
  private requests = new Map<string, Request>();
  private trialAuthorizations = new Map<string, { limitMicros: number; decision: string }>();
  private currentLimits: BudgetLimits = { ...P1_LIMITS };

  static validLimits(limits: BudgetLimits): boolean {
    return natural(limits.totalMicros) && limits.totalMicros >= 250_000 && limits.totalMicros <= 1_000_000_000 &&
      natural(limits.trialMicros) && limits.trialMicros >= 250_000 && limits.trialMicros <= limits.totalMicros && limits.requestsPerTrial === 8;
  }

  // Explicit one-time initialization. Opening or retrying never creates a missing ledger.
  static initialize(file: string, limits: BudgetLimits = P1_LIMITS, scope: BudgetScope = "development"): void {
    check(BudgetLedger.validLimits(limits) && (scope === "personal" || JSON.stringify(limits) === JSON.stringify(P1_LIMITS)), "BUDGET_WRONG_LIMITS");
    privatePath(path.dirname(file), path.basename(file));
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(scope === "development" ? { type: "init", version: 1, limits } : { type: "init", version: 2, scope, limits })}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  constructor(private file: string, private scope: BudgetScope = "development") {
    check(existsSync(file), "BUDGET_LEDGER_MISSING");
    privatePath(path.dirname(file), path.basename(file));
    privatePath(path.dirname(file), path.basename(file) + ".lock");
    this.lockFd = openSync(`${file}.lock`, "wx", 0o600);
    this.lockContents = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() });
    try {
      writeFileSync(this.lockFd, this.lockContents); fsyncSync(this.lockFd);
      const contents = readPrivate(path.dirname(file), path.basename(file), 32 * 1024 * 1024);
      check(contents.endsWith("\n"), "BUDGET_CORRUPT");
      const lines = contents.trimEnd().split("\n");
      const init = JSON.parse(lines.shift() ?? "null") as Record<string, unknown> | null;
      check(init?.type === "init" && (scope === "development" ? init.version === 1 && JSON.stringify(init.limits) === JSON.stringify(P1_LIMITS) : init.version === 2 && init.scope === "personal"), "BUDGET_WRONG_LIMITS");
      check(init.limits && BudgetLedger.validLimits(init.limits as BudgetLimits), "BUDGET_WRONG_LIMITS");
      this.currentLimits = { ...(init.limits as BudgetLimits) };
      for (const line of lines) this.replay(JSON.parse(line));
    } catch {
      this.close();
      throw new Error("BUDGET_CORRUPT");
    }
  }

  private replay(entry: Entry): void {
    check(entry && typeof entry === "object" && typeof entry.type === "string", "BUDGET_CORRUPT");
    if (entry.type === "limits") {
      check(this.scope === "personal" && BudgetLedger.validLimits(entry.limits) && entry.limits.totalMicros >= this.summary().committedMicros, "BUDGET_WRONG_LIMITS");
      this.currentLimits = { ...entry.limits };
    } else if (entry.type === "authorize-trial") {
      this.checkTrialAuthorization(entry.trial, entry.limitMicros, entry.decision);
      this.trialAuthorizations.set(entry.trial, { limitMicros: entry.limitMicros, decision: entry.decision });
    } else if (entry.type === "reserve") {
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
  limits() { return { ...this.currentLimits }; }
  trialLimit(trial: string) { return this.trialAuthorizations.get(trial)?.limitMicros ?? this.currentLimits.trialMicros; }
  pendingRequests() { return [...this.requests.entries()].filter(([, request]) => request.actualMicros === undefined && !request.unknownAccounted).map(([id, request]) => ({ id, maxMicros: request.maxMicros })); }
  configure(limits: BudgetLimits) {
    check(!this.closed && !this.poisoned && this.scope === "personal", "BUDGET_CONFIGURATION_REFUSED");
    check(BudgetLedger.validLimits(limits) && limits.totalMicros >= this.summary().committedMicros, "BUDGET_WRONG_LIMITS");
    this.append({ type: "limits", limits }); this.currentLimits = { ...limits };
  }

  private checkTrialAuthorization(trial: string, limitMicros: number, decision: string) {
    check(!this.closed && !this.poisoned && this.scope === "development", "BUDGET_AUTHORIZATION_REFUSED");
    check(typeof trial === "string" && typeof decision === "string" &&
      /^[a-z0-9-]{1,64}$/.test(trial) && /^[a-z0-9-]{1,96}$/.test(decision) &&
      natural(limitMicros) && limitMicros > this.currentLimits.trialMicros &&
      limitMicros <= this.currentLimits.totalMicros, "BUDGET_AUTHORIZATION_INVALID");
    check(!this.trialAuthorizations.has(trial) && ![...this.trialAuthorizations.values()].some(item => item.decision === decision) &&
      ![...this.requests.values()].some(item => item.trial === trial), "BUDGET_AUTHORIZATION_REUSED");
    const state = this.summary();
    check(state.pending === 0 && !state.overrun, "BUDGET_PENDING_RECONCILIATION");
  }

  // Supervisor-only, after explicit user approval. Not exposed by desktop IPC
  // or model tools. A decision authorizes one new trial; neither global cost,
  // request counts, previous trial limits nor historical usage are reset.
  authorizeDevelopmentTrial(trial: string, limitMicros: number, decision: string) {
    this.checkTrialAuthorization(trial, limitMicros, decision);
    this.append({ type: "authorize-trial", trial, limitMicros, decision });
    this.trialAuthorizations.set(trial, { limitMicros, decision });
  }

  private checkReservation(trial: string, maxMicros: number): void {
    check(!this.closed && !this.poisoned, "BUDGET_CLOSED");
    check(/^[a-z0-9-]{1,64}$/.test(trial) && natural(maxMicros) && maxMicros > 0, "BUDGET_INVALID_RESERVATION");
    const state = this.summary();
    check(!state.overrun, "BUDGET_ESTIMATE_OVERRUN");
    check(state.pending === 0, "BUDGET_PENDING_RECONCILIATION");
    const trialRequests = [...this.requests.values()].filter((item) => item.trial === trial);
    check(trialRequests.length < this.currentLimits.requestsPerTrial, "BUDGET_REQUEST_LIMIT");
    const trialCost = trialRequests.reduce((sum, item) => sum + (item.actualMicros ?? item.maxMicros), 0);
    check(state.committedMicros + maxMicros <= this.currentLimits.totalMicros, "BUDGET_TOTAL_LIMIT");
    check(trialCost + maxMicros <= this.trialLimit(trial), "BUDGET_TRIAL_LIMIT");
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
    const fd = openSync(privatePath(path.dirname(this.file), path.basename(this.file)), constants.O_WRONLY | constants.O_APPEND);
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
    try {
      check(readPrivate(path.dirname(this.file), path.basename(this.file) + ".lock") === this.lockContents, "BUDGET_LOCK_OWNERSHIP_CHANGED");
      unlinkSync(`${this.file}.lock`);
    } finally { closeSync(this.lockFd); }
  }
}
