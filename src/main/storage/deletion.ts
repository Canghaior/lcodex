import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privatePath, readPrivate, writePrivate } from "../../../validation/private-files.js";
import { inspectApplyJournal } from "../../../validation/apply-journal.js";
import type { Chat } from "../../shared/contracts.js";

type Deletion = { version: 1; chatId: string; projectId: string; entries: { relative: string; quarantine: string }[] };
const uuid = /^[a-f0-9-]{36}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function directory(root: string, relative: string) {
  const base = path.resolve(root), target = path.resolve(base, relative), inside = path.relative(base, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !same(realpathSync(base), base)) throw new Error("CHAT_DELETE_PATH_REFUSED");
  let current = base;
  for (const part of inside.split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !same(realpathSync(current), current)) throw new Error("CHAT_DELETE_LINK_REFUSED");
  }
  return target;
}
function inspectTree(root: string) {
  for (const name of readdirSync(root)) {
    const file = path.join(root, name), info = lstatSync(file);
    if (info.isSymbolicLink() || !same(realpathSync(file), file)) throw new Error("CHAT_DELETE_LINK_REFUSED");
    if (info.isDirectory()) inspectTree(file);
    else if (!info.isFile() || info.nlink !== 1) throw new Error("CHAT_DELETE_TYPE_REFUSED");
  }
}
export function prepareChatDeletion(root: string, chat: Chat): string {
  if (!uuid.test(chat.id) || !uuid.test(chat.projectId)) throw new Error("CHAT_DELETE_REFUSED");
  const record = `deletions/${chat.id}.json`;
  if (existsSync(path.join(root, record))) { if (readDeletion(root, chat.id).projectId !== chat.projectId) throw new Error("CHAT_DELETE_OWNERSHIP_CHANGED"); return record; }
  if (!["idle", "ended"].includes(chat.execution) || chat.changes.some(change => ["pending", "needs-reconcile"].includes(change.status))) throw new Error("CHAT_DELETE_REFUSED");
  const relatives = new Set<string>(), taskRoot = directory(root, `tasks/${chat.id}`);
  if (existsSync(taskRoot)) {
    inspectTree(taskRoot);
    const turnsRoot = directory(root, `tasks/${chat.id}/turns`);
    const records = existsSync(turnsRoot) ? readdirSync(turnsRoot).map(name => {
      if (!uuid.test(name)) throw new Error("CHAT_DELETE_UNKNOWN_RECORD"); return `${name}/`;
    }) : [""];
    for (const prefix of records) {
      const location = prefix ? turnsRoot : taskRoot;
      const task = JSON.parse(readPrivate(location, `${prefix}task.json`)), outcome = JSON.parse(readPrivate(location, `${prefix}outcome.json`));
      if (task.chatId !== chat.id || task.projectId !== chat.projectId || outcome.cleanExit !== true || outcome.status !== "completed") throw new Error("CHAT_DELETE_REFUSED");
      const taskId = path.basename(task.taskDirectory), relative = `reviews/${taskId}`;
      if (!uuid.test(taskId) || !same(path.resolve(task.taskDirectory), path.join(root, relative))) throw new Error("CHAT_DELETE_PATH_REFUSED");
      const reviewRoot = directory(root, relative); inspectTree(reviewRoot);
      const journal = readPrivate(reviewRoot, "private/apply.jsonl");
      if (inspectApplyJournal(journal, new Map()).length || JSON.parse(journal.trimEnd().split("\n").at(-1)!).type !== "closed") throw new Error("CHAT_DELETE_REFUSED");
      if (JSON.parse(journal.split("\n")[0]!).taskId !== taskId) throw new Error("CHAT_DELETE_UNKNOWN_RECORD");
      relatives.add(relative);
    }
    relatives.add(`tasks/${chat.id}`);
  }
  mkdirSync(directory(root, "deletions"), { recursive: true }); mkdirSync(directory(root, "trash"), { recursive: true });
  const plan: Deletion = { version: 1, chatId: chat.id, projectId: chat.projectId, entries: [...relatives].map(relative => ({ relative, quarantine: `trash/${randomUUID()}` })) };
  writePrivate(root, record, JSON.stringify(plan)); return record;
}
function readDeletion(root: string, chatId: string): Deletion {
  if (!uuid.test(chatId)) throw new Error("CHAT_DELETE_REFUSED");
  const value = JSON.parse(readPrivate(root, `deletions/${chatId}.json`)) as Deletion;
  if (value.version !== 1 || value.chatId !== chatId || !uuid.test(value.projectId) || !Array.isArray(value.entries) || value.entries.length > 1001 ||
    value.entries.some(entry => !(entry.relative === `tasks/${chatId}` || /^reviews\/[a-f0-9-]{36}$/.test(entry.relative)) || !/^trash\/[a-f0-9-]{36}$/.test(entry.quarantine)) ||
    new Set(value.entries.map(entry => entry.relative)).size !== value.entries.length || new Set(value.entries.map(entry => entry.quarantine)).size !== value.entries.length) throw new Error("CHAT_DELETE_RECORD_INVALID");
  return value;
}
export async function performChatDeletion(root: string, chatId: string, afterQuarantine?: () => void) {
  const plan = readDeletion(root, chatId);
  let count = 0;
  const remove = async (folder: string) => {
    for (const name of readdirSync(folder)) {
      const file = path.join(folder, name), info = lstatSync(file);
      if (info.isSymbolicLink() || !same(realpathSync(file), file)) throw new Error("CHAT_DELETE_LINK_REFUSED");
      if (info.isDirectory()) await remove(file);
      else { if (!info.isFile() || info.nlink !== 1) throw new Error("CHAT_DELETE_TYPE_REFUSED"); unlinkSync(file); }
      if (++count % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    rmdirSync(folder);
  };
  for (const entry of plan.entries) {
    const source = directory(root, entry.relative), quarantine = directory(root, entry.quarantine);
    if (existsSync(source) && existsSync(quarantine)) throw new Error("CHAT_DELETE_OWNERSHIP_CHANGED");
    if (existsSync(source)) { inspectTree(source); renameSync(source, quarantine); afterQuarantine?.(); }
    if (existsSync(quarantine)) {
      directory(root, entry.quarantine); inspectTree(quarantine);
      await remove(quarantine);
    }
  }
  const chatFile = privatePath(root, `chats/${chatId}.json`); if (existsSync(chatFile)) unlinkSync(chatFile);
}
export function finishChatDeletion(root: string, chatId: string) { unlinkSync(privatePath(root, `deletions/${chatId}.json`)); }
