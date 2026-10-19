import path from "node:path";
import { isObject } from "./rpc.js";

function requireValue(value: unknown, code = "PROJECT_TOOL_REFUSED"): asserts value { if (!value) throw new Error(code); }
// The engine's generic schema makes these optional. Our fixed execution contract
// requires them, so communicate that in the schema as well as checking outputs.
// This does not fill in or rewrite a model call or weaken the execution boundary.
export function projectModelTools(tools: Record<string, unknown>[], workspace: string, shell: string) {
  return tools.flatMap(tool => {
    if (tool.type === "custom" && tool.name === "apply_patch") return [structuredClone(tool)];
    if (tool.type !== "function" || tool.name !== "exec_command") return [];
    const result = structuredClone(tool);
    requireValue(isObject(result.parameters) && isObject(result.parameters.properties), "PROJECT_TOOL_SCHEMA_REFUSED");
    result.parameters.properties.shell = { type: "string", enum: [shell], description: "Required pinned shell executable." };
    result.parameters.properties.login = { type: "boolean", enum: [false] };
    result.parameters.properties.workdir = { type: "string", enum: [workspace] };
    result.parameters.required = ["cmd", "shell", "login", "workdir"];
    result.parameters.additionalProperties = false;
    for (const key of Object.keys(result.parameters.properties)) if (!["cmd", "shell", "login", "workdir", "yield_time_ms", "max_output_tokens"].includes(key)) delete result.parameters.properties[key];
    return [result];
  });
}
export function projectToolPolicy(workspace: string, shell: string, rootMarker: string, readOnlyAssets: readonly string[] = []) {
  const root = path.resolve(workspace);
  const equal = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  function relativeFile(file: string) {
    requireValue(!file.startsWith("\\\\") && !file.startsWith("//") && file.length < 512, "PROJECT_PATCH_NAMESPACE_REFUSED");
    // Codex's patch tool commonly receives absolute paths. Admit only an exact
    // descendant of this isolated root; still validate every relative segment.
    const relative = path.isAbsolute(file) ? path.relative(root, path.resolve(file)).replaceAll("\\", "/") : file.replaceAll("\\", "/");
    requireValue(!readOnlyAssets.some(asset => equal(asset, relative)), "PROJECT_ASSET_READ_ONLY");
    requireValue(relative.length < 240 && !path.isAbsolute(relative), "PROJECT_PATCH_PATH_REFUSED");
    const parts = relative.split("/");
    requireValue(parts.every(part => part.length > 0 && part !== "." && part !== ".." && !/[\x00-\x1f:<>"|?*]/.test(part) && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) &&
      ![".git", ".codex", ".agents", ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".npmrc", ".pypirc", ".git-credentials", "credentials.json", "node_modules", rootMarker.toLowerCase()].includes(part.toLowerCase()) &&
      !/^(\.env($|\.)|id_rsa($|\.)|id_ed25519($|\.))/i.test(part) && !/\.(pem|key|p12|pfx|keystore)$/i.test(part)), "PROJECT_PATCH_PATH_REFUSED");
  }
  return {
    functionCall(name: string, args: Record<string, unknown>) {
      // General shell contents are governed by the actual MXC sandbox. This
      // envelope check is deliberately not a shell parser or an OS boundary.
      requireValue(name === "exec_command" && Object.keys(args).every(key => ["cmd", "workdir", "shell", "login", "yield_time_ms", "max_output_tokens"].includes(key)), "PROJECT_TOOL_FIELDS_REFUSED");
      requireValue(typeof args.cmd === "string" && args.cmd.length > 0 && Buffer.byteLength(args.cmd) <= 8192 && !args.cmd.includes("\0"), "PROJECT_COMMAND_SIZE_REFUSED");
      requireValue(args.shell === shell && args.login === false, "PROJECT_SHELL_REFUSED");
      requireValue(args.workdir === undefined || typeof args.workdir === "string" && path.isAbsolute(args.workdir) && equal(path.resolve(args.workdir), root), "PROJECT_CWD_REFUSED");
      requireValue(args.yield_time_ms === undefined || Number.isSafeInteger(args.yield_time_ms) && Number(args.yield_time_ms) >= 1 && Number(args.yield_time_ms) <= 30_000, "PROJECT_YIELD_REFUSED");
      requireValue(args.max_output_tokens === undefined || Number.isSafeInteger(args.max_output_tokens) && Number(args.max_output_tokens) >= 1 && Number(args.max_output_tokens) <= 4096, "PROJECT_OUTPUT_REFUSED");
    },
    patch(input: string) {
      input = input.replaceAll("\r\n", "\n");
      requireValue(Buffer.byteLength(input) <= 32_768 && input.startsWith("*** Begin Patch\n") && input.trimEnd().endsWith("*** End Patch"), "PROJECT_PATCH_FORMAT_REFUSED");
      let files = 0;
      for (const line of input.split("\n")) {
        const header = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
        if (header) { relativeFile(header[1]!); files++; }
        else if (line.startsWith("*** ")) requireValue(["*** Begin Patch", "*** End Patch", "*** End of File"].includes(line));
      }
      requireValue(files > 0 && files <= 16);
    },
  };
}
