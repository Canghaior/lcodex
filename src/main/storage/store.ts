import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AppState, Chat, Project } from "../../shared/contracts.js";
import { privatePath, readPrivate, writePrivate } from "../../../validation/private-files.js";

type Stored = { version: 1 | 2; projects: Project[]; chats: Chat[]; activeChatId: string | null };
const idPattern = /^[a-f0-9-]{36}$/;
const summary = (chat: Chat): Chat => ({ ...chat, messages: [], tools: [], changes: chat.changes.map(change => ({ ...change, before: "", after: "" })) });
function validateChat(chat: Chat) {
  if (!chat || !idPattern.test(chat.id) || !idPattern.test(chat.projectId) || typeof chat.title !== "string" || !["read", "write"].includes(chat.mode) ||
    !["idle", "running", "waiting", "stopping", "stopped", "failed", "reconcile", "ended"].includes(chat.execution) ||
    !Array.isArray(chat.messages) || !Array.isArray(chat.tools) || !Array.isArray(chat.changes) || chat.changes.length > 1024) throw new Error("STORAGE_INVALID");
}
function recovered(chat: Chat) {
  if (["running", "waiting", "stopping"].includes(chat.execution)) { chat.execution = "reconcile"; chat.error = "TASK_RECONCILE_REQUIRED"; }
  else if (chat.changes.some(change => change.status === "pending")) { chat.execution = "reconcile"; chat.error = "REVIEW_REOPEN_REQUIRED"; }
}
export class AppStore {
  private value: Stored = { version: 2, projects: [], chats: [], activeChatId: null };
  private loaded = new Set<string>();
  private known = new Set<string>();
  private savedHashes = new Map<string, string>();
  private held = new Map<string, number>();
  private startupRecovery = new Set<string>();
  constructor(private readonly directory: string, private readonly appVersion = "development") {
    mkdirSync(directory, { recursive: true }); privatePath(directory, "workspace.json");
    mkdirSync(path.join(directory, "chats"), { recursive: true }); privatePath(directory, "chats/check.json");
    const file = path.join(directory, "workspace.json");
    if (!existsSync(file)) return;
    // Version 1 embedded all diff text in an 8 MiB file, smaller than one valid
    // project. Migrate only after writing individual, bounded chat records.
    const data = JSON.parse(readPrivate(directory, "workspace.json", 224 * 1024 * 1024)) as Stored;
    if (![1, 2].includes(data.version) || !Array.isArray(data.projects) || !Array.isArray(data.chats) || data.chats.length > 1000 ||
      data.projects.some(project => !idPattern.test(project.id) || typeof project.path !== "string" || !Array.isArray(project.files)) ||
      new Set(data.chats.map(chat => chat.id)).size !== data.chats.length) throw new Error("STORAGE_INVALID");
    this.value = data;
    for (const chat of data.chats) {
      validateChat(chat); if (!data.projects.some(project => project.id === chat.projectId)) throw new Error("STORAGE_INVALID");
      recovered(chat);
      if (data.version === 1) this.loaded.add(chat.id); else { this.known.add(chat.id); this.startupRecovery.add(chat.id); }
    }
    if (data.version === 1) this.save();
  }
  get projects() { return this.value.projects; }
  // Inactive entries contain metadata; call chat() before accessing full content.
  get chats() { return this.value.chats; }
  get activeChatId() { return this.value.activeChatId; }
  set activeChatId(value: string | null) { this.value.activeChatId = value; }
  chat(id: string) {
    const chat = this.value.chats.find(chat => chat.id === id); if (!chat) return undefined;
    if (existsSync(path.join(this.directory, "deletions", `${id}.json`))) { chat.execution = "reconcile"; chat.error = "CHAT_DELETE_INCOMPLETE"; return chat; }
    if (!this.loaded.has(id) && this.known.has(id)) {
      const loaded = JSON.parse(readPrivate(this.directory, `chats/${id}.json`, 224 * 1024 * 1024)) as Chat;
      validateChat(loaded);
      if (loaded.id !== id || loaded.projectId !== chat.projectId) throw new Error("STORAGE_INVALID");
      if (this.startupRecovery.has(id)) { recovered(loaded); this.startupRecovery.delete(id); }
      Object.assign(chat, loaded);
    }
    this.loaded.add(id); return chat;
  }
  async hold<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.held.set(id, (this.held.get(id) ?? 0) + 1);
    try { return await action(); }
    finally { const count = (this.held.get(id) ?? 1) - 1; if (count) this.held.set(id, count); else this.held.delete(id); }
  }
  save() {
    if (this.chats.length > 1000) throw new Error("CHAT_COUNT_LIMIT");
    for (const chat of this.chats) if (this.loaded.has(chat.id) || !this.known.has(chat.id)) {
      validateChat(chat);
      const text = JSON.stringify(chat);
      if (Buffer.byteLength(text) > 224 * 1024 * 1024) throw new Error("STORAGE_SIZE_LIMIT");
      const hash = createHash("sha256").update(text).digest("hex");
      if (this.savedHashes.get(chat.id) !== hash) { writePrivate(this.directory, `chats/${chat.id}.json`, text); this.savedHashes.set(chat.id, hash); }
      this.loaded.add(chat.id); this.known.add(chat.id);
    }
    const index = { version: 2, projects: this.projects, chats: this.chats.map(summary), activeChatId: this.activeChatId };
    writePrivate(this.directory, "workspace.json", JSON.stringify(index)); this.value.version = 2;
  }
  forget(id: string) {
    this.value.chats = this.chats.filter(chat => chat.id !== id); this.loaded.delete(id); this.known.delete(id); this.savedHashes.delete(id);
    if (this.activeChatId === id) this.activeChatId = this.chats.at(-1)?.id ?? null;
    this.save();
  }
  state(extra: Omit<AppState, keyof Stored | "version">): AppState {
    if (this.activeChatId) this.chat(this.activeChatId);
    const result = structuredClone({ projects: this.projects, chats: this.chats.map(chat => chat.id === this.activeChatId ? chat : summary(chat)), activeChatId: this.activeChatId, version: this.appVersion, ...extra });
    for (const chat of this.chats) if (chat.id !== this.activeChatId && this.loaded.has(chat.id) && this.known.has(chat.id) && !this.held.has(chat.id) &&
      !["running", "waiting", "stopping"].includes(chat.execution)) {
      Object.assign(chat, summary(chat)); this.loaded.delete(chat.id); this.savedHashes.delete(chat.id);
    }
    return result;
  }
}
