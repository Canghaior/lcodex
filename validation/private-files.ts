import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Only for coordinator-owned state. Project writes still use WindowsFileGuard.
export function privatePath(root: string, relative: string): string {
  const base = path.resolve(root), file = path.resolve(base, relative), inside = path.relative(base, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("STORAGE_PATH_REFUSED");
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) { if (current !== file) throw new Error("STORAGE_PATH_MISSING"); break; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || current !== file && !stat.isDirectory() || current === file && (!stat.isFile() || stat.nlink !== 1)) throw new Error("STORAGE_PATH_REFUSED");
  }
  return file;
}
export function readPrivate(root: string, relative: string, limit = 1024 * 1024): string {
  const file = privatePath(root, relative), size = lstatSync(file).size;
  if (size > limit) throw new Error("STORAGE_SIZE_LIMIT");
  return readFileSync(file, "utf8");
}
export function writePrivate(root: string, relative: string, bytes: string): void {
  const file = privatePath(root, relative), temp = privatePath(root, path.relative(root, path.join(path.dirname(file), `${randomUUID()}.tmp`)));
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  privatePath(root, relative); renameSync(temp, file);
}
