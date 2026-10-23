// Task B7a (review round 20 #1, #3, #4, #5, #8): the SHARED delete state (the failed-sync queue's delete intents and the
// confirmed-deletes record, both in localStorage and shared by every tab) decides every upload and what "being deleted"
// means. React state and refs are per tab and may be stale (a frozen background tab), so a tab's own deletingIds alone
// never decide. Runs the real storage.js and syncReconcile.js. Run: node scripts/test-shared-delete-state.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const C = await import("../src/lib/serverClock.js");
const S = await import("../src/lib/storage.js");
const R = await import("../src/lib/syncReconcile.js");
const R2 = R;

let n = 0, failed = 0;
const test = (name, fn) => {
  try { mem.clear(); fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

const OLD = Date.now() - 10 * 60 * 1000;
const X = { id: "x", status: "completed", startTime: OLD, endTime: OLD + 1000, outputs: ["u"] };
const L1 = { id: "L1", timestamp: OLD, tasks: [{ id: "x" }] };
const NONE = () => ({ tasks: new Set(), history: new Set(), taskTombstones: new Set(), historyTombstones: new Set() });
const queued = (kind) => S.getFailedSyncs().filter(e => e.kind === kind).map(e => e.id);

// One tab's reconcile pass as App.jsx reconcileWithCloud builds it: the pass start (sequence + time), the shared state
// per kind (sharedDeleteState), then the real plans with `deleting` = that state's set.
function pass(tab, { local = [], logs = [], cloud = [], cloudLogs = [], ids = NONE(), sinceSeq = S.confirmSeqNow(), since = C.serverNow() } = {}) {
  for (const id of S.settledDeletingIds(tab.deleting, "task-delete", tab.holds)) tab.deleting.delete(id);
  for (const id of S.settledDeletingIds(tab.deletingLogs, "history-delete", tab.logHolds)) tab.deletingLogs.delete(id);
  const t = S.sharedDeleteState("task", { deleting: tab.deleting, cloudIds: ids.tasks, sinceSeq });
  const h = S.sharedDeleteState("history", { deleting: tab.deletingLogs, cloudIds: ids.history, sinceSeq });
  const failed = S.getFailedSyncs();
  const pending = new Set(failed.filter(f => f.kind === "task").map(f => f.id));
  const pendingLogs = new Set(failed.filter(f => f.kind === "history").map(f => f.id));
  const taskPlan = R.planTaskSync({ local, cloud, cloudIds: ids.tasks, tombstones: ids.taskTombstones, pending, deleting: t.deleting, since });
  const logPlan = R.planLogSync({ local: logs, cloud: cloudLogs, cloudIds: ids.history, tombstones: ids.historyTombstones, pending: pendingLogs, deleting: h.deleting, since });
  return { t, h, taskPlan, logPlan,
    upload: S.uploadable("task", taskPlan.upload).map(r => r.id), logUpload: S.uploadable("history", logPlan.upload).map(r => r.id),
    staleTasks: t.stale(local), staleLogs: h.stale(logs) };
}
const tab = () => ({ deleting: new Set(), deletingLogs: new Set(), holds: new Map(), logHolds: new Map() });

// r20 p1-stale-tab-reconcile (#5): x and L1 failed to upload (queued, never in the cloud). Tab A deletes both and the
// cloud confirms. Tab B (its state still holds x and L1, its deletingIds never did) must not upload them, and drops
// its stale copies.
test("#5 stale tab B never uploads x / L1 after tab A confirmed their deletes; its stale copies go", () => {
  S.addFailedSync({ kind: "history", id: "L1", data: L1 });
  S.addFailedSync({ kind: "task", id: "x", data: X });
  S.removeFailedSync("task", "x"); S.queueDeleteIntents("task-delete", ["x"]);
  S.removeFailedSync("history", "L1"); S.queueDeleteIntents("history-delete", ["L1"]);
  S.confirmDeleteIntents("task-delete", ["x"]); S.confirmDeleteIntents("history-delete", ["L1"]);
  const p = pass(tab(), { local: [X], logs: [L1] });
  assert.deepEqual(p.taskPlan.upload.map(r => r.id), [], "taskPlan.upload");
  assert.deepEqual(p.logPlan.upload.map(r => r.id), [], "logPlan.upload");
  assert.deepEqual([p.staleTasks, p.staleLogs], [["x"], ["L1"]], "tab B's stale copies are removed");
  // Even a direct queue attempt of the stale copy is refused (the last guard), so no replay can send it.
  S.addFailedSync({ kind: "task", id: "x", data: X }); S.addFailedSync({ kind: "history", id: "L1", data: L1 });
  assert.deepEqual([queued("task"), queued("history")], [[], []]);
});

// r20 #3 (stale-tab-reupload): frozen tab A still holds x; tab B deleted it and the cloud confirmed. A thaws.
test("#3 frozen tab A after tab B's confirmed delete: no upload, its copy goes; a pending delete in B also blocks", () => {
  const a = tab();
  // B's delete still in flight: x has a pending intent in the shared queue (A's deletingIds never held it).
  S.queueDeleteIntents("task-delete", ["x"]);
  let p = pass(a, { local: [X] });
  assert.deepEqual(p.upload, [], "pending in another tab: not uploaded");
  assert.ok(p.t.deleting.has("x"), "pending in the shared queue counts as being deleted here");
  assert.deepEqual(p.staleTasks, [], "a pending delete may still be voided: the copy stays");
  // B's delete is confirmed.
  S.confirmDeleteIntents("task-delete", ["x"]);
  p = pass(a, { local: [X] });
  assert.deepEqual(p.taskPlan.upload.map(r => r.id), [], "confirmed: not uploaded");
  assert.deepEqual(p.staleTasks, ["x"], "and A's stale copy goes");
  // The cloud ids unread: nothing is removed (unknown whether a restore brought it back), still nothing uploaded.
  p = pass(a, { local: [X], ids: { tasks: null, history: null, taskTombstones: null, historyTombstones: null } });
  assert.deepEqual([p.staleTasks, p.upload], [[], []]);
});

// r20 since-offset-drop (#4): a delete confirmed after the pass started (its cloud read still held the row) is never
// released by that pass, whatever the clock offset does between the pass start and the confirm.
test("#4 a confirm after the pass start is never released, even when the server-clock offset drops meanwhile", () => {
  const t0 = Date.now();
  C.noteServerDate(new Date(t0 + 5_000).toUTCString(), t0 - 1200, t0);   // a slow sample: offset about +5 s
  const a = tab(); a.deleting.add("x");
  S.queueDeleteIntents("task-delete", ["x"]);
  const sinceSeq = S.confirmSeqNow(), since = C.serverNow();             // the pass starts
  const t1 = Date.now();
  C.noteServerDate(new Date(t1 - 30_000).toUTCString(), t1 - 20, t1);    // its quick read: offset drops by ~35 s
  S.confirmDeleteIntents("task-delete", ["x"]);                          // the delete answers during the pass
  assert.ok(S.confirmedDeletes("task-delete").get("x") < since, "the server-time stamp is now BEFORE since");
  const cloudIds = new Set(["x"]);                                       // the pass read x before the server deleted it
  const p = pass(a, { cloud: [X], ids: { ...NONE(), tasks: cloudIds }, sinceSeq, since });
  assert.deepEqual(p.t.released, [], "not released");
  assert.ok(S.confirmedDeletes("task-delete").has("x"), "the confirm record stays");
  assert.deepEqual(p.taskPlan.add.map(r => r.id), [], "the just-deleted generation is not re-added");
  // The next pass (started after the confirm) sees the cloud without x: nothing to release, nothing to add.
  const q = pass(a, { cloud: [], ids: NONE() });
  assert.deepEqual([q.t.released, q.taskPlan.add], [[], []]);
});

// r20 p4-release-stuck (#8): A's Clear Outputs queued x at T1, B's delete queued it at T2; a restore voids both; A's
// void ran first (x pending at T2, kept), B's second. A's next pass releases x: nothing pending, nothing in flight.
test("#8 a tab releases x on its next pass once no intent is pending anywhere and none of its calls is in flight", () => {
  const releaseVoided = (set, kind, ids) => { const still = S.pendingDeleteIds(kind); for (const id of ids) if (!still.has(id)) set.delete(id); };
  const a = tab(), b = tab();
  S.queueDeleteIntents("task-delete", ["x"], 1000); a.deleting.add("x");
  S.queueDeleteIntents("task-delete", ["x"], 2000); b.deleting.add("x");
  S.voidDeleteIntents("task-delete", ["x"], 1000); releaseVoided(a.deleting, "task-delete", ["x"]);
  assert.ok(a.deleting.has("x"), "A keeps x while it is pending at T2");
  S.voidDeleteIntents("task-delete", ["x"], 2000); releaseVoided(b.deleting, "task-delete", ["x"]);
  const p = pass(a, { cloud: [X], ids: { ...NONE(), tasks: new Set(["x"]) } });
  assert.equal(a.deleting.has("x"), false, "released on A's next pass");
  assert.deepEqual(p.taskPlan.add.map(r => r.id), ["x"], "the restored generation comes back to A");
});
test("#8 an id whose delete call is in flight in THIS tab (intent not queued yet) stays; a queue-time hold too", () => {
  const a = tab(); a.deleting.add("x"); a.deletingLogs.add("L1");
  const call = {};
  a.holds.set("x", new Set([call]));                       // bulk delete: marked, backup still being made
  a.logHolds.set("L1", new Set([5000]));                   // History work the server does for the task delete at 5000
  S.queueDeleteIntents("task-delete", ["x"], 5000);
  pass(a, {});
  assert.ok(a.deleting.has("x") && a.deletingLogs.has("L1"), "both held");
  S.settleDeleteIntents("task-delete", ["x"]);             // nothing pending at 5000 any more
  pass(a, {});
  assert.ok(a.deleting.has("x"), "the call is still in flight");
  assert.equal(a.deletingLogs.has("L1"), false, "the queue-time hold ended with its intents");
  a.holds.get("x").delete(call);
  pass(a, {});
  assert.equal(a.deleting.has("x"), false, "the call ended and nothing is pending");
});

// The last guard: addFailedSync refuses a task / History upload of an id the shared state blocks.
test("addFailedSync refuses an upload of an id pending deletion or confirmed deleted (task and History); others pass", () => {
  S.queueDeleteIntents("task-delete", ["p"]);
  S.confirmDeleteIntents("task-delete", ["c"]);
  S.queueDeleteIntents("history-delete", ["hp"]);
  S.confirmDeleteIntents("history-delete", ["hc"]);
  for (const id of ["p", "c", "ok"]) S.addFailedSync({ kind: "task", id, data: { id } });
  for (const id of ["hp", "hc", "hok"]) S.addFailedSync({ kind: "history", id, data: { id } });
  S.addFailedSync({ kind: "history", id: "p", data: { id: "p" } });   // a task id's delete does not block a History entry of that id
  S.addFailedSync({ kind: "setting", id: "c", data: 1 });
  assert.deepEqual(queued("task"), ["ok"]);
  assert.deepEqual(queued("history"), ["hok", "p"]);
  assert.deepEqual(queued("setting"), ["c"]);
});
test("uploadable: leaves out blocked ids; a confirmed id's queued upload leaves the queue, a pending one's stays", () => {
  S.addFailedSync({ kind: "task", id: "p", data: { id: "p" } });
  S.addFailedSync({ kind: "task", id: "c", data: { id: "c" } });
  S.queueDeleteIntents("task-delete", ["p"]);
  // A stale entry put back after the confirm (a clear's give-back) carries a stamp AFTER the confirm.
  S.confirmDeleteIntents("task-delete", ["c"]);
  S.putBackQueuedUploads([{ kind: "task", id: "c", data: { id: "c" }, ts: C.serverNow() + 60_000, attempts: 1 }]);
  const queue = S.getFailedSyncs().filter(e => e.kind === "task");
  assert.deepEqual(S.withoutConfirmedUploads(queue).map(e => e.id).sort(), ["c", "p"], "the time comparison alone keeps it");
  assert.deepEqual(S.uploadable("task", [...queue, { id: "free" }]).map(e => e.id), ["free"]);
  assert.deepEqual(queued("task"), ["p"], "the pending delete decides p's upload; c's is gone");
});

// A restore brings a confirmed id back: the pass started after the confirm releases it (the shared record forgets it),
// so it is added here and its uploads are allowed again in every tab.
// Task B12b (simulator F1): rewritten from "released by the next pass" (the row's mere return released it) into the
// outcome: a confirmed id comes back only by a restore's evidence; without one, its returning row is a late upload, the
// record keeps blocking it and the pass lists it to delete again.
test("a restore that brings a confirmed id back: released by the next pass (restore evidence), then its upload is allowed; without a restore it is not (F1)", () => {
  S.queueDeleteIntents("task-delete", ["x"]);
  S.confirmDeleteIntents("task-delete", ["x"]);
  const a = tab();
  const p0 = pass(a, { cloud: [X], ids: { ...NONE(), tasks: new Set(["x"]) } });
  assert.deepEqual(p0.t.released, [], "no restore known: not released");
  assert.deepEqual(p0.t.reappeared.map(r => r.id), ["x"], "deleted again");
  assert.ok(S.confirmedDeletes("task-delete").has("x"), "the record keeps blocking it");
  assert.deepEqual(p0.taskPlan.add.map(r => r.id), [], "not re-added here");
  assert.deepEqual(S.uploadable("task", [X]).map(r => r.id), [], "nor uploaded");
  // A restore newer than the delete, known before the pass's reads: the cloud's row after it releases x.
  const R = C.serverNow() + 5;
  S.noteRestoreKnown(R);
  const t = S.sharedDeleteState("task", { deleting: a.deleting, cloudIds: new Set(["x"]), sinceSeq: S.confirmSeqNow(), restoreKnownAt: R, evidence: { present: [], complete: true } });
  assert.deepEqual(t.released, ["x"]);
  assert.equal(S.confirmedDeletes("task-delete").has("x"), false, "the shared record forgets it");
  assert.deepEqual(R2.planTaskSync({ local: [], cloud: [X], cloudIds: new Set(["x"]), tombstones: new Set(), pending: new Set(), deleting: t.deleting, since: C.serverNow() }).add.map(r => r.id), ["x"], "re-added here");
  S.addFailedSync({ kind: "task", id: "x", data: X });
  assert.deepEqual(queued("task"), ["x"], "its upload is queued again");
  assert.deepEqual(S.uploadable("task", [X]).map(r => r.id), ["x"]);
});
test("release: a pending intent (deleted again) or an id the cloud lacks is never released; old records count as seq 0", () => {
  // Old-format record (a bare server stamp, before task B7a): read as confirmed before any pass.
  localStorage.setItem("proximaai-confirmed-deletes", JSON.stringify({ "task-delete": { old: C.serverNow() - 1000, gone: C.serverNow() - 1000 } }));
  S.confirmDeleteIntents("task-delete", ["again"]);
  S.queueDeleteIntents("task-delete", ["again"]);   // came back by a restore and is being deleted again
  const p = pass(tab(), { ids: { ...NONE(), tasks: new Set(["old", "again"]) } });
  // Task B12b (F1): rewritten from released ["old"]: no restore is known, so "old"'s row is not a restore's: it stays
  // confirmed and is listed to delete again (at its queue time); "again" (pending) and "gone" (absent) neither.
  assert.deepEqual(p.t.released, []);
  assert.deepEqual(p.t.reappeared.map(r => r.id), ["old"]);
  assert.ok(p.t.deleting.has("old"));
  assert.ok(p.t.deleting.has("again") && p.t.deleting.has("gone"));
  assert.deepEqual(S.confirmSeqs("task-delete").get("gone"), 0);
  // A record re-confirmed after the pass started is not forgotten by that pass's release (the shared write re-checks).
  const sinceSeq = S.confirmSeqNow();
  S.confirmDeleteIntents("task-delete", ["late"]);
  assert.deepEqual(S.releaseConfirmed("task-delete", ["late"], sinceSeq), []);
  assert.ok(S.confirmedDeletes("task-delete").has("late"));
});
test("the confirm sequence is shared and increases with every confirm call", () => {
  const s0 = S.confirmSeqNow();
  S.confirmDeleteIntents("task-delete", ["a", "b"]);
  S.confirmDeleteIntents("history-delete", ["h"]);
  const seqs = S.confirmSeqs("task-delete");
  assert.equal(seqs.get("a"), s0); assert.equal(seqs.get("b"), s0);
  assert.equal(S.confirmSeqs("history-delete").get("h"), s0 + 1);
  assert.equal(S.confirmSeqNow(), s0 + 2);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
