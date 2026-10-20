import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const RUNTIME_HASHES = {
  engine: "dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f",
  shell: "362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139",
  node: "3a9ac860c566b7aebf144be914f95e3ec36dc88040aa7acb5d9d1e6e0c7afd5e",
};
export function runtimePaths(sourceRoot: string, resources: string, packaged: boolean, userHome: string) {
  return packaged ? {
    engine: path.join(resources, "runtimes/codex/bin/codex.exe"), shell: path.join(resources, "runtimes/powershell/pwsh.exe"),
    node: path.join(resources, "runtimes/node/node.exe"), guard: path.join(resources, "guard"),
  } : {
    engine: path.join(sourceRoot, ".local/engines/codex-0.162.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe"),
    shell: path.join(userHome, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe"),
    node: "C:/nvm4w/nodejs/node.exe", guard: path.join(sourceRoot, "validation"),
  };
}
async function hash(file: string) {
  const digest = createHash("sha256");
  if (lstatSync(file).size <= 8 * 1024 * 1024) return digest.update(readFileSync(file)).digest("hex");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export async function verifyRuntime(files: ReturnType<typeof runtimePaths>, resources: string, packaged: boolean) {
  const result = { engine: false, shell: false, node: false };
  for (const key of ["engine", "shell", "node"] as const) { try { result[key] = await hash(files[key]) === RUNTIME_HASHES[key]; } catch {} }
  if (!packaged || !Object.values(result).every(Boolean)) return result;
  try {
    const manifestFile = path.join(resources, "runtime-manifest.json");
    if (lstatSync(manifestFile).size > 4 * 1024 * 1024) throw new Error();
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 12000) throw new Error();
    const expected = new Map<string, string>();
    for (const item of manifest.files) {
      if (typeof item.relative !== "string" || !/^(runtimes\/|guard\/)/.test(item.relative) || item.relative.includes("..") || item.relative.includes("\\") || !/^[a-f0-9]{64}$/.test(item.sha256) || expected.has(item.relative)) throw new Error();
      expected.set(item.relative, item.sha256);
    }
    const actual: string[] = [];
    const visit = (directory: string) => {
      if (lstatSync(directory).isSymbolicLink() || realpathSync(directory).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new Error();
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name), stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error();
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile() && stat.nlink === 1) actual.push(path.relative(resources, file).replaceAll("\\", "/"));
        else throw new Error();
      }
    };
    visit(path.join(resources, "runtimes")); visit(path.join(resources, "guard"));
    if (actual.length !== expected.size) throw new Error();
    for (const relative of actual) {
      if (await hash(path.join(resources, relative)) !== expected.get(relative)) throw new Error();
    }
    if (!["windows-file-guard.ps1", "windows-file-guard.cs", "windows-process-owner.ps1", "windows-process-owner.cs"].every(name => existsSync(path.join(files.guard, name)))) throw new Error();
    return result;
  } catch { return { engine: false, shell: false, node: false }; }
}
