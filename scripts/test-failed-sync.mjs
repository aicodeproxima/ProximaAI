// Tests for the failed-sync queue in src/lib/storage.js (localStorage). Run: node scripts/test-failed-sync.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const { addFailedSync, removeFailedSync, getFailedSyncs, sentVersion, dropQueuedUploads, rekeyFavoriteRetries } = await import("../src/lib/storage.js");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { mem.clear(); fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

// Review wf_d4a468a3-746 #7: a replay or upload that resolves after a newer version of the same row replaced its queue
// entry (the queue dedupes by kind+id) used to clear that newer version, so if its own upload then failed nothing
// was left to retry it.
test("a confirmed upload clears only the exact version it sent", () => {
  const open = { id: "b", tasks: [{ id: "a", status: "pending" }] };
  const done = { id: "b", tasks: [{ id: "a", status: "completed" }] };
  addFailedSync({ kind: "history", id: "b", data: open });
  addFailedSync({ kind: "history", id: "b", data: done });   // replaces it
  removeFailedSync("history", "b", sentVersion(open));        // the open upload resolves late
  assert.deepEqual(getFailedSyncs().map(e => e.data), [done], "the finished version stays queued");
  removeFailedSync("history", "b", sentVersion(done));
  assert.deepEqual(getFailedSyncs(), []);
});

test("without a version check (deletes), the entry is cleared whatever it holds", () => {
  addFailedSync({ kind: "task", id: "t", data: { id: "t", status: "completed" } });
  removeFailedSync("task", "t");
  assert.deepEqual(getFailedSyncs(), []);
});

// Review wf_1945b758-923 #1: Clear Outputs / Reset Everything left queued uploads behind; a generation whose upload had
// failed (never in the cloud, so no tombstone) was uploaded again by the next replay and came back on every device.
test("Clear drops every queued upload of the cleared kinds and says which ids they were", () => {
  addFailedSync({ kind: "task", id: "t1", data: { id: "t1" } });
  addFailedSync({ kind: "task", id: "t2", data: { id: "t2" } });
  addFailedSync({ kind: "history", id: "b1", data: { id: "b1" } });
  addFailedSync({ kind: "task-delete", id: "t0", data: "t0" });
  addFailedSync({ kind: "setting", id: "theme", data: "dark" });
  const dropped = dropQueuedUploads(["task"]);
  assert.deepEqual(dropped, { task: ["t1", "t2"] });
  assert.deepEqual(getFailedSyncs().map(e => `${e.kind}:${e.id}`), ["history:b1", "task-delete:t0", "setting:theme"],
    "deletes, History (Clear Outputs keeps it) and settings stay queued");
  assert.deepEqual(dropQueuedUploads(["task", "history"]), { task: [], history: ["b1"] });
  assert.deepEqual(getFailedSyncs().map(e => e.kind), ["task-delete", "setting"]);
});

// RLS design panel wf_89f53ef9-80f (2026-10-22): favorites retries are keyed by the account scope and replayed only for
// the current one, so after a rename an entry queued under the old name was never sent nor removed (status "error" for
// good, and that favorites change lost).
const fav = (scope, updatedAt) => ({ kind: "model-favorites", id: scope, scope, data: { byType: { image: [String(updatedAt)] }, updatedAt } });
test("after a rename, a favorites retry queued under the old name moves to the new name", () => {
  addFailedSync(fav("user:Old", 5));
  addFailedSync({ kind: "task", id: "t", data: { id: "t" } });
  rekeyFavoriteRetries("user:New");
  const q = getFailedSyncs();
  assert.deepEqual(q.filter(e => e.kind === "model-favorites").map(e => [e.id, e.scope, e.data.updatedAt]), [["user:New", "user:New", 5]]);
  assert.ok(q.some(e => e.kind === "task" && e.id === "t"), "other entries untouched");
});
test("when both names have a favorites retry, the newer snapshot wins and one entry remains", () => {
  addFailedSync(fav("user:New", 7));
  addFailedSync(fav("user:Old", 9));
  rekeyFavoriteRetries("user:New");
  assert.deepEqual(getFailedSyncs().map(e => [e.scope, e.data.updatedAt]), [["user:New", 9]]);
  mem.clear();
  addFailedSync(fav("user:New", 7));
  addFailedSync(fav("user:Old", 5));
  rekeyFavoriteRetries("user:New");
  assert.deepEqual(getFailedSyncs().map(e => [e.scope, e.data.updatedAt]), [["user:New", 7]]);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
