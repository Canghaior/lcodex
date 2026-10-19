import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRunDirectory } from "./run-directory.js";
import { TaskLimits, TASK_LIMITS } from "./task-limits.js";

test("task request cap persists across reconnect and blocks before dispatch", () => {
  const run = createRunDirectory("task limits"), file = path.join(run.root, "task.jsonl"); TaskLimits.create(file, 10);
  let limit = new TaskLimits(file, () => 10);
  try {
    for (let i = 0; i < 3; i++) limit.request(); limit.close(); limit = new TaskLimits(file, () => 10);
    for (let i = 3; i < TASK_LIMITS.requests; i++) limit.request();
    assert.throws(() => limit.request(), /REQUEST_LIMIT/); assert.equal(limit.summary().requests, 8);
    limit.close(); limit = new TaskLimits(file, () => 10); assert.throws(() => limit.check(), /REQUEST_LIMIT/);
  } finally { limit.close(); run.cleanup(); }
});
test("unknown tools cannot be replayed and consecutive failures stop subsequent requests", () => {
  for (const unknown of [true, false]) {
    const run = createRunDirectory("tool limits"), file = path.join(run.root, "task.jsonl"); TaskLimits.create(file, 10);
    let limit = new TaskLimits(file, () => 10);
    try {
      limit.request(); limit.tool("one");
      if (unknown) {
        limit.close(); limit = new TaskLimits(file, () => 10); assert.throws(() => limit.request(), /TOOL_RESULT_UNKNOWN/);
      } else {
        limit.result("one", false); limit.request(); limit.tool("two"); limit.result("two", false);
        assert.throws(() => limit.request(), /FAILURE_LIMIT/); assert.equal(limit.summary().requests, 2);
      }
    } finally { limit.close(); run.cleanup(); }
  }
});
test("deadline and clock rollback are persistent stops and parallel calls are refused", () => {
  for (const mode of ["time", "clock", "parallel"]) {
    const run = createRunDirectory("clock limits"), file = path.join(run.root, "task.jsonl"); TaskLimits.create(file, 10);
    let now = 10; const limit = new TaskLimits(file, () => now);
    try {
      if (mode === "time") { now += TASK_LIMITS.durationMs; assert.throws(() => limit.request(), /TIME_LIMIT/); }
      if (mode === "clock") { now--; assert.throws(() => limit.request(), /CLOCK_RECONCILE/); }
      if (mode === "parallel") { limit.request(); limit.tool("one"); assert.throws(() => limit.tool("two"), /SEQUENCE_REFUSED/); }
    } finally { limit.close(); run.cleanup(); }
  }
});

test("a batch counts one round, persists queued tools and never replays after restart", () => {
  const run = createRunDirectory("batch limits"), file = path.join(run.root, "task.jsonl"); TaskLimits.create(file, 10);
  let limit = new TaskLimits(file, () => 10);
  try {
    limit.request(); limit.planBatch(["one", "two"]); limit.tool("one"); limit.result("one", true);
    assert.equal(limit.summary().toolRounds, 1); assert.equal(limit.summary().queued, 1);
    limit.close(); limit = new TaskLimits(file, () => 10);
    assert.throws(() => limit.tool("two"), /BATCH_RECONCILE/);
    assert.equal(limit.summary().tools, 1); assert.equal(limit.summary().queued, 1);
  } finally { limit.close(); run.cleanup(); }
});

test("batch dispatch remains serial and tool cap is independent of the round cap", () => {
  const run = createRunDirectory("batch count"), file = path.join(run.root, "task.jsonl"); TaskLimits.create(file, 10);
  const limit = new TaskLimits(file, () => 10);
  try {
    for (let round = 0; round < 3; round++) {
      limit.request(); const ids = Array.from({ length: 4 }, (_, i) => `call-${round}-${i}`); limit.planBatch(ids);
      for (const id of ids) { limit.tool(id); limit.result(id, true); }
    }
    assert.equal(limit.summary().requests, 3); assert.equal(limit.summary().tools, 12); assert.equal(limit.summary().toolRounds, 3);
    limit.request(); assert.throws(() => limit.planBatch(["extra"]), /TOOL_LIMIT/);
    assert.equal(limit.summary().tools, 12);
  } finally { limit.close(); run.cleanup(); }
});
