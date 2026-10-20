// Tests for src/lib/batchLog.js — the History entry of a generation batch. Run: node scripts/test-batch-log.mjs
import assert from "node:assert/strict";
import { batchLogItems, finishLogs, isOpenLog, sameLogContent, closeRemovedItems, takeFinishedFromCloud } from "../src/lib/batchLog.js";

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

// Review wf_d4a468a3-746 #6/#8: deleting a task of a batch that is still running left the entry open for 48 h ($0, no
// images), then recorded the deleted task as failed even when it had completed. A deleted task's item is closed with
// its last known state at delete time; the entry then finishes as soon as the rest of the batch does.
test("deleting a task closes its item with its last state; the entry finishes with the rest of the batch", () => {
  const open = log(batchLogItems([task("a"), task("b")]));
  const doneA = task("a", { status: "completed", outputs: ["https://cdn/a.png"], wallClockMs: 5000 });
  const [closed] = closeRemovedItems([open], [doneA]);
  assert.deepEqual(closed.tasks.map(i => [i.id, i.status]), [["a", "completed"], ["b", "processing"]]);
  assert.equal(isOpenLog(closed), true, "b still running");
  const [done] = finishLogs([closed], [task("b", { status: "completed", outputs: ["https://cdn/b.png"] })], NOW);
  assert.deepEqual(done.tasks.map(i => i.status), ["completed", "completed"]);
  assert.equal(done.totalCost, 0.08, "the deleted task's cost still counts: it ran");
});

test("deleting a running task (Clear) closes its item as removed; entries without it are untouched", () => {
  const open = log(batchLogItems([task("a"), task("b")]));
  const [closed] = closeRemovedItems([open, log([], { id: "other" })], [task("a")]);
  assert.deepEqual(closed.tasks.map(i => [i.id, i.status]), [["a", "failed"], ["b", "processing"]]);
  assert.match(closed.tasks[0].error, /removed/i);
  assert.equal(closeRemovedItems([open], [task("zzz", { status: "completed" })]).length, 0);
});

// Webhook-session review (2026-10-20): every device closed for more than 48 h while the webhook completed the cloud row.
// On load the local copy expires as failed and the entry closes with that, then reconcile upgrades the task to the
// cloud's completed result. The closed entry has to follow, or History says expired / $0 next to a finished image.
test("a closed entry follows a task that later turns out completed (result from the cloud)", () => {
  const closed = log([{ id: "a", model: "M-a", status: "failed", error: "Expired", cost: 0.04, outputs: [], wallClockMs: 0 }], { totalCost: 0 });
  const [fixed] = finishLogs([closed], [task("a", { status: "completed", outputs: ["https://cdn/a.png"] })], NOW);
  assert.deepEqual([fixed?.tasks[0].status, fixed?.tasks[0].outputs, fixed?.totalCost], ["completed", ["https://cdn/a.png"], 0.04]);
  assert.deepEqual(finishLogs([fixed], [task("a", { status: "completed", outputs: ["https://cdn/a.png"] })], NOW), [], "settles");
  const stillFailed = finishLogs([closed], [task("a", { status: "failed", error: "Expired" })], NOW);
  assert.deepEqual(stillFailed, [], "a failure that stays a failure changes nothing");
});

// Regression review wf_9ad3cd3b-5c8 #3: another device finished the batch (and the entry) while this one was frozen;
// a stale local copy must take that outcome instead of closing the entry from its own stale tasks and overwriting it.
test("an entry still open here takes the finished outcome another device saved, keeping local-only fields", () => {
  const open = log(batchLogItems([task("a"), task("b")]), { sourceAudioUrl: "https://cdn/voice.mp3" });
  const cloudDone = { ...log([{ id: "a", status: "completed", cost: 0.04, outputs: ["x"] }, { id: "b", status: "completed", cost: 0.04, outputs: ["y"] }]), totalCost: 0.08 };
  const [merged] = takeFinishedFromCloud([open], [cloudDone]);
  assert.deepEqual([merged.tasks.map(i => i.status), merged.totalCost, merged.sourceAudioUrl], [["completed", "completed"], 0.08, "https://cdn/voice.mp3"]);
  assert.deepEqual(takeFinishedFromCloud([cloudDone], [open]), [], "a finished entry here never takes an open cloud copy");
  assert.deepEqual(takeFinishedFromCloud([{ ...cloudDone, totalCost: 0.04 }], [cloudDone]), [], "both finished: no ping-pong");
  assert.deepEqual(takeFinishedFromCloud([open], []), []);
});

// Round-4 review wf_f0f800c6-0ab #4: a device that closed an entry from stale copies while the cloud did not answer
// keeps that wrong version unless it also takes completed items from the cloud for closed entries (the server rule
// per item, mirrored here).
test("a closed entry here takes items the cloud records as completed, item by item", () => {
  const mine = { ...log([{ id: "a", status: "failed", error: "Expired", cost: 0.04, outputs: [] }, { id: "b", status: "completed", cost: 0.05, outputs: ["y"] }]), totalCost: 0.05 };
  const cloud = { ...log([{ id: "a", status: "completed", cost: 0.04, outputs: ["x"] }, { id: "b", status: "completed", cost: 0.05, outputs: ["y"] }]), totalCost: 0.09 };
  const [fixed] = takeFinishedFromCloud([mine], [cloud]);
  assert.deepEqual([fixed?.tasks.map(i => i.status), fixed?.totalCost], [["completed", "completed"], 0.09]);
  assert.deepEqual(takeFinishedFromCloud([cloud], [mine]), [], "a cloud failure never replaces a completed item here");
});

test("queue bookkeeping: an upload clears only the version it sent", () => {
  const open = log(batchLogItems([task("a")]));
  const [done] = finishLogs([open], [task("a", { status: "completed", outputs: ["x"] })], NOW);
  assert.equal(sameLogContent(open, open), true);
  assert.equal(sameLogContent(open, done), false);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
