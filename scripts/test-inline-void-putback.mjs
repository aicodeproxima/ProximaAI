// Task B7b (review round 20 #2/#6 and #7). Runs the real storage.js and syncReconcile.js; the App.jsx parts (the inline
// voided branches of Clear Logs and Clear Outputs, applyClearStashes, the replay) are mirrored as they now read
// (scripts/test-delete-wiring.mjs checks the App.jsx side).
// #2/#6 (r20 p3-inline-putback, inline-void-putback): a clear's inline voided branch put back every item and taken
// upload of the clear, although another tab had re-queued one of them at a later time and that delete was (or would be)
// confirmed: the confirmed delete came back. Now it follows stashGiveBack's rule through storage.js inlineVoidPutBack.
// #7 (r20 p2-confirm-all-times): a late "deleted" answer of the group queued at T1 settled the id's intent at T2 too.
// Run: node scripts/test-inline-void-putback.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const C = await import("../src/lib/serverClock.js");
const S = await import("../src/lib/storage.js");
const R = await import("../src/lib/syncReconcile.js");

let n = 0, failed = 0;
const test = (name, fn) => {
  try { mem.clear(); fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

const OLD = Date.now() - 10 * 60 * 1000;
const queued = (kind) => S.getFailedSyncs().filter(e => e.kind === kind).map(e => e.id);

// One tab: its React state, its deleting sets, and the browser's IndexedDB (shared by the tabs: `idb`).
const idb = { tasks: new Map(), logs: new Map() };
const tab = () => ({ tasks: [], logs: [], deleting: new Set(), deletingLogs: new Set() });
const releaseVoided = (set, kind, ids) => { const still = S.pendingDeleteIds(kind); for (const id of ids || []) if (id && !still.has(id)) set.delete(id); };
// App.jsx applyClearStashes, mirrored for one tab (`held`: what the inline branch just put back).
const applyClearStashes = (t, which, held = {}) => {
  const heldTasks = held.tasks || new Map(), heldLogs = held.logs || new Set();
  for (const s of S.readClearStashes()) {
    if (!which(s.at)) continue;
    const back = S.stashGiveBack(s);
    if (!back) continue;
    S.putBackQueuedUploads(back.uploads);
    const haveTasks = new Set([...t.tasks.map(x => x.id), ...heldTasks.keys()]), haveLogs = new Set([...t.logs.map(l => l.id), ...heldLogs]);
    for (const x of back.tasks.filter(x => !haveTasks.has(x.id))) { t.tasks.push(x); idb.tasks.set(x.id, x); }
    for (const l of back.logs.filter(l => !haveLogs.has(l.id))) { t.logs.push(l); idb.logs.set(l.id, l); }
    S.dropGivenBackStash(s);
  }
};
// A plain delete's inline / replayed answer (bulk delete, History delete) in tab `t`, as App.jsx handles it.
const answerPlain = (t, kind, ids, at, outcome) => {
  if (outcome === "deleted") {
    S.confirmDeleteIntents(kind, ids, at);
    const gone = new Set(ids);
    if (kind === "task-delete") { t.tasks = t.tasks.filter(x => !gone.has(x.id)); for (const id of ids) idb.tasks.delete(id); }
    else { t.logs = t.logs.filter(l => !gone.has(l.id)); for (const id of ids) idb.logs.delete(id); }
  }
  if (outcome === "voided") {
    S.voidDeleteIntents(kind, ids, at);
    releaseVoided(kind === "task-delete" ? t.deleting : t.deletingLogs, kind, ids);
    applyClearStashes(t, S.voidedClearStashes(at));
  }
};

// Clear Logs in tab `t` at `snap` (App.jsx: stash before the take, the take, the intents, the entries leave).
const clearLogs = (t, snap, { cloudLogIds = new Set() } = {}) => {
  const ids = t.logs.map(l => l.id);
  const planned = new Set(ids);
  const stashUploads = S.peekQueuedUploads(["history"]).filter(e => planned.has(e.id));
  S.writeClearStash(snap, S.clearLogsStash({ loaded: t.logs, stored: [], uploads: stashUploads, planned, cloudLogIds }).full);
  const taken = S.takeQueuedUploads("history", ids);
  for (const id of ids) t.deletingLogs.add(id);
  S.queueDeleteIntents("history-delete", ids, snap);
  const logsBefore = t.logs.filter(l => planned.has(l.id));
  t.logs = t.logs.filter(l => !planned.has(l.id));
  for (const id of ids) idb.logs.delete(id);
  return { snap, ids, taken, logsBefore, storedOnly: [] };
};
// Its inline voided branch, as App.jsx now reads (task B7b).
const clearLogsVoided = (t, c) => {
  S.voidDeleteIntents("history-delete", c.ids, c.snap);
  releaseVoided(t.deletingLogs, "history-delete", c.ids);
  const back = S.inlineVoidPutBack(c.snap, { logs: [...c.logsBefore, ...c.storedOnly], uploads: c.taken });
  const backIds = new Set(back.logs.map(l => l.id));
  const logsBack = c.logsBefore.filter(l => backIds.has(l.id));
  for (const l of logsBack) { if (!t.logs.some(x => x.id === l.id)) t.logs.push(l); idb.logs.set(l.id, l); }
  S.putBackQueuedUploads(back.uploads);
  applyClearStashes(t, S.voidedClearStashes(c.snap), { logs: backIds });
};

// Clear Outputs in tab `t` at `clearAt` over its local-only tasks (their uploads queued, so none is in the cloud).
const clearOutputs = (t, clearAt) => {
  const ids = t.tasks.map(x => x.id), planned = new Set(ids);
  S.writeClearStash(clearAt, S.buildClearStash({ uploads: S.peekQueuedUploads(["task", "history"]).filter(e => e.kind === "task" && planned.has(e.id)),
    tasks: t.tasks, cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  const takenUploads = S.takeQueuedUploads("task", ids);
  for (const id of ids) t.deleting.add(id);
  S.queueDeleteIntents("task-delete", ids, clearAt);
  const tasksRemovedHere = t.tasks.filter(x => planned.has(x.id));
  t.tasks = t.tasks.filter(x => !planned.has(x.id));
  for (const id of ids) idb.tasks.delete(id);
  return { clearAt, ids, takenUploads, tasksRemovedHere };
};
const clearOutputsVoided = (t, c) => {
  S.voidDeleteIntents("task-delete", c.ids, c.clearAt);
  releaseVoided(t.deleting, "task-delete", c.ids);
  const back = S.inlineVoidPutBack(c.clearAt, { tasks: c.tasksRemovedHere, logs: [], uploads: [...c.takenUploads] });
  const backTaskIds = new Set(back.tasks.map(x => x.id));
  const tasksBack = c.tasksRemovedHere.filter(x => backTaskIds.has(x.id));
  for (const x of tasksBack) { if (!t.tasks.some(y => y.id === x.id)) t.tasks.push(x); idb.tasks.set(x.id, x); }
  S.putBackQueuedUploads(back.uploads);
  applyClearStashes(t, S.voidedClearStashes(c.clearAt), { tasks: new Map(tasksBack.map(x => [x.id, x])), logs: new Set() });
};

// After a reload: the tab's state comes from IndexedDB, its deleting sets from the pending intents; the reconcile plans
// over an empty cloud (the items were local-only), and every upload passes the shared filter (B7a).
const reloadUploads = () => {
  const failedNow = S.getFailedSyncs();
  const logs = [...idb.logs.values()], tasks = [...idb.tasks.values()];
  const h = S.sharedDeleteState("history", { deleting: S.pendingDeleteIds("history-delete"), cloudIds: new Set(), sinceSeq: S.confirmSeqNow() });
  const tk = S.sharedDeleteState("task", { deleting: S.pendingDeleteIds("task-delete"), cloudIds: new Set(), sinceSeq: S.confirmSeqNow() });
  const logPlan = R.planLogSync({ local: logs, cloud: [], cloudIds: new Set(), tombstones: new Set(),
    pending: new Set(failedNow.filter(f => f.kind === "history").map(f => f.id)), deleting: h.deleting, since: C.serverNow() });
  const taskPlan = R.planTaskSync({ local: tasks, cloud: [], cloudIds: new Set(), tombstones: new Set(),
    pending: new Set(failedNow.filter(f => f.kind === "task").map(f => f.id)), deleting: tk.deleting, since: C.serverNow() });
  return {
    logs: [...S.uploadable("history", logPlan.upload).map(l => l.id), ...S.uploadable("history", S.withoutConfirmedUploads(failedNow.filter(f => f.kind === "history"))).map(e => e.id)],
    tasks: [...S.uploadable("task", taskPlan.upload).map(x => x.id), ...S.uploadable("task", S.withoutConfirmedUploads(failedNow.filter(f => f.kind === "task"))).map(e => e.id)],
  };
};
const reset = () => { idb.tasks.clear(); idb.logs.clear(); };

// ─── #2/#6: Clear Logs (r20 p3-inline-putback), both orders ───
for (const order of ["before", "after"]) {
  test(`p3-inline-putback: tab B's later delete of L1 confirmed ${order} tab A's void answer -> L1 not put back, not uploaded, not after a reload`, () => {
    reset();
    const A = tab();
    const L1 = { id: "L1", timestamp: OLD, tasks: [] };
    A.logs.push(L1); idb.logs.set("L1", L1);
    S.addFailedSync({ kind: "history", id: "L1", data: L1 });          // local-only: its upload is queued
    const snap = C.serverNow() - 5000;
    const c = clearLogs(A, snap);                                      // tab A: Clear Logs, its call in flight
    const T2 = snap + 2000;                                            // a restore lands at snap + 1000; tab B deletes L1 after it
    S.queueDeleteIntents("history-delete", ["L1"], T2);
    if (order === "before") S.confirmDeleteIntents("history-delete", ["L1"], T2);
    clearLogsVoided(A, c);                                             // A's answer: voided
    if (order === "after") {
      assert.ok(S.pendingDeleteIds("history-delete").has("L1"), "still pending at T2");
      assert.equal(A.deletingLogs.has("L1"), true, "A keeps it deleting while T2 is pending");
      assert.deepEqual(S.readClearStash(snap)?.logs.map(l => l.id), ["L1"], "kept in A's stash for T2's void");
      S.confirmDeleteIntents("history-delete", ["L1"], T2);
    }
    assert.equal(A.logs.some(l => l.id === "L1"), false, "not in A's state");
    assert.equal(idb.logs.has("L1"), false, "not in IndexedDB");
    assert.deepEqual(queued("history"), [], "no queued upload");
    assert.deepEqual(reloadUploads().logs, [], "after a reload nothing uploads L1");
    assert.equal((S.readClearStash(snap)?.logs || []).some(l => l.id === "L1"), false, "the confirm took it out of the stash");
  });
}
test("p3-inline-putback: tab B's later delete is VOIDED afterwards -> L1 comes back then (nothing of this device lost)", () => {
  reset();
  const A = tab(), B = tab();
  const L1 = { id: "L1", timestamp: OLD, tasks: [] };
  A.logs.push(L1); idb.logs.set("L1", L1);
  S.addFailedSync({ kind: "history", id: "L1", data: L1 });
  const snap = C.serverNow() - 5000;
  const c = clearLogs(A, snap);
  const T2 = snap + 2000;
  S.queueDeleteIntents("history-delete", ["L1"], T2);
  clearLogsVoided(A, c);
  assert.equal(idb.logs.has("L1"), false);
  answerPlain(B, "history-delete", ["L1"], T2, "voided");           // a restore after T2 voids B's delete too
  assert.equal(B.logs.some(l => l.id === "L1"), true, "B gets it back from A's stash (a follower of T2)");
  assert.equal(idb.logs.has("L1"), true, "and IndexedDB");
  assert.deepEqual(queued("history"), ["L1"], "and its taken upload");
  assert.equal(S.readClearStash(snap), null, "the stash is used up");
});
test("inline void with nothing pending elsewhere and nothing confirmed: every item and taken upload comes back (round 13)", () => {
  reset();
  const A = tab();
  const L1 = { id: "L1", timestamp: OLD, tasks: [] }, L2 = { id: "L2", timestamp: OLD, tasks: [] };
  A.logs.push(L1, L2); idb.logs.set("L1", L1); idb.logs.set("L2", L2);
  S.addFailedSync({ kind: "history", id: "L1", data: L1 });
  const c = clearLogs(A, C.serverNow() - 5000);
  clearLogsVoided(A, c);
  assert.deepEqual(A.logs.map(l => l.id).sort(), ["L1", "L2"]);
  assert.deepEqual([...idb.logs.keys()].sort(), ["L1", "L2"]);
  assert.deepEqual(queued("history"), ["L1"]);
  assert.deepEqual(queued("history-delete"), []);
});

// ─── #2/#6: Clear Outputs (r20 inline-void-putback), both orders ───
for (const order of ["before", "after"]) {
  test(`inline-void-putback: Clear Outputs voided, x re-deleted at T2 in another tab and confirmed ${order} -> x not back, not uploaded`, () => {
    reset();
    const A = tab();
    const x = { id: "x", status: "completed", startTime: OLD, endTime: OLD + 1000, outputs: ["u"] }, y = { id: "y", status: "completed", startTime: OLD, endTime: OLD + 1000, outputs: ["v"] };
    A.tasks.push(x, y); idb.tasks.set("x", x); idb.tasks.set("y", y);
    S.addFailedSync({ kind: "task", id: "x", data: x }); S.addFailedSync({ kind: "task", id: "y", data: y });
    const clearAt = C.serverNow() - 5000;
    const c = clearOutputs(A, clearAt);
    const t3 = clearAt + 2000;                                         // the restore at clearAt + 1000; tab B deletes x at t3
    S.queueDeleteIntents("task-delete", ["x"], t3);
    if (order === "before") S.confirmDeleteIntents("task-delete", ["x"], t3);
    clearOutputsVoided(A, c);
    if (order === "after") S.confirmDeleteIntents("task-delete", ["x"], t3);
    assert.deepEqual(A.tasks.map(t => t.id), ["y"], "only y comes back to state");
    assert.deepEqual([...idb.tasks.keys()], ["y"], "and to IndexedDB");
    assert.deepEqual(queued("task"), ["y"], "and to the upload queue");
    assert.deepEqual(reloadUploads().tasks, ["y"], "after a reload only y uploads");
  });
}
// Task B9 (review round 22) rewrote this test (was: "a confirm recorded BEFORE the clear's queue time does not hold an
// item back", the B8b time comparison, removed): a void proves a restore after the clear, so a confirm queued before it
// is superseded. Its item is kept (neither put back nor lost) until a pass reads the cloud after the restore: present ->
// released and given back; a confirm queued after the restore stays final ("only later ones" hold an item back).
test("inlineVoidPutBack: a confirm queued BEFORE the clear's void is kept until the cloud decides it; a later one holds the item back", () => {
  const at = C.serverNow() + 60_000;   // the clear's queue time, after the old confirm
  const q = S.queueDeleteIntents("task-delete", ["old"]);
  S.confirmDeleteIntents("task-delete", ["old"], q);
  S.queueDeleteIntents("task-delete", ["old", "k"], at);
  S.voidDeleteIntents("task-delete", ["old", "k"], at);
  S.confirmDeleteIntents("task-delete", ["later"], at + 10);         // queued after the restore the void proved
  const back = S.inlineVoidPutBack(at, { tasks: [{ id: "old" }, { id: "k" }, { id: "later" }] });
  assert.deepEqual(back.tasks.map(t => t.id), ["k"], "old waits, later stays gone");
  assert.deepEqual(S.readClearStash(at).tasks.map(t => t.id), ["old"], "old is not lost: it waits in the clear's stash");
  const st = S.sharedDeleteState("task", { cloudIds: new Set(["old"]), sinceSeq: S.confirmSeqNow(), restoreKnownAt: S.knownRestoreAt(), evidence: { present: [], complete: true } });
  assert.deepEqual(st.released, ["old"], "the cloud holds it after the restore");
  assert.deepEqual(S.stashGiveBack(S.readClearStash(at)).tasks.map(t => t.id), ["old"], "then it comes back");
});

// ─── #7: a confirm settles only up to its group's queue time (r20 p2-confirm-all-times) ───
test("#7: T1's late 'deleted' answer leaves x's intent at T2 (re-queued after a restore); T2's replay still sends x", () => {
  const T1 = 1000, T2 = 3000;
  S.queueDeleteIntents("task-delete", ["x"], T1);
  S.writeClearStash(T2, S.buildClearStash({ tasks: [{ id: "x", status: "completed" }, { id: "y", status: "completed" }] }));
  S.queueDeleteIntents("task-delete", ["x", "y"], T2);              // x's intent moves to T2
  S.putBackQueuedUploads([{ kind: "task", id: "x", data: { id: "x" }, ts: 500, attempts: 1 }]);
  S.confirmDeleteIntents("task-delete", ["x"], T1);                  // A handles T1's answer only now
  assert.deepEqual(S.intentGroups("task-delete"), [[T2, ["x", "y"]]], "T2's group keeps x");
  assert.ok(S.pendingDeleteIds("task-delete").has("x"), "x still pending at T2");
  // Task B9 (review round 22 #1) restored the original assertion (B8c had rewritten it): the confirm still drops x's
  // queued upload stamped before T1, and records x with T1 (the B8c skip is gone).
  assert.deepEqual(queued("task"), [], "the confirm still drops x's queued upload (stamped before T1)");
  assert.deepEqual(S.uploadable("task", ["x"]), [], "and x is not sent while T2 is pending");
  assert.equal(S.confirmQueuedAt("task-delete").get("x"), 1000, "T1's late answer records x with T1");
  // Task B8a (review round 21 #8): T2's later stash keeps x; T2's own void gives it back, its confirm drops it.
  assert.deepEqual(S.readClearStash(T2)?.tasks.map(t => t.id), ["x", "y"], "T2's later stash keeps x");
  // The next replay (App.jsx replayDeleteIntents) sends T2's group, x included.
  const sent = [];
  for (const [ts, ids] of S.intentGroups("task-delete")) { sent.push([ts, ids]); S.confirmDeleteIntents("task-delete", ids, ts); }
  assert.deepEqual(sent, [[T2, ["x", "y"]]]);
  assert.deepEqual(S.intentGroups("task-delete"), []);
  assert.deepEqual(queued("task"), [], "T2's confirm drops x's queued upload");
  assert.ok(S.confirmedDeletes("task-delete").has("x"), "and records x");
  // releaseRestored never frees x while its T2 delete is pending (checked before that replay above).
});
test("#7: releaseRestored does not free x while T2 is pending (whatever T1's late confirm recorded)", () => {
  S.queueDeleteIntents("task-delete", ["x"], 1000);
  S.queueDeleteIntents("task-delete", ["x"], 3000);
  const sinceSeq = S.confirmSeqNow() + 1;
  S.confirmDeleteIntents("task-delete", ["x"], 1000);
  const st = S.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(["x"]), sinceSeq });
  assert.deepEqual(st.released, [], "pending at 3000: not released");
  assert.ok(st.deleting.has("x"));
});
test("#7: settleDeleteIntents with a bound settles intents queued at or before it, not later ones; no bound: every time", () => {
  S.queueDeleteIntents("history-delete", ["a"], 100);
  S.queueDeleteIntents("history-delete", ["b"], 200);
  S.queueDeleteIntents("history-delete", ["c"], 300);
  S.settleDeleteIntents("history-delete", ["a", "b", "c"], 200);
  assert.deepEqual(S.intentGroups("history-delete"), [[300, ["c"]]]);
  S.settleDeleteIntents("history-delete", ["c"], NaN);
  assert.deepEqual(S.intentGroups("history-delete"), [[300, ["c"]]], "an unreadable bound settles nothing");
  S.settleDeleteIntents("history-delete", ["c"]);
  assert.deepEqual(S.intentGroups("history-delete"), []);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
