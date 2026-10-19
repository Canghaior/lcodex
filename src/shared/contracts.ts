export type TaskMode = "read" | "write";
export type ExecutionState = "idle" | "running" | "waiting" | "stopping" | "stopped" | "failed" | "reconcile" | "ended";
export type VerificationState = "passed" | "failed" | "unverified" | "not-applicable";
export type Project = { id: string; name: string; path: string; files: string[]; excluded: number; testCommand?: string };
export type Message = { id: string; role: "user" | "assistant"; text: string };
export type ToolRecord = { id: string; title: string; status: "running" | "completed" | "failed"; output: string; exitCode: number | null };
export type Change = { relative: string; kind: "add" | "modify" | "delete"; before: string; after: string; status: "pending" | "applied" | "conflict" | "refused" | "needs-reconcile" };
export type Chat = { id: string; projectId: string; title: string; mode: TaskMode; execution: ExecutionState; verification: VerificationState; messages: Message[]; tools: ToolRecord[]; changes: Change[]; error: string | null; reviewId: string | null; baselineExit?: number; verificationCommand?: string };
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
  | { type: "set-key"; key: string }
  | { type: "delete-key" }
  | { type: "check-connection" }
  | { type: "set-test-command"; projectId: string; command: string }
  | { type: "send"; chatId: string; text: string }
  | { type: "stop"; chatId: string }
  | { type: "reopen-review"; chatId: string }
  | { type: "delete-chat"; chatId: string }
  | { type: "apply"; chatId: string; reviewId: string; files: string[] }
  | { type: "discard"; chatId: string; reviewId: string }
  | { type: "window"; action: "minimize" | "maximize" | "close" };
export type Reply = { ok: true; state: AppState; file?: FilePreview; connectionVerified?: boolean } | { ok: false; code: string };
export type DesktopAPI = { request: (command: Command) => Promise<Reply>; subscribe: (listener: (state: AppState) => void) => () => void };

const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
export function validCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const exact = (...keys: string[]) => Object.keys(data).length === keys.length && keys.every(key => key in data);
  switch (data.type) {
    case "snapshot": case "choose-project": case "delete-key": case "check-connection": return exact("type");
    case "set-key": return exact("type", "key") && typeof data.key === "string" && /^sk-[A-Za-z0-9_-]{16,200}$/.test(data.key);
    case "set-test-command": return exact("type", "projectId", "command") && id(data.projectId) && typeof data.command === "string" && data.command.length <= 2048 && !data.command.includes("\0");
    case "send": return exact("type", "chatId", "text") && id(data.chatId) && typeof data.text === "string" && data.text.trim().length > 0 && data.text.length <= 8000 && !data.text.includes("\0");
    case "stop": case "reopen-review": case "delete-chat": return exact("type", "chatId") && id(data.chatId);
    case "apply": return exact("type", "chatId", "reviewId", "files") && id(data.chatId) && typeof data.reviewId === "string" && /^[a-f0-9]{64}$/.test(data.reviewId) && Array.isArray(data.files) && data.files.length > 0 && data.files.length <= 1024 && data.files.every(file => typeof file === "string" && file.length < 512);
    case "discard": return exact("type", "chatId", "reviewId") && id(data.chatId) && typeof data.reviewId === "string" && /^[a-f0-9]{64}$/.test(data.reviewId);
    case "new-chat": return exact("type", "projectId") && id(data.projectId);
    case "select-chat": return exact("type", "chatId") && id(data.chatId);
    case "set-mode": return exact("type", "chatId", "mode") && id(data.chatId) && (data.mode === "read" || data.mode === "write");
    case "open-file": return exact("type", "projectId", "relative") && id(data.projectId) && typeof data.relative === "string" && data.relative.length > 0 && data.relative.length < 512 && !/[\x00-\x1f]/.test(data.relative);
    case "window": return exact("type", "action") && ["minimize", "maximize", "close"].includes(String(data.action));
    default: return false;
  }
}
