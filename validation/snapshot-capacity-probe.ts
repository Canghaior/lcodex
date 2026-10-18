import { copyFileSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRunDirectory } from "./run-directory.js";

const run = createRunDirectory("snapshot-capacity");
try {
  const stats = statfsSync(run.root);
  const freeBytes = stats.bavail * stats.bsize;
  if (freeBytes < 5 * 1024 ** 3) throw new Error("CAPACITY_LOW_DISK");
  const roots = ["project", "snapshot", "candidate"].map((name) => path.join(run.root, name));
  for (const root of roots) mkdirSync(root);
  const files = 64, fileBytes = 128 * 1024;
  const contents = Buffer.alloc(fileBytes, "s");
  const expectedHash = createHash("sha256").update(contents).digest("hex");
  for (let i = 0; i < files; i++) writeFileSync(path.join(roots[0]!, `synthetic-${i}.txt`), contents);
  const copies: Record<string, unknown>[] = [];
  for (const target of roots.slice(1)) {
    const started = performance.now();
    for (let i = 0; i < files; i++) {
      const name = `synthetic-${i}.txt`;
      copyFileSync(path.join(roots[0]!, name), path.join(target, name));
      if (createHash("sha256").update(readFileSync(path.join(target, name))).digest("hex") !== expectedHash) throw new Error("CAPACITY_COPY_MISMATCH");
    }
    copies.push({ kind: path.basename(target), bytes: files * fileBytes, copyAndHashMilliseconds: Math.round(performance.now() - started) });
  }
  const report = { kind: "synthetic-copy-storage-sample", status: "passed", files, originalBytes: files * fileBytes,
    additionalLogicalBytes: 2 * files * fileBytes, totalLogicalBytes: 3 * files * fileBytes, copies,
    physicalAllocationMeasured: false, realProjectBenchmark: false, paidRequests: 0 };
  mkdirSync(path.resolve(".local/reports"), { recursive: true });
  writeFileSync(path.resolve(".local/reports/snapshot-capacity-" + Date.now() + ".json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} finally { run.cleanup(); }
