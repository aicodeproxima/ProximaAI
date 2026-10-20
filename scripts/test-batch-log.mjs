// Tests for src/lib/batchLog.js — the History entry of a generation batch. Run: node scripts/test-batch-log.mjs
import assert from "node:assert/strict";
import { batchLogItems, finishLogs, isOpenLog, sameLogContent } from "../src/lib/batchLog.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const task = (id, extra = {}) => ({ id, batchId: "b", modelName: `M-${id}`, status: "processing", price: 0.04, wallClockMs: 0, outputs: [], error: null, ...extra });
const log = (items, extra = {}) => ({ id: "b", timestamp: NOW - 60_000, prompt: "p", models: items.map(i => i.model), tasks: items, totalCost: 0, ...extra });
let n = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

// The log is written when the batch starts, so a reload mid-batch keeps it (it used to be written only by an in-memory
// timer once every task had finished, and a reload lost it).
test("a new batch's log lists every task, still running, at no cost yet", () => {
  const items = batchLogItems([task("a", { status: "pending" }), task("b", { status: "pending", price: 0.1 })]);
  assert.deepEqual(items.map(i => [i.id, i.model, i.status, i.cost]), [["a", "M-a", "pending", 0.04], ["b", "M-b", "pending", 0.1]]);
  assert.equal(isOpenLog(log(items)), true);
});

test("finishes a log once every task in it has finished, with outcomes and the cost of completed ones", () => {
  const open = log(batchLogItems([task("a"), task("b")]));
  const tasks = [task("a", { status: "completed", outputs: ["https://cdn/a.png"], wallClockMs: 9000 }), task("b", { status: "failed", error: "Generation failed" })];
  const [done] = finishLogs([open], tasks, NOW);
  assert.deepEqual(done.tasks.map(i => [i.id, i.status, i.outputs, i.error]), [["a", "completed", ["https://cdn/a.png"], null], ["b", "failed", [], "Generation failed"]]);
  assert.equal(done.totalCost, 0.04);
  assert.equal(isOpenLog(done), false);
  assert.deepEqual([done.id, done.timestamp, done.prompt], ["b", open.timestamp, "p"], "the rest of the entry is kept");
});

test("leaves a log open while any of its tasks is still running", () => {
  const open = log(batchLogItems([task("a"), task("b")]));
  assert.deepEqual(finishLogs([open], [task("a", { status: "completed", outputs: ["x"] }), task("b")], NOW), []);
});

test("finished and older logs (items without task ids) are never rewritten", () => {
  const old = log([{ model: "M", status: "completed", outputs: ["x"], cost: 0.04 }], { totalCost: 0.04 });
  assert.deepEqual(finishLogs([old], [], NOW), []);
  assert.equal(isOpenLog(old), false);
});

test("a task this device does not have yet keeps the log open; one gone past the 48 h window closes it", () => {
  const open = log(batchLogItems([task("a"), task("gone")]));
  const tasks = [task("a", { status: "completed", outputs: ["x"] })];
  assert.deepEqual(finishLogs([open], tasks, NOW), [], "may still arrive from another device");
  const [done] = finishLogs([{ ...open, timestamp: NOW - 49 * HOUR }], tasks, NOW);
  assert.deepEqual(done.tasks.map(i => i.status), ["completed", "failed"]);
  assert.match(done.tasks[1].error, /removed|expired/i);
});

test("queue bookkeeping: an upload clears only the version it sent", () => {
  const open = log(batchLogItems([task("a")]));
  const [done] = finishLogs([open], [task("a", { status: "completed", outputs: ["x"] })], NOW);
  assert.equal(sameLogContent(open, open), true);
  assert.equal(sameLogContent(open, done), false);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
