import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppStore } from "../dist/src/main/storage/store.js";
import { newChat } from "../dist/src/main/projects/projects.js";
import { createRunDirectory } from "../dist/validation/run-directory.js";

const extra = { runtime: { engine: true, shell: true, node: true, key: false, ready: false, platform: "test" }, budget: { committed: 0, unknown: 0, limit: 10 }, executionAvailable: false };
test("chat records exceed the old 8 MiB limit without bloating the index or inactive IPC", async () => {
  const run = createRunDirectory("desktop storage");
  try {
    const store = new AppStore(run.root), project = { id: randomUUID(), name: "capacity", path: run.root, files: [], excluded: 0 };
    store.projects.push(project);
    const first = newChat(project.id), second = newChat(project.id), text = "a".repeat(1024 * 1024);
    first.execution = "ended"; first.messages.push({ id: randomUUID(), role: "assistant", text: "retained conversation" });
    first.changes = Array.from({ length: 9 }, (_, index) => ({ relative: `${index}.txt`, before: text, after: text.replace(/^a/, "b"), kind: "modify", status: "pending" }));
    store.chats.push(first, second); store.activeChatId = first.id; store.save();
    assert.ok(statSync(path.join(run.root, "chats", `${first.id}.json`)).size > 8 * 1024 * 1024);
    assert.ok(statSync(path.join(run.root, "workspace.json")).size < 8192);
    store.activeChatId = second.id;
    assert.equal(store.state(extra).chats.find(chat => chat.id === first.id).changes[0].before, "");
    store.activeChatId = first.id;
    assert.equal(store.state(extra).chats.find(chat => chat.id === first.id).changes[0].before, text);
    assert.equal(store.chat(first.id).execution, "ended", "Switching tabs is not a process restart");
    store.save();
    const restarted = new AppStore(run.root);
    assert.equal(restarted.chat(first.id).execution, "reconcile");
    assert.equal(restarted.chat(first.id).messages[0].text, "retained conversation");
    assert.equal(restarted.chat(first.id).changes[8].after.length, text.length);
    await restarted.hold(first.id, async () => {
      restarted.activeChatId = second.id; restarted.state(extra);
      assert.equal(restarted.chat(first.id).changes[8].before, text, "Held asynchronous work retains its content");
    });
  } finally { run.cleanup(); }
});
test("version 1 migration preserves content before replacing the workspace index", () => {
  const run = createRunDirectory("desktop migration");
  try {
    const project = { id: randomUUID(), name: "legacy", path: run.root, files: [], excluded: 0 }, chat = newChat(project.id);
    chat.messages.push({ id: randomUUID(), role: "user", text: "original history" });
    writeFileSync(path.join(run.root, "workspace.json"), JSON.stringify({ version: 1, projects: [project], chats: [chat], activeChatId: chat.id }));
    const store = new AppStore(run.root);
    assert.equal(store.chat(chat.id).messages[0].text, "original history");
    assert.equal(JSON.parse(readFileSync(path.join(run.root, "workspace.json"), "utf8")).version, 2);
    assert.equal(new AppStore(run.root).chat(chat.id).messages[0].text, "original history");
  } finally { run.cleanup(); }
});
