import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppState, Chat, Project } from "../../shared/contracts.js";
import { writePrivate } from "../../../validation/private-files.js";

type Stored = { version: 1; projects: Project[]; chats: Chat[]; activeChatId: string | null };
export class AppStore {
  private value: Stored = { version: 1, projects: [], chats: [], activeChatId: null };
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("STORAGE_UNSAFE");
    const file = path.join(directory, "workspace.json");
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 8 * 1024 * 1024) throw new Error("STORAGE_UNSAFE");
      const data = JSON.parse(readFileSync(file, "utf8")) as Stored;
      if (data.version !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.chats)) throw new Error("STORAGE_INVALID");
      this.value = data;
      for (const chat of data.chats) {
        if (["running", "waiting", "stopping"].includes(chat.execution)) { chat.execution = "reconcile"; chat.error = "TASK_RECONCILE_REQUIRED"; }
        else if (chat.changes.some(change => change.status === "pending")) { chat.execution = "reconcile"; chat.error = "REVIEW_REOPEN_REQUIRED"; }
      }
    }
  }
  get projects() { return this.value.projects; }
  get chats() { return this.value.chats; }
  get activeChatId() { return this.value.activeChatId; }
  set activeChatId(value: string | null) { this.value.activeChatId = value; }
  save() {
    writePrivate(this.directory, "workspace.json", JSON.stringify(this.value));
  }
  state(extra: Omit<AppState, keyof Stored | "version">): AppState {
    return structuredClone({ projects: this.projects, chats: this.chats, activeChatId: this.activeChatId, version: "0.1.0-dev", ...extra });
  }
}
