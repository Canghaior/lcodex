import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { projectToolPolicy } from "./project-tool-policy.js";

const root = path.resolve(".local/synthetic-workspace"), shell = "fixed-pwsh", policy = projectToolPolicy(root, shell, ".lcodex-root-test");
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
