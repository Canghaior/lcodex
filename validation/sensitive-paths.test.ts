import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sensitivePaths } from "./sensitive-paths.js";
import { createRunDirectory } from "./run-directory.js";

test("inventory covers nested environment files, credential folders and Git configuration", () => {
  const run = createRunDirectory("sensitive-inventory");
  try {
    for (const directory of ["nested", ".ssh", ".git"]) mkdirSync(path.join(run.root, directory));
    for (const file of ["nested/.env.local", ".env.example", ".ssh/id_ed25519", ".git/config", "certificate.pem", "ordinary.ts"]) writeFileSync(path.join(run.root, file), "synthetic");
    const paths = sensitivePaths(run.root).map((file) => path.relative(run.root, file).replaceAll("\\", "/"));
    assert.deepEqual(paths.sort(), [".env.example", ".git/config", ".ssh", "certificate.pem", "nested/.env.local"].sort());
  } finally { run.cleanup(); }
});

test("inventory refuses an incomplete scan instead of silently admitting remaining paths", () => {
  const run = createRunDirectory("sensitive-limit");
  try {
    writeFileSync(path.join(run.root, "a.txt"), "a"); writeFileSync(path.join(run.root, "z.env"), "z");
    assert.throws(() => sensitivePaths(run.root, 1), /INVENTORY_LIMIT/);
  } finally { run.cleanup(); }
});

test("inventory does not follow a junction to files outside the selected project", () => {
  const run = createRunDirectory("sensitive-link");
  const target = path.join(run.root, "outside"), project = path.join(run.root, "project"), link = path.join(project, "alias");
  mkdirSync(target); mkdirSync(project); symlinkSync(target, link, "junction");
  try { assert.throws(() => sensitivePaths(project), /LINK_REFUSED/); }
  finally { unlinkSync(link); run.cleanup(); }
});
