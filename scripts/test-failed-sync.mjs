// Tests for the failed-sync queue in src/lib/storage.js (localStorage). Run: node scripts/test-failed-sync.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const { addFailedSync, removeFailedSync, getFailedSyncs, sentVersion, dropQueuedUploads, rekeyFavoriteRetries, queueDeleteIntents, settleDeleteIntents, dropDeleteIntentsBefore,
  restoreGuard, markRestoreSeen, publishFormPaths, readFormPublications, pickTabId, tabPresence, confirmDeleteIntents, confirmedDeletes, intentGroups, deletesGoingSince } = await import("../src/lib/storage.js");

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

// Review round 3: the bootstrap marked every queued intent as "deleting" before the restore void ran, so voided ids
// stayed marked all session (restored rows hidden, their WaveSpeed copies not held). restoreGuard voids first and only
// then reports what is still pending; unreadable settings (null) mean "restore time unknown": nothing is dropped and
// the caller replays no delete intents.
test("restoreGuard: voids before it reports pending intents; unknown settings drop nothing", () => {
  const R = 1_000_000;
  const seed = () => localStorage.setItem("proximaai-failed-syncs", JSON.stringify([
    { kind: "task-delete", id: "a", data: "a", ts: R - 5 }, { kind: "task-delete", id: "b", data: "b", ts: R + 5 },
    { kind: "history-delete", id: "L", data: "L", ts: R - 5 }, { kind: "task", id: "up", data: { id: "up" }, ts: R - 5 }]));
  seed();
  assert.deepEqual(restoreGuard({ last_restore_at: R }),
    { known: true, fresh: true, restoreAt: R, voided: { task: ["a"], history: ["L"] }, pending: { task: ["b"], history: [] } });
  seed();
  assert.deepEqual(restoreGuard(null), { known: false, fresh: false, restoreAt: 0, voided: { task: [], history: [] }, pending: { task: ["a", "b"], history: ["L"] } });
  assert.equal(getFailedSyncs().length, 4, "unknown: queue untouched");
  assert.deepEqual(restoreGuard({}).voided, { task: [], history: [] }, "no restore recorded");
});

// Review round 3: a History rewrite queued before the restore (a delete trimming an entry) is dropped with the delete
// intents, while the restore is new to this device. Once the device has handled it (markRestoreSeen), nothing queued
// later is compared with it again: a device clock running behind can no longer void a delete made after the restore.
test("restoreGuard: a fresh restore also drops older History rewrites; a handled one drops nothing more", () => {
  const R = 2_000_000;
  localStorage.setItem("proximaai-failed-syncs", JSON.stringify([
    { kind: "history", id: "E", data: { id: "E" }, ts: R - 5 }, { kind: "history", id: "F", data: { id: "F" }, ts: R + 5 },
    { kind: "task", id: "t", data: { id: "t" }, ts: R - 5 }]));
  const g = restoreGuard({ last_restore_at: R });
  assert.equal(g.fresh, true);
  assert.deepEqual(getFailedSyncs().map(e => `${e.kind}:${e.id}`), ["history:F", "task:t"], "older rewrite dropped, task upload kept");
  markRestoreSeen(R);
  localStorage.setItem("proximaai-failed-syncs", JSON.stringify([
    { kind: "task-delete", id: "late", data: "late", ts: R - 60_000 }, { kind: "history", id: "G", data: { id: "G" }, ts: R - 60_000 }]));
  const g2 = restoreGuard({ last_restore_at: R });
  assert.equal(g2.fresh, false);
  assert.deepEqual(g2.voided, { task: [], history: [] });
  assert.equal(getFailedSyncs().length, 2, "a handled restore voids nothing queued later");
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

// Review round 2: a tab Chrome froze two days ago still holds its form's uploads, so another tab's publish keeps its
// key; only a key past the hold's 7-day life is pruned (fileDelete.js FORM_HOLD_ALIVE_MS).
test("publishFormPaths keeps a frozen tab's key for the hold's whole life, prunes it after", () => {
  const NOW = 10_000_000_000, DAY = 24 * 3600_000;
  mem.set("proximaai-form-inputs:frozen", JSON.stringify({ at: NOW - 2 * DAY, paths: ["uploads/u/a.png"] }));
  mem.set("proximaai-form-inputs:dead", JSON.stringify({ at: NOW - 8 * DAY, paths: ["uploads/u/b.png"] }));
  publishFormPaths(["uploads/u/c.png"], NOW);
  assert.deepEqual(readFormPublications().flatMap(p => p.paths).sort(), ["uploads/u/a.png", "uploads/u/c.png"]);
});

// Review round 5: a confirmed delete settles its intents and records when (per tab), for the restore release.
test("confirmDeleteIntents: settles the intents and records each id's confirmation time per kind", () => {
  queueDeleteIntents("task-delete", ["a", "b"]);
  const t0 = Date.now();
  confirmDeleteIntents("task-delete", ["a"]);
  assert.deepEqual(getFailedSyncs().map(e => e.id), ["b"]);
  const m = confirmedDeletes("task-delete");
  assert.ok(m.get("a") >= t0 && !m.has("b"));
  assert.equal(confirmedDeletes("history-delete").has("a"), false);
});

// Review round 5: a bulk delete's intents share one queue time, so the server-checked replay sends one call per
// action, not one per id; older per-id intents still group by their own time.
test("intentGroups: one group per queue time; queueDeleteIntents stamps one time for the whole action", () => {
  localStorage.setItem("proximaai-failed-syncs", JSON.stringify([
    { kind: "task-delete", id: "old1", data: "old1", ts: 5 }, { kind: "task-delete", id: "old2", data: "old2", ts: 6 },
    { kind: "history-delete", id: "h", data: "h", ts: 5 }]));
  queueDeleteIntents("task-delete", ["n1", "n2", "n3"]);
  const groups = intentGroups("task-delete");
  assert.deepEqual(groups.map(([, ids]) => ids), [["old1"], ["old2"], ["n1", "n2", "n3"]]);
  assert.deepEqual(intentGroups("history-delete"), [[5, ["h"]]]);
});

// Review round 6: confirmations are shared by the browser's tabs (another tab may have pre-loaded the intent this one
// confirmed), kept 30 days.
test("confirmedDeletes: another tab's confirmation is visible; entries older than 30 days are pruned", () => {
  const DAY = 24 * 3600_000;
  localStorage.setItem("proximaai-confirmed-deletes", JSON.stringify({ "task-delete": { other: Date.now() - DAY, ancient: Date.now() - 31 * DAY } }));
  assert.ok(confirmedDeletes("task-delete").has("other"), "written by another tab");
  confirmDeleteIntents("task-delete", ["mine"]);
  const m = confirmedDeletes("task-delete");
  assert.deepEqual([m.has("mine"), m.has("other"), m.has("ancient")], [true, true, false]);
});

// Review round 6: the WaveSpeed flush lets a row's own pending delete skip the cloud hold only when that intent was
// queued after the last restore (an older one is voided, and the restore kept the row); unknown restore time: none.
test("deletesGoingSince: task-delete intents queued at or after the restore; unknown restore time -> none", () => {
  localStorage.setItem("proximaai-failed-syncs", JSON.stringify([
    { kind: "task-delete", id: "old", data: "old", ts: 90 }, { kind: "task-delete", id: "new", data: "new", ts: 110 },
    { kind: "history-delete", id: "h", data: "h", ts: 120 }]));
  assert.deepEqual([...deletesGoingSince(100)], ["new"]);
  assert.deepEqual([...deletesGoingSince(0)].sort(), ["new", "old"], "no restore recorded: all");
  assert.deepEqual([...deletesGoingSince(null)], [], "restore time unknown: none");
});

// Review round 4: "restore handled" is per tab. Another tab marking the shared key must not stop this tab from adopting
// the restored History and releasing its own deleting ids.
test("restoreGuard: a restore another tab handled is still fresh in this tab until this tab marks it", () => {
  const R = 3_000_000;
  localStorage.setItem("proximaai-seen-restore", String(R));   // the other tab handled it
  assert.equal(restoreGuard({ last_restore_at: R }).fresh, true);
  markRestoreSeen(R);
  assert.equal(restoreGuard({ last_restore_at: R }).fresh, false);
});

// Review round 3: a tab Chrome killed while frozen left its form key holding its uploads for 7 days, because the page
// that reopened in that tab got a new id. The tab's id now lives in sessionStorage (kept across a discard or a kill),
// and the new page takes over the old key (its form starts empty, so the hold is released at once). A duplicated tab
// copies sessionStorage too: while the original still heartbeats (key fresh), the duplicate gets a new id.
test("pickTabId: a reopened tab takes over its key; a duplicate of a live tab gets a new one", () => {
  const NOW = 10_000_000;
  assert.equal(pickTabId(null, NaN, false, NOW, "new"), "new", "first load");
  assert.equal(pickTabId("old", NaN, false, NOW, "new"), "old", "reload after pagehide: key already gone");
  assert.equal(pickTabId("old", NOW - 3 * 3600_000, false, NOW, "new"), "old", "killed while frozen: stale key taken over");
  assert.equal(pickTabId("old", NOW - 30_000, false, NOW, "new"), "new", "duplicate of a live tab");
  assert.equal(pickTabId("old", NOW - 30_000, true, NOW, "new"), "old", "a discarded tab restored by Chrome");
});

// Review round 4: a tab killed and reopened within 2 minutes looked like a duplicate and kept its old hold for 7 days.
// A page that set the stored id aside asks the browser's other tabs; a live owner answers, a dead page cannot.
const presenceOk = await (async () => {
  try {
    const open = () => new BroadcastChannel("proximaai-tabs-test");
    const released = [];
    const a = tabPresence({ id: "A", open, release: (p) => released.push(p) });
    const b = tabPresence({ id: "B", prevId: "A", open, waitMs: 150, release: (p) => released.push(p) });
    const c = tabPresence({ id: "C", prevId: "dead", open, waitMs: 150, release: (p) => released.push(p) });
    await new Promise(r => setTimeout(r, 400));
    for (const ch of [a, b, c]) ch?.close();
    assert.deepEqual(released, ["dead"], "the live original keeps its key; the dead page's key is released");
    return true;
  } catch (e) { console.log("FAIL - tabPresence\n   ", e.message.split("\n")[0]); return false; }
})();
if (presenceOk) { n++; console.log("ok - tabPresence: a live original answers; a dead page's key is released"); } else failed++;

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
