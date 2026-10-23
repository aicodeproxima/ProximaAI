// Tests for the failed-sync queue in src/lib/storage.js (localStorage). Run: node scripts/test-failed-sync.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const { addFailedSync, removeFailedSync, getFailedSyncs, sentVersion, dropQueuedUploads, rekeyFavoriteRetries, queueDeleteIntents, settleDeleteIntents, dropDeleteIntentsBefore,
  restoreGuard, markRestoreSeen, publishFormPaths, readFormPublications, pickTabId, tabPresence, confirmDeleteIntents, confirmedDeletes, intentGroups, deletesGoingSince, forgetConfirmed, replaceQueuedUpload, pendingDeleteIds, peekQueuedUploads, takeQueuedUploads, putBackQueuedUploads,
  buildClearStash, writeClearStash, readClearStashes, dropClearStash, stashedItems, allStoredHistory, allStoredTasks,
  intentsPendingAt, readClearStash, stashGiveBack, forgetStashedIds, recordStashArchive, stashArchivePaths,
  chainStashFavorites, chainedFavoritesBefore, stashDecision, dropGivenBackStash, clearLogsStash, voidedTimes, stashTiedToVoided, pruneVoidedAt } = await import("../src/lib/storage.js");

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

// Review round 7: an action's queue time comes back to the caller, so its first send carries it (not the send time),
// and a new delete of an id forgets its older confirmation (a restore brought it back; it is going again).
test("queueDeleteIntents returns its queue time; forgetConfirmed drops older confirmations of these ids", () => {
  const ts = queueDeleteIntents("task-delete", ["q1", "q2"]);
  assert.ok(Number.isFinite(ts) && getFailedSyncs().filter(e => e.id === "q1" || e.id === "q2").every(e => e.ts === ts));
  confirmDeleteIntents("task-delete", ["q1", "q2"]);
  forgetConfirmed("task-delete", ["q1"]);
  assert.deepEqual([confirmedDeletes("task-delete").has("q1"), confirmedDeletes("task-delete").has("q2")], [false, true]);
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

// Review round 9: a delete whose History work the server does still trims an entry's queued upload: left as queued, the
// stale copy brought the deleted item back when it replayed (no tombstone named it when neither upload had landed).
test("replaceQueuedUpload: replaces a queued upload's data in place, keeping its queue time; nothing queued -> nothing added", () => {
  addFailedSync({ kind: "history", id: "E", data: { id: "E", tasks: [{ id: "X" }, { id: "Y" }] } });
  const before = getFailedSyncs()[0];
  assert.equal(replaceQueuedUpload("history", "E", { id: "E", tasks: [{ id: "Y" }] }), true);
  const after = getFailedSyncs()[0];
  assert.deepEqual([after.data.tasks, after.ts, after.attempts], [[{ id: "Y" }], before.ts, before.attempts]);
  assert.equal(replaceQueuedUpload("history", "F", { id: "F", tasks: [] }), false);
  assert.equal(getFailedSyncs().length, 1);
});

// Review round 10: Clear Outputs / Reset stamp their intents with the snapshot time taken before their purge read.
test("queueDeleteIntents stamps the given time and returns it; without one, the current server time", () => {
  assert.equal(queueDeleteIntents("task-delete", ["s1", "s2"], 12345), 12345);
  assert.deepEqual(getFailedSyncs().map(e => e.ts), [12345, 12345]);
  assert.equal(queueDeleteIntents("history-delete", [], 777), 777, "nothing queued: the time still comes back");
  const ts = queueDeleteIntents("task-delete", ["s3"]);
  assert.ok(Math.abs(ts - Date.now()) < 5000);
});
// Review round 10 (F2): only deletes still in flight keep a generation out of History uploads.
test("pendingDeleteIds: the ids with a queued intent of that kind; settled ones leave", () => {
  queueDeleteIntents("task-delete", ["p1", "p2"]);
  queueDeleteIntents("history-delete", ["L1"]);
  addFailedSync({ kind: "task", id: "up", data: { id: "up" } });
  assert.ok(pendingDeleteIds("task-delete") instanceof Set);
  assert.deepEqual([...pendingDeleteIds("task-delete")].sort(), ["p1", "p2"]);
  assert.deepEqual([...pendingDeleteIds("history-delete")], ["L1"]);
  confirmDeleteIntents("task-delete", ["p1"]);
  assert.deepEqual([...pendingDeleteIds("task-delete")], ["p2"], "a confirmed delete no longer counts");
});

// Review round 13 (A1/A5): clears read the queue before their snapshot, take only the planned ids, and a voided clear
// puts the exact entries back.
test("peekQueuedUploads: copies of the queued uploads of those kinds; nothing removed", () => {
  addFailedSync({ kind: "task", id: "t1", data: { id: "t1" } });
  addFailedSync({ kind: "history", id: "h1", data: { id: "h1" } });
  addFailedSync({ kind: "task-delete", id: "t0", data: "t0" });
  const peek = peekQueuedUploads(["task"]);
  assert.deepEqual(peek.map(e => `${e.kind}:${e.id}`), ["task:t1"]);
  peek[0].data.id = "changed"; peek[0].id = "changed";
  assert.equal(getFailedSyncs().length, 3, "nothing removed");
  assert.equal(getFailedSyncs()[0].id, "t1", "a copy: editing it leaves the queue alone");
  assert.deepEqual(peekQueuedUploads(["task", "history"]).map(e => e.id), ["t1", "h1"]);
  assert.deepEqual(peekQueuedUploads([]), []);
});
test("takeQueuedUploads: removes only that kind's entries with the named ids and returns them exactly", () => {
  addFailedSync({ kind: "task", id: "t1", data: { id: "t1", v: 1 } });
  addFailedSync({ kind: "task", id: "t2", data: { id: "t2" } });           // queued after the snapshot: not named
  addFailedSync({ kind: "history", id: "t1", data: { id: "t1" } });        // same id, other kind
  addFailedSync({ kind: "task-delete", id: "t1", data: "t1" });
  const before = getFailedSyncs()[0];
  const taken = takeQueuedUploads("task", ["t1", "nope"]);
  assert.deepEqual(taken, [before], "same ts, attempts and data");
  assert.deepEqual(getFailedSyncs().map(e => `${e.kind}:${e.id}`), ["task:t2", "history:t1", "task-delete:t1"]);
  assert.deepEqual(takeQueuedUploads("task", []), []);
  assert.equal(getFailedSyncs().length, 3);
});
test("putBackQueuedUploads: re-inserts the exact entries; a newer entry of the same kind+id wins", () => {
  addFailedSync({ kind: "task", id: "a", data: { id: "a", v: "old" } });
  addFailedSync({ kind: "task", id: "b", data: { id: "b", v: "old" } });
  addFailedSync({ kind: "history", id: "L", data: { id: "L" } });
  const taken = [...takeQueuedUploads("task", ["a", "b"]), ...takeQueuedUploads("history", ["L"])];
  assert.equal(getFailedSyncs().length, 0);
  addFailedSync({ kind: "task", id: "b", data: { id: "b", v: "new" } });   // queued after the take
  putBackQueuedUploads(taken);
  const q = getFailedSyncs();
  assert.deepEqual(q.map(e => `${e.kind}:${e.id}:${e.data.v ?? ""}`).sort(), ["history:L:", "task:a:old", "task:b:new"]);
  assert.deepEqual(q.find(e => e.id === "a"), taken.find(e => e.id === "a"), "same ts/attempts/data");
  putBackQueuedUploads(taken);
  assert.equal(getFailedSyncs().length, 3, "putting back twice adds nothing");
  putBackQueuedUploads([]); putBackQueuedUploads(undefined);
  assert.equal(getFailedSyncs().length, 3);
});

// Review round 14: a clear whose call got no answer and that a restore voids later, at a replay, lost the uploads it took
// and its local-only items (the in-memory copies died with the page). It stores them first, keyed by its queue time.
test("buildClearStash keeps only what the cloud cannot give back", () => {
  const uploads = [{ kind: "task", id: "q", data: { id: "q" }, ts: 1 }, { kind: "history", id: "Lq", data: { id: "Lq" }, ts: 1 }, null];
  const s = buildClearStash({ uploads, tasks: [{ id: "q" }, { id: "inCloud" }, { id: "local" }, null, {}],
    logs: [{ id: "Lq" }, { id: "Lc" }, { id: "Ll" }], cloudTaskIds: new Set(["inCloud"]), cloudLogIds: new Set(["Lc"]) });
  assert.deepEqual(s.uploads.map(e => e.id), ["q", "Lq"]);
  assert.deepEqual(s.tasks.map(t => t.id), ["local"], "cloud rows and items carried by a queued upload are left out");
  assert.deepEqual(s.logs.map(l => l.id), ["Ll"]);
  const noRead = buildClearStash({ logs: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual(noRead.logs.map(l => l.id), ["a", "b"], "no cloud read: every planned local item counts");
  assert.deepEqual(buildClearStash(), { uploads: [], tasks: [], logs: [] });
});
test("writeClearStash / readClearStashes / dropClearStash: one key per clear queue time, oldest first", () => {
  assert.equal(writeClearStash(200, { uploads: [{ kind: "task", id: "t", data: { id: "t" } }], tasks: [{ id: "x" }] }), true);
  assert.equal(writeClearStash(100, { logs: [{ id: "L" }] }), true);
  assert.equal(writeClearStash(NaN, {}), false);
  mem.set("proximaai-clear-stash:300", "{broken");
  mem.set("unrelated", "1");
  assert.ok(mem.has("proximaai-clear-stash:200"), "the key names the queue time");
  const all = readClearStashes();
  assert.deepEqual(all.map(s => s.at), [100, 200], "unparsable stash skipped");
  assert.deepEqual(all[1], { uploads: [{ kind: "task", id: "t", data: { id: "t" } }], tasks: [{ id: "x" }], logs: [], at: 200 });
  dropClearStash(100);
  assert.deepEqual(readClearStashes().map(s => s.at), [200]);
  assert.equal(mem.get("unrelated"), "1");
});
test("stashedItems: stashed items plus the taken uploads' data, each id once, none being deleted again", () => {
  const stash = { tasks: [{ id: "a" }], logs: [{ id: "L1" }],
    uploads: [{ kind: "task", id: "b", data: { id: "b" } }, { kind: "task", id: "gone", data: { id: "gone" } }, { kind: "history", id: "L2", data: { id: "L2" } },
      { kind: "model-favorites", id: "x", data: { id: "x" } }] };
  const r = stashedItems(stash, { deletingTasks: new Set(["gone"]) });
  assert.deepEqual(r.tasks.map(t => t.id), ["a", "b"]);
  assert.deepEqual(r.logs.map(l => l.id), ["L1", "L2"]);
  assert.deepEqual(stashedItems(null), { tasks: [], logs: [] });
});

// Review round 15 S1: a Reset's task group voided at its replay gave the stash back while the same reset's History
// intents were still pending, so stashedItems held back every History entry, and the stash was dropped: local-only
// History lost. Now nothing is given back while any intent at the clear's queue time is pending, in either kind.
test("round 15 S1: pendingDeleteIds(kind, { exceptAt }) and intentsPendingAt", () => {
  queueDeleteIntents("task-delete", ["a"], 100);
  queueDeleteIntents("history-delete", ["L"], 100);
  queueDeleteIntents("history-delete", ["L2"], 200);
  assert.deepEqual([...pendingDeleteIds("history-delete")].sort(), ["L", "L2"]);
  assert.deepEqual([...pendingDeleteIds("history-delete", { exceptAt: 100 })], ["L2"]);
  assert.deepEqual([...pendingDeleteIds("task-delete", { exceptAt: 100 })], []);
  assert.equal(intentsPendingAt(100), true);
  assert.equal(intentsPendingAt(300), false);
  assert.equal(intentsPendingAt(NaN), false);
  settleDeleteIntents("task-delete", ["a"]);
  assert.equal(intentsPendingAt(100), true, "the History intent at 100 is still pending");
  settleDeleteIntents("history-delete", ["L"]);
  assert.equal(intentsPendingAt(100), false);
});
test("round 15 S1: a Reset voided group by group gives its stash back only after the last group, History included", () => {
  writeClearStash(100, { tasks: [{ id: "a" }], logs: [{ id: "L" }, { id: "L2" }], uploads: [{ kind: "history", id: "Lq", data: { id: "Lq" } }] });
  queueDeleteIntents("task-delete", ["a"], 100);
  queueDeleteIntents("history-delete", ["L", "L2", "Lq"], 100);
  queueDeleteIntents("history-delete", ["L2"], 200);   // a later delete of the same entry (another queue time)
  const s = () => readClearStashes().find(x => x.at === 100);
  assert.equal(stashGiveBack(s()), null, "both groups pending");
  settleDeleteIntents("task-delete", ["a"]);            // the task group is voided first
  assert.equal(stashGiveBack(s()), null, "the History group of the same reset is still pending: nothing yet");
  settleDeleteIntents("history-delete", ["L", "Lq"]);   // then the History group (L2 at 200 stays queued: it is ANOTHER delete)
  const back = stashGiveBack(s());
  assert.ok(back);
  assert.deepEqual(back.tasks.map(t => t.id), ["a"]);
  assert.deepEqual(back.logs.map(l => l.id), ["L", "Lq"], "local-only History comes back; L2 is being deleted by the later delete");
  assert.deepEqual(back.uploads.map(e => e.id), ["Lq"]);
  assert.equal(back.favorites, null);
  assert.equal("orphanPaths" in back, false, "round 19 #2: nothing is orphaned any more");
  assert.equal(stashGiveBack(null), null);
});
// S2: confirmed ids stayed in the stash, so a later void gave back items whose delete already succeeded.
test("round 15 S2: a confirmed delete leaves every stash (items and taken uploads), only its kind", () => {
  writeClearStash(100, { tasks: [{ id: "a" }, { id: "b" }], logs: [{ id: "a" }, { id: "L" }],
    uploads: [{ kind: "task", id: "a", data: { id: "a" } }, { kind: "history", id: "a", data: { id: "a" } }, { kind: "task", id: "c", data: { id: "c" } }] });
  writeClearStash(200, { tasks: [{ id: "a" }] });
  queueDeleteIntents("task-delete", ["a", "b", "c"], 100);
  assert.deepEqual(confirmDeleteIntents("task-delete", ["a", "c"]), [], "no archive held: no paths");
  const s1 = readClearStash(100), s2 = readClearStash(200);
  assert.deepEqual(s1.tasks.map(t => t.id), ["b"]);
  assert.deepEqual(s1.logs.map(l => l.id), ["a", "L"], "a History entry with the same id is another kind: kept");
  assert.deepEqual(s1.uploads.map(e => `${e.kind}:${e.id}`), ["history:a"]);
  assert.deepEqual(s2.tasks, []);
  confirmDeleteIntents("history-delete", ["L"]);
  assert.deepEqual(readClearStash(100).logs.map(l => l.id), ["a"]);
  assert.deepEqual(forgetStashedIds("model-favorites", ["x"]), []);
  assert.deepEqual(forgetStashedIds("task-delete", []), []);
  assert.equal(readClearStash(999), null);
});
// S3: a Reset's favorites came back only in the inline voided branch; a later void left them empty.
test("round 15 S3: a stash carries a Reset's favorites state and gives it back", () => {
  const favorites = { scope: "user:owner", byType: { t2i: ["m1"] }, updatedAt: 5, setting: { byType: { t2i: ["m1"] }, updatedAt: 5 },
    queued: [{ kind: "model-favorites", id: "user:owner", scope: "user:owner", data: { updatedAt: 5 } }], resetAt: 9 };
  writeClearStash(100, { tasks: [], favorites });
  assert.deepEqual(readClearStash(100).favorites, favorites);
  assert.deepEqual(stashGiveBack(readClearStash(100)).favorites, favorites);
  writeClearStash(101, { tasks: [] });
  assert.equal("favorites" in readClearStash(101), false, "absent unless a Reset stored it");
});
// S5: an archive that finished while a clear held its task was thrown away, and the task came back stuck as archiving.
test("round 15 S5: recordStashArchive records against the clear whose intent holds the task", () => {
  writeClearStash(100, { tasks: [{ id: "a", archiving: true }] });
  assert.equal(recordStashArchive("a", { paths: ["p1"], task: { id: "a", isArchived: true } }), false, "no pending intent: not held");
  queueDeleteIntents("task-delete", ["a"], 100);
  queueDeleteIntents("task-delete", ["z"], 300);   // no stash at 300
  assert.equal(recordStashArchive("z", { paths: ["pz"], task: null }), false, "no stash: the caller deletes the files");
  assert.equal(recordStashArchive("a", { paths: ["p1"], task: { id: "a", isArchived: true } }), true);
  assert.equal(recordStashArchive("a", { paths: ["p2"], task: null }), true);
  assert.deepEqual(readClearStash(100).archives, { a: { task: { id: "a", isArchived: true }, paths: ["p1", "p2"] } }, "paths merged, archived version kept");
  assert.deepEqual(stashArchivePaths(readClearStash(100)), ["p1", "p2"]);
  assert.equal(recordStashArchive("", {}), false);
});
test("round 15 S5: confirm returns a held archive's paths; a void gives it back; deleted again elsewhere it stays kept", () => {
  queueDeleteIntents("task-delete", ["a", "b"], 100);
  writeClearStash(100, { tasks: [{ id: "a" }, { id: "b" }] });
  recordStashArchive("a", { paths: ["pa"], task: { id: "a" } });
  recordStashArchive("b", { paths: ["pb"], task: { id: "b" } });
  assert.deepEqual(confirmDeleteIntents("task-delete", ["a"]), ["pa"], "confirmed: its files go to the file-delete queue");
  assert.deepEqual(Object.keys(readClearStash(100).archives), ["b"]);
  settleDeleteIntents("task-delete", ["b"]);   // voided
  const back = stashGiveBack(readClearStash(100));
  assert.deepEqual(Object.keys(back.archives), ["b"]);
  assert.deepEqual(back.tasks.map(t => t.id), ["b"]);
  // Round 19 #2 rewrote this part: b deleted again at 200 (with or without a stash there): the record used to move to
  // 200's stash or be orphaned (its paths deleted while 200 was pending). It now stays in 100's kept part, for 200.
  for (const withStash of [true, false]) {
    mem.clear();
    queueDeleteIntents("task-delete", ["b"], 200);
    writeClearStash(100, { tasks: [{ id: "b" }], archives: { b: { task: { id: "b" }, paths: ["pb"] } } });
    if (withStash) writeClearStash(200, { tasks: [] });
    const held = stashGiveBack(readClearStash(100));
    assert.deepEqual(held.archives, {}, "not given back while 200 is pending");
    assert.equal("orphanPaths" in held, false);
    dropGivenBackStash(readClearStash(100));
    assert.deepEqual(readClearStash(100).archives.b.paths, ["pb"], "kept in 100's stash");
    assert.deepEqual(readClearStash(100).movedTo, [200], "the kept part follows 200");
    if (withStash) assert.equal(readClearStash(200).archives, undefined, "nothing moved into 200's stash");
  }
});

// Review round 16 #5: two unanswered Resets in a row (the toast asks for the second), both voided by one restore, left the
// favorites empty and stamped with the first reset's time. Reset B read its favoritesBefore from the refs A had emptied,
// and settleClearStashes dropped A's stash once its ids had moved to B (queueDeleteIntents re-queues an id at the newer
// time). This replays the critic's reproduction (r16-correctness/fav.mjs) with the real helpers; the App.jsx parts
// (restoreStashedFavorites' condition, the applyClearStashes loop, settleClearStashes) are mirrored as they now read.
const favoritesRig = () => {
  const ref = { byType: { image: ["m1", "m2"] }, updatedAt: 500, setting: { byType: { image: ["m1", "m2"] }, updatedAt: 500 },
    queued: [{ kind: "model-favorites", id: "user:o", data: { updatedAt: 500 } }] };
  const restoreStashedFavorites = (fav) => {
    if (!fav || !(fav.resetAt > 0) || ref.updatedAt !== fav.resetAt) return null;
    ref.byType = fav.byType; ref.updatedAt = fav.updatedAt || 0; ref.setting = fav.setting; putBackQueuedUploads(fav.queued || []);
    return fav;
  };
  const applyClearStashes = (which) => {
    for (const s of readClearStashes()) {
      if (!which(s.at)) continue;
      const back = stashGiveBack(s);
      if (!back) continue;
      putBackQueuedUploads(back.uploads);
      restoreStashedFavorites(back.favorites);
      dropGivenBackStash(s);
    }
  };
  const settleClearStashes = () => {   // round 18 #3 / task B5: decided once nothing is pending at its times (stashDecision)
    const voided = voidedTimes();
    const back = new Set(readClearStashes().filter(s => stashDecision(s, voided) === "give-back").map(s => s.at));
    if (back.size) applyClearStashes(at => back.has(at));
    for (const s of readClearStashes()) if (stashDecision(s, voided) === "drop") {
      dropClearStash(s.at);
    }
    pruneVoidedAt();
  };
  // App.jsx Reset: favoritesBefore (chained), the local reset, the stash, the take, the intents.
  const reset = (at, cloudIds, { uploads = [] } = {}) => {
    const before = chainedFavoritesBefore({ byType: ref.byType, updatedAt: ref.updatedAt, queued: getFailedSyncs().filter(e => e.kind === "model-favorites"), setting: ref.setting }, "user:o");
    ref.byType = { image: [] }; ref.updatedAt = at; ref.setting = { byType: { image: [] }, updatedAt: at };
    removeFailedSync("model-favorites", "user:o");
    writeClearStash(at, { ...buildClearStash({ uploads }), favorites: { scope: "user:o", byType: before.byType, updatedAt: before.updatedAt,
      setting: before.setting ?? null, queued: before.queued, resetAt: at } });
    takeQueuedUploads("history", uploads.map(e => e.id));
    queueDeleteIntents("task-delete", cloudIds, at);
  };
  return { ref, reset, applyClearStashes, settleClearStashes };
};
test("round 16 #5: two Resets voided together give back the original favorites (both stashes given back)", () => {
  const rig = favoritesRig();
  addFailedSync({ kind: "model-favorites", id: "user:o", data: { updatedAt: 500 } });
  rig.reset(1000, ["t1", "t2"]);
  queueDeleteIntents("task-delete", ["local-only"], 1000);   // A keeps an intent of its own: both stashes stay
  rig.reset(2000, ["t1", "t2"]);
  assert.equal(readClearStash(2000).favorites.updatedAt, 500, "B's stash carries A's favoritesBefore, not A's emptied state");
  assert.deepEqual(readClearStash(2000).favorites.byType, { image: ["m1", "m2"] });
  assert.equal(readClearStash(2000).favorites.resetAt, 2000, "resetAt is the new reset's time");
  assert.deepEqual(readClearStash(2000).favorites.queued.map(e => e.id), ["user:o"], "A's queued upload entry travels with it");
  rig.settleClearStashes();
  assert.deepEqual(readClearStashes().map(s => s.at), [1000, 2000], "both pending: both kept");
  dropDeleteIntentsBefore(3000);
  rig.applyClearStashes(at => at < 3000);
  assert.deepEqual(rig.ref.byType, { image: ["m1", "m2"] });
  assert.equal(rig.ref.updatedAt, 500, "the original favorites at their original updatedAt");
  assert.deepEqual(getFailedSyncs().filter(e => e.kind === "model-favorites").map(e => e.data.updatedAt), [500], "the queued upload is back, once");
  assert.deepEqual(readClearStashes(), []);
});
// Task B5: this asserted the merge itself (A's stash moved INTO B's, moveClearStash). It now asserts the outcome: A's
// stash is neither moved nor dropped while B is pending, and B's void gives back A's upload and items and the original
// favorites; B's confirm drops A's stash with its archive paths, and gives nothing back.
test("round 16 #5: a Reset whose ids all moved to a pending Reset keeps its stash until that one answers", () => {
  const rig = favoritesRig();
  addFailedSync({ kind: "history", id: "h1", data: { id: "h1" } });
  rig.reset(1000, ["t1", "t2"], { uploads: peekQueuedUploads(["history"]) });
  writeClearStash(1000, { ...readClearStash(1000), tasks: [{ id: "loc" }], archives: { t1: { task: { id: "t1" }, paths: ["p1"] } } });
  rig.reset(2000, ["t1", "t2"]);   // B's cloud read still held t1, t2: A's intents moved to 2000
  assert.equal(intentsPendingAt(1000), false);
  assert.deepEqual(readClearStash(1000).movedTo, [2000], "the move is recorded on A's stash");
  assert.equal(stashDecision(readClearStash(1000)), "wait");
  rig.settleClearStashes();        // B's replay failed: B is still pending
  const a = readClearStash(1000);
  assert.ok(a, "A's stash is not dropped");
  assert.deepEqual(a.uploads.map(e => e.id), ["h1"], "A's taken upload stays in A's stash");
  assert.deepEqual(a.tasks.map(t => t.id), ["loc"]);
  assert.deepEqual(a.archives.t1.paths, ["p1"]);
  assert.equal(readClearStash(2000).uploads.length, 0, "nothing moved into B's stash");
  assert.equal(readClearStash(2000).favorites.updatedAt, 500, "B's own favorites are the chained original");
  dropDeleteIntentsBefore(3000);
  rig.applyClearStashes(at => at < 3000);
  assert.deepEqual(rig.ref.byType, { image: ["m1", "m2"] });
  assert.equal(rig.ref.updatedAt, 500, "the original favorites at their original updatedAt");
  assert.deepEqual(getFailedSyncs().filter(e => e.kind === "history").map(e => e.id), ["h1"], "A's upload given back");
  assert.deepEqual(readClearStashes(), []);
});
test("round 16 #5 / task B5: the same Resets, B confirmed: A's stash is dropped by the settle pass, nothing comes back", () => {
  const rig = favoritesRig();
  addFailedSync({ kind: "history", id: "h1", data: { id: "h1" } });
  rig.reset(1000, ["t1", "t2"], { uploads: peekQueuedUploads(["history"]) });
  rig.reset(2000, ["t1", "t2"]);
  rig.settleClearStashes();
  confirmDeleteIntents("task-delete", ["t1", "t2"]); dropClearStash(2000);   // B's inline ok
  assert.equal(stashDecision(readClearStash(1000)), "drop");
  rig.settleClearStashes();
  assert.deepEqual(readClearStashes(), []);
  assert.deepEqual(getFailedSyncs().filter(e => e.kind === "history"), [], "the taken upload stays taken");
  assert.deepEqual(rig.ref.byType, { image: [] }, "the favorites stay reset");
});
test("round 16 #5: chainStashFavorites / chainedFavoritesBefore / stashDecision + dropGivenBackStash edges", () => {
  const older = { scope: "s", byType: { a: ["x"] }, updatedAt: 5, setting: { v: 1 }, queued: [{ id: "s" }], resetAt: 10 };
  assert.deepEqual(chainStashFavorites({ scope: "s", byType: {}, updatedAt: 10, setting: null, queued: [], resetAt: 20 }, older),
    { ...older, resetAt: 20 }, "the newer reset replaced the older one's emptied state: the older state, newer time");
  const chosen = { scope: "s", byType: { a: ["y"] }, updatedAt: 15, setting: null, queued: [], resetAt: 20 };
  assert.deepEqual(chainStashFavorites(chosen, older), chosen, "a choice made in between wins");
  assert.deepEqual(chainStashFavorites(null, older), older);
  assert.equal(chainStashFavorites(null, null), null);
  const before = { byType: {}, updatedAt: 10, setting: null, queued: [] };
  assert.deepEqual(chainedFavoritesBefore(before, "s"), before, "no stash: unchanged");
  writeClearStash(100, { favorites: older });
  assert.equal(chainedFavoritesBefore(before, "s").updatedAt, 5);
  assert.deepEqual(chainedFavoritesBefore(before, "s").queued, [{ id: "s" }]);
  assert.deepEqual(chainedFavoritesBefore(before, "other"), before, "another scope's reset is not this one's");
  assert.deepEqual(chainedFavoritesBefore({ ...before, updatedAt: 11 }, "s").updatedAt, 11, "favorites changed since: unchanged");
  // Task B5 (was moveClearStash: "created at the pending target", A's key dropped): the chain of moves is recorded, the
  // stash stays under its own key and waits; nothing is created at the target.
  mem.clear();
  writeClearStash(100, { tasks: [{ id: "a" }] });
  assert.equal(stashDecision(readClearStash(100)), "drop", "no move recorded, nothing pending: confirmed");
  queueDeleteIntents("task-delete", ["a"], 100);
  assert.equal(stashDecision(readClearStash(100)), "wait");
  queueDeleteIntents("task-delete", ["a"], 300);   // a plain delete (no stash) re-queues it
  assert.deepEqual(readClearStash(100).movedTo, [300]);
  queueDeleteIntents("task-delete", ["a"], 400);   // and again: the chain follows (300 had no stash)
  assert.deepEqual(readClearStash(100).movedTo, [300, 400]);
  assert.equal(stashDecision(readClearStash(100)), "wait", "400 pending");
  assert.equal(readClearStash(400), null, "nothing is created at the pending target");
  // dropGivenBackStash: with a movedTo time pending, only what belongs to ids pending at another time stays.
  writeClearStash(100, { ...readClearStash(100), tasks: [{ id: "a" }, { id: "x" }], uploads: [{ kind: "task", id: "a", data: { id: "a" } }, { kind: "task", id: "x", data: { id: "x" } }], favorites: { resetAt: 1 } });
  dropGivenBackStash(readClearStash(100));
  const kept = readClearStash(100);
  assert.deepEqual(kept.tasks.map(t => t.id), ["a"], "x is not pending anywhere: it was given back");
  // Round 19 #2: was "uploads were put back by the give-back" (all of them, a's included); a's upload now stays kept.
  assert.deepEqual(kept.uploads.map(e => e.id), ["a"], "a's upload stays with a (pending at 400); x's was given back");
  assert.equal("favorites" in kept, false);
  assert.deepEqual(kept.movedTo, [300, 400]);
  settleDeleteIntents("task-delete", ["a"]);
  assert.equal(stashDecision(readClearStash(100), new Set()), "drop", "nothing pending, nothing voided");
  dropGivenBackStash(readClearStash(100));
  assert.equal(readClearStash(100), null, "nothing pending: dropped");
  dropGivenBackStash(null);
});

// Review round 16 #6: Clear Logs treated savedLogIds ("stored here") as "the cloud has it", so a saved entry with no
// queued upload (evicted at the 200 cap, or dropped by a restore) was never stashed, and a later void lost it.
test("round 16 #6: Clear Logs stashes every planned entry the cloud lacks; the cloud's are left out", () => {
  const loaded = [{ id: "savedNoUpload" }, { id: "inCloud" }, { id: "queued" }, { id: "late" }];
  const stored = [{ id: "inCloud" }, { id: "storedOnly" }, { id: "storedInCloud" }];
  const uploads = [{ kind: "history", id: "queued", data: { id: "queued", v: 2 } }];
  const planned = new Set(["savedNoUpload", "inCloud", "queued", "storedOnly", "storedInCloud"]);
  const { full, loadedOnly } = clearLogsStash({ loaded, stored, uploads, planned, cloudLogIds: new Set(["inCloud", "storedInCloud"]) });
  assert.deepEqual(full.logs.map(l => l.id), ["savedNoUpload", "storedOnly"], "absent from the cloud, no upload: stashed (saved or not)");
  assert.deepEqual(full.uploads.map(e => e.id), ["queued"], "a queued one is carried by its upload");
  assert.deepEqual(loadedOnly.logs.map(l => l.id), ["savedNoUpload"], "the quota fallback keeps the loaded ones");
  const noRead = clearLogsStash({ loaded, stored, uploads, planned, cloudLogIds: null });
  assert.deepEqual(noRead.full.logs.map(l => l.id), ["savedNoUpload", "inCloud", "storedOnly", "storedInCloud"], "no cloud read: every planned entry without a stashed upload");
  // A later void gives the saved-but-unqueued entry back.
  writeClearStash(100, full);
  queueDeleteIntents("history-delete", [...planned], 100);
  assert.equal(stashGiveBack(readClearStash(100)), null, "pending: nothing yet");
  dropDeleteIntentsBefore(200);   // a restore at 200 voids the clear
  const back = stashGiveBack(readClearStash(100));
  assert.deepEqual(back.logs.map(l => l.id).sort(), ["queued", "savedNoUpload", "storedOnly"]);
  assert.ok(!back.logs.some(l => l.id === "inCloud"), "the restore gives back what the cloud had");
});

// Review round 14: Clear Logs / Reset plan over every stored entry, not only the 500 loaded. Without IndexedDB (node)
// History falls back to localStorage and tasks to none.
mem.clear();
mem.set("proximaai-logs", JSON.stringify([{ id: "a" }, null, { id: "b" }]));
try {
  assert.deepEqual((await allStoredHistory()).map(l => l.id), ["a", "b"]);
  assert.deepEqual(await allStoredTasks(), []);
  mem.clear();
  assert.deepEqual(await allStoredHistory(), []);
  n++; console.log("ok - allStoredHistory / allStoredTasks fall back without IndexedDB");
} catch (e) { failed++; console.log("FAIL - allStoredHistory / allStoredTasks fallback\n   ", e.message); }

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
