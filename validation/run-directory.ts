import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export function createRunDirectory(prefix: string): { root: string; cleanup: () => void } {
  if (!/^[\p{L}a-z0-9 -]+$/u.test(prefix)) throw new Error("RUN_INVALID_PREFIX");
  const base = path.resolve(".local/runs");
  mkdirSync(base, { recursive: true });
  if (!same(realpathSync(base), base)) throw new Error("RUN_REDIRECTED_BASE");
  const root = mkdtempSync(path.join(base, `${prefix}-`));
  writeFileSync(path.join(root, ".lcodex-run.json"), JSON.stringify({ kind: "generated-validation-run", version: 1 }));
  return {
    root,
    cleanup() {
      if (!same(path.dirname(root), base) || !same(realpathSync(root), root)) throw new Error("RUN_UNSAFE_TARGET");
      const verifyTree = (directory: string): void => {
        for (const name of readdirSync(directory)) {
          const child = path.join(directory, name);
          const stat = lstatSync(child);
          if (stat.isSymbolicLink()) throw new Error("RUN_LINK_REFUSED");
          if (stat.isDirectory()) verifyTree(child);
        }
      };
      verifyTree(root);
      // Node 24.8 on this Windows host silently left Unicode directories behind with
      // recursive rmSync. Use explicit native file operations and verify the postcondition.
      const removeTree = (directory: string): void => {
        for (const name of readdirSync(directory)) {
          const child = path.join(directory, name);
          const stat = lstatSync(child);
          if (stat.isSymbolicLink()) throw new Error("RUN_LINK_REFUSED");
          if (stat.isDirectory()) removeTree(child);
          else {
            // Git may mark its generated loose objects read-only on Windows.
            if ((stat.mode & 0o200) === 0) chmodSync(child, stat.mode | 0o200);
            unlinkSync(child);
          }
        }
        rmdirSync(directory);
      };
      // Only this newly created, verified run is removed. Caller must stop its processes first.
      removeTree(root);
      if (existsSync(root)) throw new Error("RUN_CLEANUP_INCOMPLETE");
    },
  };
}
