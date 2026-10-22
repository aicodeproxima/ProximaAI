// Tests for the failed-sync queue in src/lib/storage.js (localStorage). Run: node scripts/test-failed-sync.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const { addFailedSync, removeFailedSync, getFailedSyncs, sentVersion, dropQueuedUploads, rekeyFavoriteRetries, queueDeleteIntents, settleDeleteIntents, dropDeleteIntentsBefore } = await import("../src/lib/storage.js");

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

// Review wf_ec400a67-988 #2 (2026-10-22): the 200-entry cap evicted the oldest entries whatever they were, so a large
// clear's delete intents pushed each other (and History removals) out and those generations came back on reload.
// Review round 2: delete intents do not count toward the cap either, so 200+ queued deletes no longer push out every
// upload (a delete's History rewrites included).
test("delete intents are never evicted and do not count; the cap keeps 200 uploads", () => {
  for (let i = 0; i < 10; i++) addFailedSync({ kind: "task", id: "up" + i, data: { id: "up" + i } });
  for (let i = 0; i < 250; i++) addFailedSync({ kind: "task-delete", id: "d" + i, data: "d" + i });
  addFailedSync({ kind: "history-delete", id: "h0", data: "h0" });
  let q = getFailedSyncs();
  assert.equal(q.filter(e => e.kind === "task-delete").length, 250, "every task-delete kept");
  assert.ok(q.some(e => e.kind === "history-delete" && e.id === "h0"));
  assert.equal(q.filter(e => e.kind === "task").length, 10, "uploads are not pushed out by deletes");
  for (let i = 10; i < 205; i++) addFailedSync({ kind: "history", id: "up" + i, data: { id: "up" + i } });
  addFailedSync({ kind: "task", id: "late", data: { id: "late" } });
  q = getFailedSyncs();
  assert.equal(q.filter(e => !/-delete$/.test(e.kind)).length, 200, "200 uploads kept");
  assert.ok(q.some(e => e.id === "late"), "the newest upload is never the one dropped");
  assert.ok(!q.some(e => e.id === "up0"), "the oldest uploads go first");
  assert.equal(q.filter(e => /-delete$/.test(e.kind)).length, 251);
});

// Review wf_ec400a67-988 #1 (2026-10-22): a clear queues its delete intents in one write BEFORE the request fires, and
// settles only the ones the cloud confirmed.
test("a clear queues every delete intent in one write, and settles only the confirmed ones", () => {
  addFailedSync({ kind: "task", id: "keep-upload", data: { id: "keep-upload" } });
  addFailedSync({ kind: "task-delete", id: "a", data: "a" });
  queueDeleteIntents("task-delete", ["a", "b", "c", "", null]);
  assert.deepEqual(getFailedSyncs().filter(e => e.kind === "task-delete").map(e => e.id).sort(), ["a", "b", "c"], "deduped, empties skipped");
  settleDeleteIntents("task-delete", ["a", "c"]);
  assert.deepEqual(getFailedSyncs().map(e => `${e.kind}:${e.id}`), ["task:keep-upload", "task-delete:b"]);
  queueDeleteIntents("history-delete", Array.from({ length: 600 }, (_, i) => "h" + i));
  assert.equal(getFailedSyncs().filter(e => e.kind === "history-delete").length, 600, "a large clear is never capped");
});

// Review round 2: a restore (any device) voids the delete intents queued before it, so a clear still pending here
// cannot delete what the restore brought back. Newer intents and uploads stay.
test("a restore drops the delete intents queued before it, and says which ids it dropped", () => {
  const T = Date.now();
  addFailedSync({ kind: "task", id: "up", data: { id: "up" } });
  queueDeleteIntents("task-delete", ["old1", "old2"]);
  queueDeleteIntents("history-delete", ["oldL"]);
  const after = Date.now() + 5;
  const all = getFailedSyncs();
  for (const e of all) if (e.kind.endsWith("-delete")) e.ts = T - 1000;   // queued before the restore
  localStorage.setItem("proximaai-failed-syncs", JSON.stringify([...all, { kind: "task-delete", id: "new1", data: "new1", ts: after + 1000 }]));
  assert.deepEqual(dropDeleteIntentsBefore(after), { task: ["old1", "old2"], history: ["oldL"] });
  assert.deepEqual(getFailedSyncs().map(e => `${e.kind}:${e.id}`), ["task:up", "task-delete:new1"]);
  assert.deepEqual(dropDeleteIntentsBefore(0), { task: [], history: [] }, "no restore recorded: nothing dropped");
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
