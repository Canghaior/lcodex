import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppStore } from "../dist/src/main/storage/store.js";
import { newChat } from "../dist/src/main/projects/projects.js";
import { Pricing } from "../dist/src/main/storage/pricing.js";
import { createRunDirectory } from "../dist/validation/run-directory.js";

test("legacy chats stay DeepSeek while new OpenAI choice and per-provider prices persist", () => {
  const run = createRunDirectory("provider storage");
  try {
    const project = { id: randomUUID(), name: "legacy", path: run.root, files: [], excluded: 0 };
    const legacy = newChat(project.id); delete legacy.provider; delete legacy.model;
    legacy.messages.push({ id: randomUUID(), role: "user", text: "retained legacy message" });
    writeFileSync(path.join(run.root, "workspace.json"), JSON.stringify({ version: 1, projects: [project], chats: [legacy], activeChatId: legacy.id }));
    const store = new AppStore(run.root); assert.equal(store.defaultProvider, "deepseek");
    const added = newChat(project.id, "openai"); store.chats.push(added); store.defaultProvider = "openai"; store.save();
    const restored = new AppStore(run.root);
    assert.equal(restored.defaultProvider, "openai");
    assert.equal(restored.chat(legacy.id).provider ?? "deepseek", "deepseek");
    assert.equal(restored.chat(legacy.id).messages[0].text, "retained legacy message");
    assert.equal(restored.chat(added.id).model, "gpt-6.2-astra");
    const ds = new Pricing(run.root, false), oa = new Pricing(run.root, false, "openai");
    ds.confirm(); assert.equal(ds.status().current, true); assert.equal(oa.status().current, false);
    oa.confirm(); assert.notEqual(oa.status().reference, ds.status().reference);
    const file = path.join(run.root, "chats", added.id + ".json");
    const corrupted = JSON.parse(readFileSync(file, "utf8")); corrupted.provider = "deepseek"; corrupted.model = "deepseek-v4-pro";
    writeFileSync(file, JSON.stringify(corrupted));
    assert.throws(() => new AppStore(run.root).chat(added.id), /STORAGE_MODEL_INVALID/);
  } finally { run.cleanup(); }
});
