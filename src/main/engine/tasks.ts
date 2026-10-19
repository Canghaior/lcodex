import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BudgetLedger } from "../../../validation/budget.js";
import { prepareReviewWorkspace, type Review } from "../../../validation/review-workspace.js";
import { contentHash, WindowsFileGuard } from "../../../validation/windows-file-guard.js";
import { isObject } from "../../../validation/rpc.js";
import { assertNoKnownSecrets } from "../../../validation/outbound-data.js";
import type { Chat, Project } from "../../shared/contracts.js";
import type { AppStore } from "../storage/store.js";
import type { Credentials } from "../storage/credentials.js";
import { executeSession, safeCode } from "./session.js";
import { PRICE_REVIEW_DATE, sendBoundedDeepSeek } from "../../../validation/deepseek-request.js";

type Workspace = Awaited<ReturnType<typeof prepareReviewWorkspace>>;
type ReviewEntry = { task: Workspace; review: Review; applying: boolean };
type Options = { engine: string; shell: string; node: string; root: string; ledgerFile: string; guard: WindowsFileGuard; credentials: Credentials; store: AppStore; notify: () => void };
export class Tasks {
  private active: { chatId: string; abort: AbortController; done: Promise<void> } | undefined;
  private reviews = new Map<string, ReviewEntry>();
  private ledger: BudgetLedger | undefined;
  private connectionAbort: AbortController | undefined;
  private lastBudget = { committed: 0, unknown: 0, limit: 10 };
  budgetError: string | null = null;
  constructor(private readonly options: Options) {
    try { const ledger = new BudgetLedger(options.ledgerFile); try { this.recordBudget(ledger); } finally { ledger.close(); } }
    catch (error) { this.budgetError = safeCode(error, "BUDGET_UNAVAILABLE"); }
  }
  private recordBudget(ledger: BudgetLedger) { const info = ledger.summary(); this.lastBudget = { committed: info.committedMicros / 1_000_000, unknown: (info.committedMicros - info.estimatedMicros) / 1_000_000, limit: 10 }; }
  budget() { if (this.ledger) this.recordBudget(this.ledger); return this.lastBudget; }
  busy() { return !!this.active || !!this.connectionAbort || [...this.reviews.values()].some(review => review.applying); }
  async checkConnection() {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (today !== PRICE_REVIEW_DATE) throw new Error("PRICE_REVIEW_REQUIRED");
    this.connectionAbort = new AbortController();
    let key = "";
    try {
      key = await this.options.credentials.read();
      this.ledger = new BudgetLedger(this.options.ledgerFile);
      const result = await sendBoundedDeepSeek(this.ledger, `connect-${randomUUID()}`, key, { model: "deepseek-flash", stream: true, store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with CONNECTION_OK." }] }], tools: [], tool_choice: "none", max_output_tokens: 32, reasoning: { effort: "none" } }, fetch, this.connectionAbort.signal);
      if (result.response.status !== "completed") throw new Error("API_CONNECTION_INCOMPLETE");
      this.budgetError = null;
    } finally {
      if (this.ledger) { this.recordBudget(this.ledger); this.ledger.close(); this.ledger = undefined; }
      key = ""; this.connectionAbort = undefined; this.options.notify();
    }
  }
  private publish(save = true) { if (save) this.options.store.save(); this.options.notify(); }
  async start(chat: Chat, project: Project, prompt: string) {
    if (this.busy()) throw new Error("TASK_ALREADY_RUNNING");
    if (chat.execution !== "idle") throw new Error("TASK_NEW_CHAT_REQUIRED");
    const key = await this.options.credentials.read();
    // The async credential lookup must not let two concurrent UI requests start.
    if (this.busy() || chat.execution !== "idle") throw new Error("TASK_ALREADY_RUNNING");
    assertNoKnownSecrets(prompt, [key]);
    this.ledger = new BudgetLedger(this.options.ledgerFile); this.budgetError = null;
    const abort = new AbortController();
    chat.messages.push({ id: randomUUID(), role: "user", text: prompt });
    chat.title = prompt.trim().replace(/\s+/g, " ").slice(0, 28); chat.execution = "running"; chat.error = null;
    const entry = { chatId: chat.id, abort, done: Promise.resolve() };
    this.active = entry;
    try { this.publish(); entry.done = this.run(chat, project, prompt, key, abort).finally(() => { this.active = undefined; this.publish(); }); }
    catch (error) { this.active = undefined; this.ledger.close(); this.ledger = undefined; throw error; }
    // Errors are rendered as state; never leave a rejected detached promise.
    void entry.done.catch(() => { chat.execution = "reconcile"; chat.error = "STORAGE_RECONCILE_REQUIRED"; this.options.notify(); });
  }
  private async run(chat: Chat, project: Project, prompt: string, key: string, abort: AbortController) {
    let task: Workspace | undefined;
    let processKnownEnded = true;
    let finalExecution: Chat["execution"] = "failed";
    const plannedCommands = new Map<string, string>();
    const root = path.join(this.options.root, "tasks", chat.id), state = path.join(this.options.root, "reviews");
    const sanitize = (text: string) => text.replaceAll(key, "[已隐藏凭据]").slice(0, 65_536);
    try {
      mkdirSync(root, { recursive: true }); mkdirSync(state, { recursive: true });
      task = await prepareReviewWorkspace(project.path, state, this.options.guard);
      const prepared = task;
      if (chat.mode === "write") {
        const captured = JSON.parse(readFileSync(path.join(task.taskDirectory, "private/baseline.json"), "utf8"));
        const manifest = captured.files.find((file: { relative: string }) => file.relative === "package.json");
        if (!manifest || JSON.parse(Buffer.from(manifest.base64, "base64").toString("utf8")).workspaces) throw new Error("PROJECT_SCOPE_UNSUPPORTED");
      }
      writeFileSync(path.join(root, "task.json"), JSON.stringify({ chatId: chat.id, projectId: project.id, taskDirectory: task.taskDirectory, mode: chat.mode, state: "prepared" }), { flag: "wx" });
      if (abort.signal.aborted) throw new Error("TASK_USER_STOP");
      processKnownEnded = false;
      const result = await executeSession({ ...this.options, root, workspace: task.workspace, privateDir: path.join(task.taskDirectory, "private"), original: project.path,
        rootMarker: task.rootMarker, readOnlyAssets: task.readOnlyAssets, readOnlyDirectories: task.readOnlyDirectories, mode: chat.mode, prompt, testCommand: project.testCommand ?? "", key, ledger: this.ledger!, signal: abort.signal,
        onIdentity: (threadId, turnId) => writeFileSync(path.join(root, "identity.json"), JSON.stringify({ threadId, turnId }), { flag: "wx" }),
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
                  if (chat.tools.length === 1) chat.baselineExit = Number(item.exitCode);
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
        try { task.close(); } catch { finalExecution = "reconcile"; chat.error = "REVIEW_RECONCILE_REQUIRED"; }
      }
      if (this.ledger) { this.recordBudget(this.ledger); this.ledger.close(); this.ledger = undefined; }
      key = "";
      chat.execution = finalExecution;
    }
  }
  stop(chatId: string) {
    if (!this.active || this.active.chatId !== chatId) throw new Error("TASK_NOT_RUNNING");
    const chat = this.options.store.chats.find(chat => chat.id === chatId)!; chat.execution = "stopping";
    this.active.abort.abort(); this.publish();
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
