import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { projectModelTools, projectToolPolicy } from "./project-tool-policy.js";

const root = path.resolve(".local/synthetic-workspace"), shell = "fixed-pwsh", policy = projectToolPolicy(root, shell, ".lcodex-root-test");
test("model schema communicates the enforced envelope without granting extra tools or mutating engine metadata", () => {
  const original = [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" }, sandbox_permissions: { type: "string" } }, required: ["cmd"] } },
    { type: "function", name: "write_stdin" }];
  const before = structuredClone(original), tools = projectModelTools(original, root, shell);
  assert.deepEqual(original, before); assert.equal(tools.length, 1);
  const schema = tools[0]!.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
  assert.deepEqual(schema.required, ["cmd", "shell", "login", "workdir"]);
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.sandbox_permissions, undefined);
  assert.throws(() => policy.functionCall("exec_command", { cmd: "anything" }), /PROJECT_SHELL_REFUSED/);
});
test("advertised output and wait limits match enforcement even if the engine advertises larger defaults", () => {
  const [tool] = projectModelTools([{ type: "function", name: "exec_command", parameters: { properties: {
    cmd: { type: "string" }, max_output_tokens: { type: "number", default: 10000 }, yield_time_ms: { type: "number", maximum: 300000 },
  } } }], root, shell);
  const properties = (tool!.parameters as { properties: Record<string, { type: string; minimum: number; maximum: number; default?: number }> }).properties;
  for (const field of ["max_output_tokens", "yield_time_ms"]) {
    const limit = properties[field]!;
    assert.equal(limit.type, "integer");
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, field === "max_output_tokens" ? 4096 : 30000);
    assert.equal(limit.default, undefined);
    const args = { cmd: "Get-Content ./source.txt", shell, login: false, workdir: root };
    for (const value of [limit.minimum, limit.maximum]) policy.functionCall("exec_command", { ...args, [field]: value });
    for (const value of [0, 1.5, limit.maximum + 1]) assert.throws(() => policy.functionCall("exec_command", { ...args, [field]: value }), /PROJECT_.*REFUSED/);
  }
});
test("binary resource paths cannot be admitted through relative, absolute or move patch headers", () => {
  const assets = projectToolPolicy(root, shell, ".lcodex-root-test", ["assets/logo.png"]);
  for (const file of ["assets/logo.png", path.join(root, "assets/logo.png"), ...(process.platform === "win32" ? ["assets/LOGO.png"] : [])]) {
    assert.throws(() => assets.patch(`*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch`), /ASSET_READ_ONLY/);
    assert.throws(() => assets.patch(`*** Begin Patch\n*** Update File: src/file.txt\n*** Move to: ${file}\n@@\n-old\n+new\n*** End Patch`), /ASSET_READ_ONLY/);
  }
});
test("general commands stay in a pinned execution envelope without pretending to parse shell security", () => {
  const args = { cmd: "Get-Content ./src/example.ts", shell, login: false, workdir: root };
  policy.functionCall("exec_command", args);
  policy.functionCall("exec_command", { ...args, yield_time_ms: 30000 });
  for (const changes of [{ shell: "cmd.exe" }, { login: true }, { workdir: path.dirname(root) }, { sandbox_permissions: "require_escalated" }, { max_output_tokens: 100_000 }, { yield_time_ms: 30001 }]) {
    assert.throws(() => policy.functionCall("exec_command", { ...args, ...changes }), /PROJECT_.*REFUSED/);
  }
  assert.throws(() => policy.functionCall("write_stdin", { session_id: 1, chars: "run" }), /PROJECT_.*REFUSED/);
});
test("general multi-file patches cannot target credentials, metadata or escaping paths", () => {
  policy.patch("*** Begin Patch\n*** Add File: src/new.ts\n+export const x=1;\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch");
  policy.patch(`*** Begin Patch\n*** Add File: ${path.join(root, "src/new.ts")}\n+const x=1;\n*** End Patch`);
  for (const file of ["../outside", "/absolute", "C:/escape", ".git/config", ".codex/config.toml", ".agents/skills/injected/SKILL.md", ".env", ".lcodex-root-test", "src/file:stream", "NUL", "node_modules/a.js"]) {
    assert.throws(() => policy.patch(`*** Begin Patch\n*** Add File: ${file}\n+bad\n*** End Patch`), /PROJECT_.*REFUSED/);
  }
});
