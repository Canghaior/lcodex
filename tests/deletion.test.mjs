import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AppStore } from "../dist/src/main/storage/store.js";
import { newChat } from "../dist/src/main/projects/projects.js";
import { prepareChatDeletion, performChatDeletion, finishChatDeletion } from "../dist/src/main/storage/deletion.js";
import { createRunDirectory } from "../dist/validation/run-directory.js";

function fixture() {
  const run = createRunDirectory("desktop deletion"), root = path.join(run.root, "desktop");
  const store = new AppStore(root), project = { id: randomUUID(), name: "fixture", path: path.join(run.root, "original"), files: [], excluded: 0 };
  mkdirSync(project.path); writeFileSync(path.join(project.path, "keep.txt"), "user data");
  const chat = newChat(project.id); chat.execution = "ended";
  store.projects.push(project); store.chats.push(chat); store.activeChatId = chat.id; store.save();
  const reviewId = randomUUID(), taskRoot = path.join(root, "tasks", chat.id), reviewRoot = path.join(root, "reviews", reviewId), turn = path.join(taskRoot, "turns", randomUUID());
  mkdirSync(turn, { recursive: true }); mkdirSync(path.join(reviewRoot, "private"), { recursive: true });
  writeFileSync(path.join(turn, "task.json"), JSON.stringify({ chatId: chat.id, projectId: project.id, taskDirectory: reviewRoot }));
  writeFileSync(path.join(turn, "outcome.json"), JSON.stringify({ status: "completed", cleanExit: true }));
  writeFileSync(path.join(reviewRoot, "private/apply.jsonl"), JSON.stringify({ type: "created", taskId: reviewId }) + '\n{"type":"closed"}\n');
  writeFileSync(path.join(root, "deepseek.bin"), "synthetic protected credential");
  writeFileSync(path.join(root, "budget.jsonl"), "synthetic persistent budget");
  return { run, root, store, chat, project, taskRoot, reviewRoot };
}
test("interrupted explicit deletion resumes only recorded private targets and preserves independent data", async () => {
  const f = fixture();
  try {
    prepareChatDeletion(f.root, f.chat);
    await assert.rejects(performChatDeletion(f.root, f.chat.id, () => { throw new Error("TEST_INTERRUPTION"); }), /TEST_INTERRUPTION/);
    const restarted = new AppStore(f.root);
    assert.equal(restarted.chat(f.chat.id).error, "CHAT_DELETE_INCOMPLETE");
    prepareChatDeletion(f.root, restarted.chat(f.chat.id));
    await performChatDeletion(f.root, f.chat.id); restarted.forget(f.chat.id); finishChatDeletion(f.root, f.chat.id);
    assert.equal(existsSync(f.taskRoot), false); assert.equal(existsSync(f.reviewRoot), false);
    assert.equal(new AppStore(f.root).chats.length, 0);
    assert.equal(readFileSync(path.join(f.project.path, "keep.txt"), "utf8"), "user data");
    assert.equal(readFileSync(path.join(f.root, "deepseek.bin"), "utf8"), "synthetic protected credential");
    assert.equal(readFileSync(path.join(f.root, "budget.jsonl"), "utf8"), "synthetic persistent budget");
  } finally { f.run.cleanup(); }
});
test("unknown tasks, pending reviews and linked private trees cannot be cleaned", () => {
  const f = fixture(), link = path.join(f.taskRoot, "redirect");
  try {
    f.chat.execution = "reconcile"; assert.throws(() => prepareChatDeletion(f.root, f.chat), /CHAT_DELETE_REFUSED/);
    f.chat.execution = "ended"; f.chat.changes.push({ relative: "code.js", kind: "modify", before: "a", after: "b", status: "pending" });
    assert.throws(() => prepareChatDeletion(f.root, f.chat), /CHAT_DELETE_REFUSED/); f.chat.changes = [];
    symlinkSync(f.project.path, link, "junction");
    assert.throws(() => prepareChatDeletion(f.root, f.chat), /CHAT_DELETE_LINK_REFUSED/);
    assert.equal(readFileSync(path.join(f.project.path, "keep.txt"), "utf8"), "user data");
    unlinkSync(link);
    writeFileSync(path.join(f.reviewRoot, "private/apply.jsonl"), '{"type":"created"}\n');
    assert.throws(() => prepareChatDeletion(f.root, f.chat), /CHAT_DELETE_REFUSED/);
  } finally { if (existsSync(link)) unlinkSync(link); f.run.cleanup(); }
});
