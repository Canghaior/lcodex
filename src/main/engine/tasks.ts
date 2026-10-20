import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BudgetLedger, type BudgetScope } from "../../../validation/budget.js";
import { prepareReviewWorkspace, restoreReviewWorkspace, type Review } from "../../../validation/review-workspace.js";
import { contentHash, WindowsFileGuard } from "../../../validation/windows-file-guard.js";
import { isObject } from "../../../validation/rpc.js";
import { assertNoKnownSecrets } from "../../../validation/outbound-data.js";
import type { BudgetInfo, Chat, Project } from "../../shared/contracts.js";
import type { AppStore } from "../storage/store.js";
import type { Credentials } from "../storage/credentials.js";
import { executeSession, safeCode } from "./session.js";
import { sendBoundedDeepSeek } from "../../../validation/deepseek-request.js";
import { DESKTOP_MODEL } from "../../../validation/deepseek-model.js";
import { readPrivate, writePrivate } from "../../../validation/private-files.js";
import { verifyCompletedHistory } from "./history.js";
import { finishChatDeletion, performChatDeletion, prepareChatDeletion } from "../storage/deletion.js";
import { abandonStoppedIsolatedWorkspace, assertNeverApplied } from "../../../validation/abandon-isolated.js";
import type { Pricing } from "../storage/pricing.js";
import { recoverBudgetLock } from "../storage/budget-recovery.js";
import { assertProjectDataSeparation } from "../projects/projects.js";

type Workspace = Awaited<ReturnType<typeof prepareReviewWorkspace>>;
type ReviewEntry = { task: Workspace; review: Review; applying: boolean };
type Options = { engine: string; shell: string; node: string; root: string; ledgerFile: string; budgetScope: BudgetScope; pricing: Pricing; guard: WindowsFileGuard; credentials: Credentials; store: AppStore; notify: () => void };
export class Tasks {
  private active: { chatId: string; abort: AbortController; done: Promise<void> } | undefined;
  private reviews = new Map<string, ReviewEntry>();
  private unapplied = new Map<string, Workspace>();
  private ledger: BudgetLedger | undefined;
  private connectionAbort: AbortController | undefined;
  private reconciling = false;
  private lastBudget: BudgetInfo;
  budgetError: string | null = null;
  constructor(private readonly options: Options) {
    this.lastBudget = { committed: 0, unknown: 0, estimated: 0, limit: 10, perTask: 1, pending: 0, pendingCost: 0, revision: "", configured: false, scope: options.budgetScope, error: null };
    this.refreshBudget();
  }
  private openLedger() { return new BudgetLedger(this.options.ledgerFile, this.options.budgetScope); }
  private openForRequest() {
    const ledger = this.openLedger();
    try {
      const info = ledger.summary();
      if (info.pending) throw new Error("BUDGET_PENDING_RECONCILIATION");
      if (info.overrun) throw new Error("BUDGET_ESTIMATE_OVERRUN");
      if (info.committedMicros + 250_000 > ledger.limits().totalMicros) throw new Error("BUDGET_TOTAL_LIMIT");
      return ledger;
    } catch (error) { this.recordBudget(ledger); ledger.close(); throw error; }
  }
  private refreshBudget() { try { const ledger = this.openLedger(); try { this.recordBudget(ledger); this.budgetError = null; } finally { ledger.close(); } } catch (error) { this.budgetError = safeCode(error, "BUDGET_UNAVAILABLE"); } }
  private recordBudget(ledger: BudgetLedger) {
    const info = ledger.summary(), limits = ledger.limits(), pending = ledger.pendingRequests();
    this.lastBudget = { committed: info.committedMicros / 1_000_000, unknown: info.unknownMicros / 1_000_000, estimated: info.estimatedMicros / 1_000_000,
      limit: limits.totalMicros / 1_000_000, perTask: limits.trialMicros / 1_000_000, pending: pending.length, pendingCost: pending.reduce((sum, request) => sum + request.maxMicros, 0) / 1_000_000,
      revision: contentHash(JSON.stringify(pending)), configured: true, scope: this.options.budgetScope, error: null };
  }
  budget() { if (this.ledger) this.recordBudget(this.ledger); return { ...this.lastBudget, error: this.budgetError }; }
  configureBudget(totalMicros: number, trialMicros: number) {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    if (this.options.budgetScope !== "personal") throw new Error("BUDGET_CONFIGURATION_REFUSED");
    const limits = { totalMicros, trialMicros, requestsPerTrial: 8 };
    if (!existsSync(this.options.ledgerFile)) BudgetLedger.initialize(this.options.ledgerFile, limits, "personal");
    else { const ledger = this.openLedger(); try { ledger.configure(limits); } finally { ledger.close(); } }
    this.refreshBudget(); this.options.notify();
  }
  accountUnknown(revision: string) {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    const ledger = this.openLedger();
    try {
      const pending = ledger.pendingRequests();
      if (!pending.length || contentHash(JSON.stringify(pending)) !== revision) throw new Error("BUDGET_RECONCILIATION_CHANGED");
      for (const request of pending) ledger.accountUnknown(request.id);
      this.recordBudget(ledger); this.budgetError = null;
    } finally { ledger.close(); this.options.notify(); }
  }
  async recoverBudget() {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    this.reconciling = true;
    try { await recoverBudgetLock(this.options.ledgerFile, this.options.guard); this.refreshBudget(); this.options.notify(); }
    finally { this.reconciling = false; }
  }
  busy() { return !!this.active || !!this.connectionAbort || this.reconciling || [...this.reviews.values()].some(review => review.applying); }
  async checkConnection() {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    this.options.pricing.requireCurrent();
    this.connectionAbort = new AbortController();
    let key = "";
    try {
      key = await this.options.credentials.read();
      this.ledger = this.openForRequest();
      const result = await sendBoundedDeepSeek(this.ledger, `connect-${randomUUID()}`, key, { model: DESKTOP_MODEL.id, stream: true, store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with CONNECTION_OK." }] }], tools: [], tool_choice: "none", max_output_tokens: DESKTOP_MODEL.maxOutputTokens, reasoning: { effort: DESKTOP_MODEL.effort } }, fetch, this.connectionAbort.signal);
      if (result.response.status !== "completed") throw new Error("API_CONNECTION_INCOMPLETE");
      this.budgetError = null;
    } finally {
      if (this.ledger) { this.recordBudget(this.ledger); this.ledger.close(); this.ledger = undefined; }
      key = ""; this.connectionAbort = undefined; this.options.notify();
    }
  }
  private publish(save = true) { if (save) this.options.store.save(); this.options.notify(); }
  async start(chat: Chat, project: Project, prompt: string) {
    assertProjectDataSeparation(project.path, this.options.root);
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    this.options.pricing.requireCurrent();
    const canStart = () => ["idle", "ended"].includes(chat.execution) && !chat.changes.some(change => change.status === "pending" || change.status === "needs-reconcile") && !this.reviews.has(chat.id);
    if (!canStart()) throw new Error("TASK_REVIEW_OR_RECONCILE_REQUIRED");
    if (this.options.store.chats.some(other => other.id !== chat.id && other.projectId === project.id && (other.execution === "reconcile" || other.changes.some(change => change.status === "pending")))) throw new Error("PROJECT_LOCK_BUSY_RECONCILE_REQUIRED");
    const key = await this.options.credentials.read();
    // The async credential lookup must not let two concurrent UI requests start.
    if (this.busy() || !canStart()) throw new Error("TASK_ALREADY_RUNNING");
    assertNoKnownSecrets(prompt, [key]);
    let resume: { threadId: string; turnId: string } | undefined;
    if (chat.execution === "ended") {
      const previous = JSON.parse(readPrivate(this.options.root, `tasks/${chat.id}/outcome.json`));
      if (previous.status !== "completed" || previous.cleanExit !== true || typeof previous.threadId !== "string" || typeof previous.turnId !== "string") throw new Error("ENGINE_HISTORY_MISMATCH");
      resume = { threadId: previous.threadId, turnId: previous.turnId };
    }
    this.ledger = this.openForRequest(); this.budgetError = null;
    const abort = new AbortController();
    chat.messages.push({ id: randomUUID(), role: "user", text: prompt });
    if (!resume) chat.title = prompt.trim().replace(/\s+/g, " ").slice(0, 28);
    chat.execution = "running"; chat.error = null; chat.verification = "unverified"; chat.changes = []; chat.reviewId = null;
    delete chat.baselineExit; delete chat.verificationCommand;
    const entry = { chatId: chat.id, abort, done: Promise.resolve() };
    this.active = entry;
    try { this.publish(); entry.done = this.run(chat, project, prompt, key, abort, resume).finally(() => { this.active = undefined; this.publish(); }); }
    catch (error) { this.active = undefined; this.ledger.close(); this.ledger = undefined; throw error; }
    // Errors are rendered as state; never leave a rejected detached promise.
    void entry.done.catch(() => { chat.execution = "reconcile"; chat.error = "STORAGE_RECONCILE_REQUIRED"; this.options.notify(); });
  }
  private async run(chat: Chat, project: Project, prompt: string, key: string, abort: AbortController, resume?: { threadId: string; turnId: string }) {
    let task: Workspace | undefined;
    let processKnownEnded = true;
    let finalExecution: Chat["execution"] = "failed";
    const plannedCommands = new Map<string, string>();
    const chatRoot = path.join(this.options.root, "tasks", chat.id), root = path.join(chatRoot, "turns", randomUUID()), state = path.join(this.options.root, "reviews");
    const sanitize = (text: string) => text.replaceAll(key, "[已隐藏凭据]").slice(0, 65_536);
    try {
      mkdirSync(root, { recursive: true }); mkdirSync(state, { recursive: true });
      task = await prepareReviewWorkspace(project.path, state, this.options.guard);
      const prepared = task;
      const taskRecord = JSON.stringify({ chatId: chat.id, projectId: project.id, taskDirectory: task.taskDirectory, runRoot: root, previousTurnId: resume?.turnId ?? null, mode: chat.mode, state: "prepared" });
      writeFileSync(path.join(root, "task.json"), taskRecord, { flag: "wx" }); writePrivate(chatRoot, "task.json", taskRecord);
      if (chat.mode === "write") {
        const captured = JSON.parse(readFileSync(path.join(task.taskDirectory, "private/baseline.json"), "utf8"));
        const manifest = captured.files.find((file: { relative: string }) => file.relative === "package.json");
        if (!manifest || JSON.parse(Buffer.from(manifest.base64, "base64").toString("utf8")).workspaces) throw new Error("PROJECT_SCOPE_UNSUPPORTED");
      }
      if (abort.signal.aborted) throw new Error("TASK_USER_STOP");
      const result = await executeSession({ ...this.options, priceConfirmedOn: this.options.pricing.requireCurrent(), root, historyHome: path.join(chatRoot, "home"), ...(resume ? { resume } : {}), workspace: task.workspace, privateDir: path.join(task.taskDirectory, "private"), original: project.path,
        rootMarker: task.rootMarker, readOnlyAssets: task.readOnlyAssets, readOnlyDirectories: task.readOnlyDirectories, mode: chat.mode, prompt, testCommand: project.testCommand ?? "", key, ledger: this.ledger!, signal: abort.signal,
        onProcessStarted: () => { processKnownEnded = false; },
        onIdentity: (threadId, turnId) => { const bytes = JSON.stringify({ threadId, turnId }); writeFileSync(path.join(root, "identity.json"), bytes, { flag: "wx" }); writePrivate(chatRoot, "identity.json", bytes); },
        onEvent: (method, params) => {
          if (!isObject(params)) return;
          if (method === "boundary/toolPlan" && typeof params.id === "string" && typeof params.command === "string") { plannedCommands.set(params.id, params.command); return; }
          if (["item/started", "item/completed"].includes(method) && isObject(params.item)) {
            const item = params.item;
            if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") {
              const existing = chat.messages.find(message => message.id === item.id);
              if (existing) existing.text = sanitize(item.text); else chat.messages.push({ id: item.id, role: "assistant", text: sanitize(item.text) });
            }
            if (["commandExecution", "fileChange"].includes(String(item.type)) && typeof item.id === "string") {
              if (method === "item/started") chat.verification = "unverified";
              let tool = chat.tools.find(tool => tool.id === item.id);
              if (!tool) { tool = { id: item.id, title: sanitize(plannedCommands.get(item.id) ?? (typeof item.command === "string" ? item.command : "修改文件")), status: "running", output: "", exitCode: null }; chat.tools.push(tool); }
              if (typeof item.aggregatedOutput === "string") tool.output = sanitize(item.aggregatedOutput);
              if (method === "item/completed") {
                tool.exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
                tool.status = item.status === "completed" && (item.type === "fileChange" || item.exitCode === 0) ? "completed" : "failed";
                if (project.testCommand && plannedCommands.get(item.id) === project.testCommand && Number.isInteger(item.exitCode)) {
                  // Reading the project before testing must not hide the first
                  // real verification result. This is the first matching check,
                  // not proof that no earlier shell command changed files.
                  if (chat.baselineExit === undefined) chat.baselineExit = Number(item.exitCode);
                  chat.verificationCommand = project.testCommand;
                  chat.verification = item.exitCode === 0 ? "passed" : "failed";
                }
              }
            }
          } else if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
            let message = chat.messages.find(message => message.id === params.itemId);
            if (!message) { message = { id: params.itemId, role: "assistant", text: "" }; chat.messages.push(message); }
            message.text = sanitize(message.text + params.delta);
          } else if (method === "item/commandExecution/outputDelta" && typeof params.itemId === "string" && typeof params.delta === "string") {
            const tool = chat.tools.find(tool => tool.id === params.itemId); if (tool) tool.output = sanitize(tool.output + params.delta);
          }
          this.publish(false);
        },
      });
      processKnownEnded = result.cleanExit;
      writeFileSync(path.join(root, "outcome.json"), JSON.stringify(result), { flag: "wx" });
      writePrivate(chatRoot, "outcome.json", JSON.stringify(result));
      chat.error = result.code;
      finalExecution = result.status === "completed" ? "ended" : result.status === "reconcile" ? "reconcile" : result.status;
      if (result.status !== "completed") return;
      const review = await prepared.seal();
      if (chat.mode === "read" && review.changes.length) throw new Error("TASK_READ_ONLY_VIOLATION");
      if (review.changes.length) {
        const baseline = JSON.parse(readFileSync(path.join(prepared.taskDirectory, "private/baseline.json"), "utf8"));
        const frozen = JSON.parse(readFileSync(path.join(prepared.taskDirectory, "private/frozen.json"), "utf8"));
        const content = (files: { relative: string; base64: string }[], relative: string, hash: string | null) => {
          if (hash === null) return "";
          const file = files.find(file => file.relative === relative); if (!file) throw new Error("REVIEW_CONTENT_MISSING");
          const bytes = Buffer.from(file.base64, "base64"); if (contentHash(bytes) !== hash) throw new Error("REVIEW_CONTENT_CHANGED");
          return bytes.toString("utf8");
        };
        chat.changes = review.changes.map(change => ({ relative: change.relative, kind: change.kind, before: content(baseline.files, change.relative, change.before), after: content(frozen.files, change.relative, change.after), status: "pending" }));
        chat.reviewId = review.id; this.reviews.set(chat.id, { task: prepared, review, applying: false });
      } else { prepared.close(); task = undefined; }
    } catch (error) {
      chat.error = safeCode(error, "TASK_FAILED"); finalExecution = processKnownEnded ? abort.signal.aborted ? "stopped" : "failed" : "reconcile";
    } finally {
      // A normal, fully ended failure may release its lock; any unknown process or
      // operation deliberately retains the lock and its durable baseline.
      if (task && processKnownEnded && finalExecution !== "reconcile" && !this.reviews.has(chat.id)) {
        try {
          if (!existsSync(path.join(root, "outcome.json"))) {
            const stoppedBeforeLaunch = JSON.stringify({ status: "failed", code: chat.error, threadId: null, turnId: null, cleanExit: true, requests: 0, started: false });
            writePrivate(root, "outcome.json", stoppedBeforeLaunch); writePrivate(chatRoot, "outcome.json", stoppedBeforeLaunch);
          }
          task.close();
        } catch { finalExecution = "reconcile"; chat.error = "REVIEW_RECONCILE_REQUIRED"; }
      }
      if (task && processKnownEnded && finalExecution === "reconcile" && !this.reviews.has(chat.id)) this.unapplied.set(chat.id, task);
      if (this.ledger) { this.recordBudget(this.ledger); this.ledger.close(); this.ledger = undefined; }
      key = "";
      chat.execution = finalExecution;
    }
  }
  stop(chatId: string) {
    if (!this.active || this.active.chatId !== chatId) throw new Error("TASK_NOT_RUNNING");
    const chat = this.options.store.chat(chatId)!; chat.execution = "stopping";
    this.active.abort.abort(); this.publish();
  }
  suspendReviews() {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    for (const [chatId, entry] of this.reviews) {
      const chat = this.options.store.chat(chatId);
      if (!chat || chat.execution !== "ended") continue;
      entry.task.suspend(); this.reviews.delete(chatId);
    }
    this.options.store.save();
  }
  async reopenReview(chat: Chat, project: Project) {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    if (chat.execution !== "reconcile" || !chat.reviewId || this.reviews.has(chat.id)) throw new Error("REVIEW_UNAVAILABLE");
    this.reconciling = true;
    try {
      const chatRoot = path.join(this.options.root, "tasks", chat.id);
      const taskRecord = JSON.parse(readPrivate(chatRoot, "task.json")), outcome = JSON.parse(readPrivate(chatRoot, "outcome.json"));
      const identity = JSON.parse(readPrivate(chatRoot, "identity.json"));
      if (taskRecord.chatId !== chat.id || taskRecord.projectId !== project.id || outcome.status !== "completed" || outcome.cleanExit !== true ||
        typeof identity.threadId !== "string" || typeof identity.turnId !== "string" || identity.threadId !== outcome.threadId || identity.turnId !== outcome.turnId ||
        path.dirname(taskRecord.runRoot).toLowerCase() !== path.join(chatRoot, "turns").toLowerCase()) throw new Error("REVIEW_RECONCILE_REQUIRED");
      await verifyCompletedHistory(this.options.engine, taskRecord.runRoot, path.join(chatRoot, "home"), identity.threadId, identity.turnId);
      const task = restoreReviewWorkspace(project.path, path.join(this.options.root, "reviews"), taskRecord.taskDirectory, chat.reviewId, this.options.guard);
      this.reviews.set(chat.id, { task, review: task.review, applying: false });
      // The current workspace.json display is not authority for frozen bytes or
      // partial results. Reconstruct the visible review from verified evidence.
      const baseline = JSON.parse(readPrivate(task.taskDirectory, "private/baseline.json", 24 * 1024 * 1024));
      const frozen = JSON.parse(readPrivate(task.taskDirectory, "private/frozen.json", 24 * 1024 * 1024));
      const bytes = (files: { relative: string; base64: string }[], relative: string) => Buffer.from(files.find(file => file.relative === relative)?.base64 ?? "", "base64").toString("utf8");
      chat.changes = task.review.changes.map(change => ({ relative: change.relative, kind: change.kind, before: bytes(baseline.files, change.relative), after: bytes(frozen.files, change.relative),
        status: task.outcomes.find(outcome => outcome.relative === change.relative)?.status ?? "pending" }));
      chat.execution = "ended"; chat.error = null; this.publish();
    } finally { this.reconciling = false; }
  }
  async deleteChat(chat: Chat) {
    if (this.busy() || this.reviews.has(chat.id)) throw new Error("CHAT_DELETE_REFUSED");
    prepareChatDeletion(this.options.root, chat);
    this.reconciling = true;
    chat.execution = "reconcile"; chat.error = "CHAT_DELETE_INCOMPLETE";
    try {
      this.publish();
      await performChatDeletion(this.options.root, chat.id);
      this.options.store.forget(chat.id); finishChatDeletion(this.options.root, chat.id);
      this.options.notify();
    } finally { this.reconciling = false; }
  }
  async abandonIsolated(chat: Chat, project: Project) {
    if (this.busy() || this.reviews.has(chat.id) || chat.execution !== "reconcile" || chat.reviewId || chat.changes.length) throw new Error("TASK_ABANDON_RECONCILE_REQUIRED");
    this.reconciling = true;
    try {
      const chatRoot = path.join(this.options.root, "tasks", chat.id);
      const task = JSON.parse(readPrivate(chatRoot, "task.json")), outcome = JSON.parse(readPrivate(chatRoot, "outcome.json"));
      if (task.chatId !== chat.id || task.projectId !== project.id || outcome.cleanExit !== true ||
        typeof outcome.threadId !== "string" || !(typeof outcome.turnId === "string" || outcome.turnId === null && outcome.requests === 0) ||
        path.dirname(task.runRoot).toLowerCase() !== path.join(chatRoot, "turns").toLowerCase()) throw new Error("TASK_ABANDON_RECONCILE_REQUIRED");
      if (outcome.turnId !== null) {
        const identity = JSON.parse(readPrivate(task.runRoot, "identity.json"));
        if (identity.threadId !== outcome.threadId || identity.turnId !== outcome.turnId) throw new Error("TASK_ABANDON_RECONCILE_REQUIRED");
      }
      const taskId = path.basename(task.taskDirectory);
      if (!/^[a-f0-9-]{36}$/.test(taskId) || path.resolve(task.taskDirectory).toLowerCase() !== path.join(this.options.root, "reviews", taskId).toLowerCase()) throw new Error("REVIEW_STORAGE_INVALID");
      const evidence = assertNeverApplied(task.taskDirectory);
      const expectedTurn = outcome.turnId ?? (typeof task.previousTurnId === "string" ? task.previousTurnId : null);
      const terminal = await verifyCompletedHistory(this.options.engine, task.runRoot, path.join(chatRoot, "home"), outcome.threadId, expectedTurn, true);
      writePrivate(task.runRoot, "abandoned.json", JSON.stringify({ taskId, threadId: outcome.threadId, turnId: outcome.turnId, terminal, reason: "explicit-user-abandonment" }));
      const held = this.unapplied.get(chat.id);
      if (held) {
        const baseline = JSON.parse(readPrivate(task.taskDirectory, "private/baseline.json", 24 * 1024 * 1024));
        writePrivate(task.taskDirectory, "private/abandoned.json", JSON.stringify({ taskId, projectId: baseline.projectId, journalHash: contentHash(evidence.journal), reason: "explicit-user-abandonment" }));
        held.close(); this.unapplied.delete(chat.id);
      } else await abandonStoppedIsolatedWorkspace(project.path, path.join(this.options.root, "reviews"), task.taskDirectory, this.options.guard);
      chat.execution = "stopped"; chat.verification = "unverified"; chat.error = "TASK_ISOLATED_ABANDONED"; this.publish();
    } finally { this.reconciling = false; }
  }
  async stopAll() {
    this.connectionAbort?.abort();
    if (this.active) { this.stop(this.active.chatId); await this.active?.done; }
    const deadline = Date.now() + 30_000;
    while (this.busy() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 50));
    if (this.busy()) throw new Error("REVIEW_APPLICATION_RUNNING");
  }
  async apply(chat: Chat, reviewId: string, files: string[]) {
    const entry = this.reviews.get(chat.id);
    if (!entry || entry.applying || chat.execution !== "ended" || entry.review.id !== reviewId) throw new Error("REVIEW_UNAVAILABLE");
    entry.applying = true;
    try {
      const results = await entry.task.apply(reviewId, files);
      for (const result of results) { const change = chat.changes.find(change => change.relative === result.relative)!; change.status = result.status; }
      if (results.some(result => result.status === "needs-reconcile")) { chat.execution = "reconcile"; chat.error = "REVIEW_RECONCILE_REQUIRED"; }
      else if (chat.changes.every(change => change.status !== "pending")) { entry.task.close(); this.reviews.delete(chat.id); }
      this.publish();
    } finally { entry.applying = false; }
  }
  discard(chat: Chat, reviewId: string) {
    const entry = this.reviews.get(chat.id);
    if (!entry || entry.applying || chat.execution !== "ended" || entry.review.id !== reviewId) throw new Error("REVIEW_UNAVAILABLE");
    entry.task.close(); this.reviews.delete(chat.id);
    for (const change of chat.changes) if (change.status === "pending") change.status = "refused";
    this.publish();
  }
}
