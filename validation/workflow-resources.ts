import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash, WindowsFileGuard } from "./windows-file-guard.js";
import { psQuote } from "./workflow-sample.js";

// Uses the already installed, lockfile-pinned compiler. No download, package
// scripts, links to the original project or shared writable dependency cache.
export async function prepareResourceFixture(project: string, guard: WindowsFileGuard) {
  const source = path.resolve("node_modules/typescript");
  if (JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")).version !== "5.9.3") throw new Error("WORKFLOW_DEPENDENCY_VERSION");
  const tree = await guard.captureDependencies(source);
  if (tree.excluded.length) throw new Error("WORKFLOW_DEPENDENCY_EXCLUDED");
  for (const entry of tree.files) {
    const file = path.join(project, "node_modules/typescript", entry.relative);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(entry.base64, "base64"), { flag: "wx" });
  }
  const local = path.join(project, "node_modules/fixture-math"); mkdirSync(local);
  writeFileSync(path.join(local, "package.json"), JSON.stringify({ name: "fixture-math", version: "1.0.0", type: "module", main: "index.js", types: "index.d.ts" }));
  writeFileSync(path.join(local, "index.js"), "export const scale = n => n * 2;\n");
  writeFileSync(path.join(local, "index.d.ts"), "export declare function scale(n: number): number;\n");
  writeFileSync(path.join(project, "src/dependency-check.ts"), "import {scale} from 'fixture-math';\nexport const answer: number = scale(21);\n");
  mkdirSync(path.join(project, "assets"));
  const asset = Buffer.from([0, 255, 12, 88, 0, 1]); writeFileSync(path.join(project, "assets/sample.bin"), asset);
  return { compilerVersion: "5.9.3", dependencyFiles: tree.files.length + 3, dependencyBytes: tree.files.reduce((sum, file) => sum + Buffer.from(file.base64, "base64").length, 0), assetHash: contentHash(asset) };
}

export function resourceBoundaryCommand(workspace: string, assetHash: string) {
  const asset = psQuote(path.join(workspace, "assets/sample.bin"));
  const dependency = psQuote(path.join(workspace, "node_modules/fixture-math/index.js"));
  return `if ((Get-FileHash -LiteralPath ${asset}).Hash.ToLowerInvariant() -ne '${assetHash}') { throw 'ASSET_READ_FAILED' }; ` +
    [`[IO.File]::WriteAllBytes(${asset}, [byte[]]@(1,2))`, `[IO.File]::WriteAllText(${dependency}, 'MUTATED')`]
      .map(action => `$blocked=$false; try { ${action} } catch { $blocked=$true }; if (-not $blocked) { throw 'IMMUTABLE_WRITE_ALLOWED' }; `).join("") +
    "Get-Content -LiteralPath './src/catalog.mjs' -Raw";
}
