export type TaskMode = "read" | "write";
export type ExecutionState = "idle" | "running" | "waiting" | "stopping" | "stopped" | "failed" | "reconcile" | "ended";
export type VerificationState = "passed" | "failed" | "unverified" | "not-applicable";
export type Project = { id: string; name: string; path: string; files: string[]; excluded: number };
export type Message = { id: string; role: "user" | "assistant"; text: string };
export type ToolRecord = { id: string; title: string; status: "running" | "completed" | "failed"; output: string; exitCode: number | null };
export type Change = { relative: string; kind: "add" | "modify" | "delete"; before: string; after: string; status: "pending" | "applied" | "conflict" | "refused" | "needs-reconcile" };
export type Chat = { id: string; projectId: string; title: string; mode: TaskMode; execution: ExecutionState; verification: VerificationState; messages: Message[]; tools: ToolRecord[]; changes: Change[]; error: string | null; reviewId: string | null };
export type RuntimeInfo = { engine: boolean; shell: boolean; node: boolean; key: boolean; ready: boolean; platform: string };
export type AppState = { projects: Project[]; chats: Chat[]; activeChatId: string | null; runtime: RuntimeInfo; budget: { committed: number; unknown: number; limit: number }; version: string; executionAvailable: boolean };
export type FilePreview = { relative: string; text: string };
export type Command =
  | { type: "snapshot" }
  | { type: "choose-project" }
  | { type: "new-chat"; projectId: string }
  | { type: "select-chat"; chatId: string }
  | { type: "set-mode"; chatId: string; mode: TaskMode }
  | { type: "open-file"; projectId: string; relative: string }
  | { type: "window"; action: "minimize" | "maximize" | "close" };
export type Reply = { ok: true; state: AppState; file?: FilePreview } | { ok: false; code: string };
export type DesktopAPI = { request: (command: Command) => Promise<Reply>; subscribe: (listener: (state: AppState) => void) => () => void };

const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
export function validCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const exact = (...keys: string[]) => Object.keys(data).length === keys.length && keys.every(key => key in data);
  switch (data.type) {
    case "snapshot": case "choose-project": return exact("type");
    case "new-chat": return exact("type", "projectId") && id(data.projectId);
    case "select-chat": return exact("type", "chatId") && id(data.chatId);
    case "set-mode": return exact("type", "chatId", "mode") && id(data.chatId) && (data.mode === "read" || data.mode === "write");
    case "open-file": return exact("type", "projectId", "relative") && id(data.projectId) && typeof data.relative === "string" && data.relative.length > 0 && data.relative.length < 512 && !/[\x00-\x1f]/.test(data.relative);
    case "window": return exact("type", "action") && ["minimize", "maximize", "close"].includes(String(data.action));
    default: return false;
  }
}
