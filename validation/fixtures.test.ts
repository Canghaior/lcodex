import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFixture, repairedExample, snapshot } from "./fixtures.js";

for (const withGit of [false, true]) {
  test(`${withGit ? "Git dirty" : "non-Git"} sample keeps baseline failures and detects the repaired example`, () => {
    const fixture = createFixture(withGit);
    try {
      const before = fixture.evaluate();
      assert.equal(before.passed, false);
      assert.deepEqual(before.checks.map((check) => check.passed), [true, true, false, false, false, false]);
      if (withGit) {
        assert.match(fixture.gitState!.status, /MM user-notes.txt/);
        assert.match(fixture.gitState!.status, /\?\? user-draft.txt/);
      }
      const userNotes = readFileSync(path.join(fixture.project, "user-notes.txt"), "utf8");
      writeFileSync(fixture.sourceFile, repairedExample);
      assert.equal(fixture.evaluate().passed, true);
      const after = snapshot(fixture.project);
      assert.deepEqual(Object.keys(after).filter((name) => after[name] !== fixture.baseline[name]), ["invoice.mjs"]);
      assert.equal(readFileSync(path.join(fixture.project, "user-notes.txt"), "utf8"), userNotes);
    } finally { fixture.cleanup(); }
  });
}

test("changing independent assertions invalidates acceptance", () => {
  const fixture = createFixture(false);
  try {
    writeFileSync(fixture.evaluator, "process.exit(0);\n");
    assert.throws(() => fixture.evaluate(), /EVALUATOR_CHANGED/);
  } finally { fixture.cleanup(); }
});

test("target exiting early cannot claim success without all independent checks", () => {
  const fixture = createFixture(false);
  try {
    writeFileSync(fixture.sourceFile, "process.exit(0);\n");
    assert.throws(() => fixture.evaluate(), /EVALUATOR_INVALID_OUTPUT/);
  } finally { fixture.cleanup(); }
});
