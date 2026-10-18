import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isolatedEnvironment } from "./isolated-env.js";
import { isObject, JsonLineRpc } from "./rpc.js";
import { createRunDirectory } from "./run-directory.js";

const expectedVersion = "codex-cli 0.140.0";
const expectedSha256 = "03e5cf467f4ef2c06360b00cdc9aef64bb79b2028e25e3e122dd0bd2152ace22";

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function main(): Promise<void> {
  const binaryArg = process.argv[2] ?? process.env.CODEX_BINARY;
  requireCondition(binaryArg && path.isAbsolute(binaryArg), "PROBE_REQUIRES_ABSOLUTE_CODEX_BINARY");
  const binary = await realpath(binaryArg);
  const binarySha = createHash("sha256").update(await readFile(binary)).digest("hex");
  requireCondition(binarySha === expectedSha256, "PROBE_BINARY_HASH_MISMATCH");
  const localRoot = path.resolve(".local");
  await mkdir(localRoot, { recursive: true });
  const run = createRunDirectory("p1 中文路径");
  const root = run.root;
  for (const directory of ["home", "profile/roaming", "profile/local", "temp", "workspace"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  const env = isolatedEnvironment(root, process.env);
  await writeFile(path.join(root, "home/config.toml"), [
    'model = "offline-probe"',
    'model_provider = "offline_probe"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '[analytics]',
    'enabled = false',
    '[model_providers.offline_probe]',
    'name = "Offline probe - no inference"',
    'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join("\n"));
  const common = { env, cwd: path.join(root, "workspace"), windowsHide: true };
  const version = spawnSync(binary, ["--version"], { ...common, encoding: "utf8", timeout: 10_000 });
  requireCondition(!version.error && version.status === 0 && version.stdout.trim() === expectedVersion, "PROBE_VERSION_MISMATCH");
  const schemaDirectory = path.join(root, "schema");
  const schema = spawnSync(binary, ["app-server", "generate-json-schema", "--out", schemaDirectory], {
    ...common, encoding: "utf8", timeout: 20_000,
  });
  requireCondition(!schema.error && schema.status === 0, "PROBE_SCHEMA_GENERATION_FAILED");
  const schemaHashes: Record<string, string> = {};
  for (const name of ["v1/InitializeParams.json", "v1/InitializeResponse.json", "v2/ConfigReadParams.json", "v2/ConfigReadResponse.json"]) {
    schemaHashes[name] = createHash("sha256").update(await readFile(path.join(schemaDirectory, name))).digest("hex");
  }

  const child = spawn(binary, ["app-server", "--listen", "stdio://", "--strict-config"], {
    ...common, stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  const rpc = new JsonLineRpc(child.stdout, child.stdin, 10_000);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  child.on("error", () => rpc.abort(new Error("PROBE_SPAWN_FAILED")));
  let exitResult: Awaited<typeof closed> | undefined;
  let forcedExit = false;
  try {
    const initialized = await rpc.request("initialize", {
      clientInfo: { name: "lcodex_p1_offline", version: "0.0.1" },
      capabilities: { experimentalApi: false },
    });
    requireCondition(isObject(initialized), "PROBE_INVALID_INITIALIZE_RESULT");
    requireCondition(initialized.platformOs === "windows", "PROBE_UNEXPECTED_PLATFORM");
    requireCondition(typeof initialized.codexHome === "string" &&
      (await realpath(initialized.codexHome)).toLowerCase() === (await realpath(path.join(root, "home"))).toLowerCase(), "PROBE_HOME_NOT_ISOLATED");
    rpc.notify("initialized", {});
    const result = await rpc.request("config/read", { includeLayers: false });
    requireCondition(isObject(result) && isObject(result.config), "PROBE_INVALID_CONFIG_RESULT");
    requireCondition(result.config.model_provider === "offline_probe" && result.config.model === "offline-probe", "PROBE_WRONG_PROVIDER");
    requireCondition(result.config.sandbox_mode === "read-only" && result.config.approval_policy === "never", "PROBE_WRONG_POLICY");
  } finally {
    rpc.abort(new Error("PROBE_CLOSED"));
    child.stdin.end();
    async function waitForExit(ms: number): Promise<Awaited<typeof closed> | undefined> {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([closed, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
      } finally { clearTimeout(timer); }
    }
    exitResult = await waitForExit(3_000);
    if (!exitResult) {
      forcedExit = true;
      child.kill();
      exitResult = await waitForExit(3_000);
    }
    requireCondition(exitResult, "PROBE_PROCESS_EXIT_UNCONFIRMED");
  }
  requireCondition(!forcedExit && exitResult.code === 0, "PROBE_UNCLEAN_EXIT");
  requireCondition(rpc.deniedServerRequests === 0, "PROBE_UNEXPECTED_SERVER_REQUEST");
  const report = {
    kind: "local-app-server-handshake-only",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    engineVersion: expectedVersion,
    engineSha256: binarySha,
    schemaHashes,
    isolatedHome: true,
    chineseAndSpacePath: true,
    initialize: "passed",
    configRead: "passed",
    modelRequestsSent: 0,
    toolTasksStarted: 0,
    notifications: rpc.notifications,
    deniedServerRequests: rpc.deniedServerRequests,
    stderrBytes,
    processExit: exitResult,
    sandboxEnforcement: "not-tested",
    deepSeekCompatibility: "not-tested",
  };
  await mkdir(path.join(localRoot, "reports"), { recursive: true });
  await writeFile(path.join(localRoot, "reports/offline-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  run.cleanup();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  // Emit only our fixed error code. Never echo native stderr, configuration or credentials.
  const code = error instanceof Error && /^(PROBE_|RPC_)[A-Z0-9_-]+$/.test(error.message)
    ? error.message : "PROBE_FAILED";
  console.error(JSON.stringify({ status: "failed", code, modelRequestsSent: 0 }));
  process.exitCode = 1;
});
