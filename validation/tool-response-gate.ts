import { isObject } from "./rpc.js";
import { BatchCall, prepareSerialResponse } from "./serial-response.js";
import { TaskLimits, TASK_LIMITS } from "./task-limits.js";

type Completion = { id: string; type: string; passed: boolean; exitCode: number | null };
type Pending = { call: BatchCall; kind: string; resolve: () => void; timer: NodeJS.Timeout };

// A gateway scheduling boundary, not a replacement for the engine's task state.
// A returned session/unknown exit code is not evidence that its process ended.
export class ToolResponseGate {
  private pending: Pending | undefined;
  private failure = "";
  private completed = new Map<string, Completion>();
  constructor(private readonly limits: TaskLimits, private readonly abort: AbortController,
    private readonly observer: { failure: (code: string) => void; completed: (result: Completion) => void; event?: (kind: string, id: string) => void }) {}

  private fail(code: string) {
    if (this.failure) return;
    this.failure = code;
    if (this.pending) clearTimeout(this.pending.timer);
    this.abort.abort(new Error(code)); this.observer.failure(code);
  }
  observe(method: string, params: unknown) {
    if (!["item/started", "item/completed"].includes(method) || !isObject(params) || !isObject(params.item)) return;
    const item = params.item;
    if (!["commandExecution", "fileChange"].includes(String(item.type))) return;
    if (this.abort.signal.aborted) return;
    const previous = typeof item.id === "string" ? this.completed.get(item.id) : undefined;
    if (previous && method === "item/completed") {
      const passed = item.type === "commandExecution" ? item.exitCode === 0 : item.status === "completed";
      if (previous.type !== item.type || previous.passed !== passed || previous.exitCode !== (item.exitCode ?? null)) this.fail("TASK_TOOL_EVENT_MISMATCH");
      return;
    }
    const pending = this.pending;
    if (!pending || item.id !== pending.call.callId || item.type !== pending.kind) { this.fail("TASK_TOOL_EVENT_MISMATCH"); return; }
    this.observer.event?.(method === "item/started" ? "started" : "completed", pending.call.callId);
    if (method !== "item/completed") return;
    if (item.type === "commandExecution" && !Number.isSafeInteger(item.exitCode)) { this.fail("TASK_TOOL_RESULT_UNKNOWN"); return; }
    if (item.type === "fileChange" && !["completed", "failed", "declined"].includes(String(item.status))) { this.fail("TASK_TOOL_RESULT_UNKNOWN"); return; }
    const result: Completion = { id: pending.call.callId, type: pending.kind,
      passed: pending.kind === "commandExecution" ? item.exitCode === 0 : item.status === "completed", exitCode: typeof item.exitCode === "number" ? item.exitCode : null };
    try { this.limits.result(result.id, result.passed); }
    catch { this.fail("TASK_RESULT_REFUSED"); return; }
    clearTimeout(pending.timer); this.pending = undefined;
    this.completed.set(result.id, result); this.observer.completed(result); pending.resolve();
  }
  async deliver(batch: ReturnType<typeof prepareSerialResponse>, write: (bytes: string) => void | Promise<void>) {
    if (this.failure) throw new Error(this.failure);
    if (batch.calls.length) this.limits.planBatch(batch.calls.map(call => call.callId));
    let completion: Promise<void>;
    await batch.deliver({ signal: this.abort.signal, write,
      beforeTool: call => {
        if (this.pending) throw new Error("TASK_TOOL_SEQUENCE_REFUSED");
        this.limits.tool(call.callId);
        completion = new Promise(resolve => {
          const timer = setTimeout(() => this.fail("TASK_COMMAND_LIMIT"), TASK_LIMITS.commandMs);
          this.pending = { call, kind: call.type === "function_call" ? "commandExecution" : "fileChange", resolve, timer };
        });
      }, afterTool: async () => { await completion; } });
  }
  close() { if (this.pending) clearTimeout(this.pending.timer); }
}
