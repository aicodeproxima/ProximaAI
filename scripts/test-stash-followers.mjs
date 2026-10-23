// Review round 17 (#1, #3, #6): a clear stash's fate follows the clear its ids moved to. A voided clear gave back only
// its in-memory sets and dropped its stash (with what moveClearStash had merged into it), and a stash whose ids had moved
// to it was then dropped as "confirmed" by the next settle pass. These run the critics' reproductions
// (r17-safety/c1-merge-lost.mjs, r17-correctness/probe1.mjs A and B, r17-regression/movevoid.mjs) on the real storage.js;
// the App.jsx parts (applyClearStashes, settleClearStashes, the inline answer of Reset / Clear Outputs / Clear Logs,
// replayDeleteIntents) are mirrored as they now read (test-delete-wiring checks the App.jsx side).
// Run: node scripts/test-stash-followers.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const S = await import("../src/lib/storage.js");
const { addFailedSync, getFailedSyncs, queueDeleteIntents, settleDeleteIntents, confirmDeleteIntents, intentGroups, peekQueuedUploads,
  takeQueuedUploads, putBackQueuedUploads, buildClearStash, writeClearStash, readClearStash, readClearStashes, dropClearStash,
  stashGiveBack, stashArchivePaths, moveClearStash, recordStashArchive, stashFollowers, voidedClearStashes,
  voidDeleteIntents, voidedTimes, recordVoidedAt, pruneVoidedAt, stashTiedToVoided, dropDeleteIntentsBefore } = S;

let n = 0, failed = 0;
const test = (name, fn) => {
  try { mem.clear(); fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

// The App.jsx side, mirrored. `tasks` / `logs`: this device's in-memory items; `fileDeletes`: paths sent to the
// file-delete queue (queueArchivedFileDeletes); `reapplied`: archive records re-applied, with the base task used.
const rig = () => {
  const st = { tasks: [], logs: [], fileDeletes: [], reapplied: [], favorites: [] };
  const applyClearStashes = (which, held = {}) => {
    const heldTasks = held.tasks || new Map(), heldLogs = held.logs || new Set();
    for (const s of readClearStashes()) {
      if (!which(s.at)) continue;
      const back = stashGiveBack(s);
      if (!back) continue;
      putBackQueuedUploads(back.uploads);
      const haveTasks = new Set([...st.tasks.map(t => t.id), ...heldTasks.keys()]), haveLogs = new Set([...st.logs.map(l => l.id), ...heldLogs]);
      const backTasks = back.tasks.filter(t => !haveTasks.has(t.id)), backLogs = back.logs.filter(l => !haveLogs.has(l.id));
      st.tasks.push(...backTasks); st.logs.push(...backLogs);
      const base = new Map([...heldTasks, ...backTasks.map(t => [t.id, t])]);
      for (const [id, rec] of Object.entries(back.archives || {})) st.reapplied.push({ id, base: base.get(id) || rec.task, paths: rec.paths });
      st.fileDeletes.push(...back.orphanPaths);
      if (back.favorites) st.favorites.push(back.favorites);
      dropClearStash(s.at);
    }
  };
  // Round 18 #3: a stash tied to a recorded voided time is given back first, never dropped.
  const settleClearStashes = () => {
    const voided = voidedTimes();
    const back = new Set(readClearStashes().filter(s => stashTiedToVoided(s, voided)).map(s => s.at));
    if (back.size) applyClearStashes(at => back.has(at));
    const queued = new Set([...intentGroups("task-delete"), ...intentGroups("history-delete")].map(([ts]) => ts));
    for (const s of readClearStashes()) if (!queued.has(s.at)) {
      if (stashTiedToVoided(s, voided)) continue;
      if (moveClearStash(s.at)) continue;
      st.fileDeletes.push(...stashArchivePaths(s)); dropClearStash(s.at);
    }
    pruneVoidedAt();
  };
  // A plain delete (bulk delete, History delete, dropLogItemsFor, purgeEverywhere's History removal): no stash of its own.
  const plainDelete = (kind, ids, at) => queueDeleteIntents(kind, ids, at);
  // Its inline answer. `giveBack` false: a call site that forgot the give-back (the record still covers it).
  const plainAnswer = (kind, ids, at, outcome, { giveBack = true } = {}) => {
    if (outcome === "deleted") confirmIntents(kind, ids);
    if (outcome === "voided") { voidDeleteIntents(kind, ids, at); if (giveBack) applyClearStashes(voidedClearStashes(at)); }
  };
  const confirmIntents = (kind, ids) => st.fileDeletes.push(...confirmDeleteIntents(kind, ids));
  // A Reset-shaped clear at `at`: stash before the take, the take, the intents, the items leave this device.
  const clear = (at, { taskIds = [], logIds = [], local = [], cloudTaskIds = new Set(taskIds), favorites } = {}) => {
    const planned = new Set(taskIds);
    const uploads = peekQueuedUploads(["task"]).filter(e => planned.has(e.id));
    writeClearStash(at, { ...buildClearStash({ uploads, tasks: local, cloudTaskIds }), ...(favorites ? { favorites } : {}) });
    const taken = takeQueuedUploads("task", taskIds);
    const removedHere = st.tasks.filter(t => planned.has(t.id));
    st.tasks = st.tasks.filter(t => !planned.has(t.id));
    queueDeleteIntents("task-delete", taskIds, at);
    if (logIds.length) queueDeleteIntents("history-delete", logIds, at);
    return { at, taskIds, logIds, taken, removedHere };
  };
  // The inline answer (App.jsx Reset / Clear Outputs / Clear Logs after their clear call).
  const answer = (c, outcome) => {
    const heldArchives = outcome === "ok" ? (readClearStash(c.at)?.archives || {}) : {};
    if (outcome === "ok") dropClearStash(c.at);
    if (outcome === "voided") {
      voidDeleteIntents("task-delete", c.taskIds, c.at); voidDeleteIntents("history-delete", c.logIds, c.at);
      st.tasks.push(...c.removedHere.filter(t => !st.tasks.some(x => x.id === t.id)));
      putBackQueuedUploads(c.taken);
      applyClearStashes(voidedClearStashes(c.at), { tasks: new Map(c.removedHere.map(t => [t.id, t])), logs: new Set() });
      return;
    }
    if (outcome === "ok") {
      st.fileDeletes.push(...stashArchivePaths({ archives: heldArchives }));
      // settleCloudClear: the cloud no longer holds them
      confirmIntents("task-delete", c.taskIds); confirmIntents("history-delete", c.logIds);
      settleClearStashes();
    }
  };
  // replayDeleteIntents with the server's answer per queue time ("voided" | "deleted"), then settleClearStashes.
  const replay = (answers) => {
    for (const kind of ["task-delete", "history-delete"]) for (const [ts, ids] of intentGroups(kind)) {
      const a = answers[ts];
      if (!a) continue;
      if (a === "deleted") confirmIntents(kind, ids);
      if (a === "voided") { voidDeleteIntents(kind, ids, ts); applyClearStashes(voidedClearStashes(ts)); }
    }
    settleClearStashes();
  };
  return { st, applyClearStashes, settleClearStashes, clear, answer, replay, plainDelete, plainAnswer, confirmIntents };
};
const queuedTaskUploads = () => getFailedSyncs().filter(e => e.kind === "task").map(e => e.id);
const T1 = 1000, T2 = 2000;

// r17-safety/c1-merge-lost.mjs (#1) and r17-correctness/probe1.mjs variant A (#3a).
test("#1/#3a: an earlier stash merged into a clear answered voided inline: its taken upload is queued again", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "c1", data: { id: "c1", status: "completed", outputs: ["final.png"] } });
  r.clear(T1, { taskIds: ["c1"] });                                  // Reset1: no answer, takes c1's upload
  writeClearStash(T1, { ...readClearStash(T1), archives: { c1: { task: { id: "c1" }, paths: ["p/c1.png"] } } });
  assert.deepEqual(queuedTaskUploads(), [], "Reset1 took the upload");
  const c2 = r.clear(T2, { taskIds: ["c1"] });                       // Reset2 re-plans c1 from the cloud read
  assert.deepEqual(readClearStash(T1).movedTo, [T2]);
  r.settleClearStashes();                                            // a Save press while Reset2's call is in flight
  assert.deepEqual(readClearStashes().map(s => s.at), [T2], "S1 merged into S2");
  r.answer(c2, "voided");
  assert.deepEqual(queuedTaskUploads(), ["c1"], "Reset1's taken upload is queued again");
  assert.equal(getFailedSyncs().find(e => e.kind === "task").data.status, "completed", "the newer version, not the cloud's");
  assert.deepEqual(r.st.reapplied.map(a => a.id), ["c1"], "the merged archive record re-applies");
  assert.deepEqual(r.st.fileDeletes, [], "no archived file is deleted");
  assert.deepEqual(readClearStashes(), [], "nothing left over");
  assert.deepEqual(intentGroups("task-delete"), []);
});

// r17-correctness/probe1.mjs variant B (#3b).
test("#3b: a follower not merged, its target voided inline, then a settleCloudClear: given back, no file deletes", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "A", data: { id: "A", status: "completed" } });
  r.clear(T1, { taskIds: ["A"] });
  writeClearStash(T1, { ...readClearStash(T1), archives: { A: { task: { id: "A" }, paths: ["p/a.png"] } } });
  const c2 = r.clear(T2, { taskIds: ["A"] });
  r.answer(c2, "voided");                                            // no settle pass during the call: S1 still at T1
  assert.deepEqual(queuedTaskUploads(), ["A"], "the follower's taken upload is back");
  assert.deepEqual(r.st.reapplied.map(a => a.id), ["A"]);
  r.settleClearStashes();                                            // another clear's settleCloudClear
  assert.deepEqual(r.st.fileDeletes, [], "p/a.png is not sent to the file-delete queue");
  assert.deepEqual(readClearStashes(), []);
});

// r17-regression/movevoid.mjs (#6).
test("#6: the target voided by the server at replay: the follower is given back before the settle pass", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "x", data: { id: "x", status: "completed", outputs: ["newer"] } });
  r.clear(T1, { taskIds: ["x"], local: [{ id: "loc1" }], cloudTaskIds: new Set(["x"]) });
  r.clear(T2, { taskIds: ["x"] });
  assert.equal(S.intentsPendingAt(T1), false);
  r.replay({ [T2]: "voided" });
  assert.deepEqual(queuedTaskUploads(), ["x"], "A's taken upload of x is back");
  assert.equal(getFailedSyncs().find(e => e.kind === "task").data.outputs[0], "newer");
  assert.ok(r.st.tasks.some(t => t.id === "loc1"), "A's local-only item is back");
  assert.deepEqual(readClearStashes(), []);
  assert.deepEqual(r.st.fileDeletes, []);
});

test("confirmed (inline ok): the merged stash goes, its archive paths are queued for deletion, nothing comes back", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "c1", data: { id: "c1", status: "completed" } });
  r.clear(T1, { taskIds: ["c1"] });
  writeClearStash(T1, { ...readClearStash(T1), archives: { c1: { task: { id: "c1" }, paths: ["p/c1.png"] } } });
  const c2 = r.clear(T2, { taskIds: ["c1"] });
  r.settleClearStashes();                                            // merged during the call
  r.answer(c2, "ok");
  assert.deepEqual(queuedTaskUploads(), [], "the taken upload stays taken");
  assert.deepEqual(r.st.fileDeletes, ["p/c1.png"]);
  assert.deepEqual(readClearStashes(), []);
});

test("confirmed (inline ok): a follower not merged settles the same way (dropped, archive paths deleted)", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "A", data: { id: "A" } });
  r.clear(T1, { taskIds: ["A"] });
  writeClearStash(T1, { ...readClearStash(T1), archives: { A: { task: { id: "A" }, paths: ["p/a.png"] } } });
  const c2 = r.clear(T2, { taskIds: ["A"] });
  r.answer(c2, "ok");
  assert.deepEqual(queuedTaskUploads(), []);
  assert.deepEqual(r.st.fileDeletes, ["p/a.png"]);
  assert.deepEqual(readClearStashes(), []);
});

test("confirmed at replay: target deleted -> the follower is dropped and its archive paths deleted", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "x", data: { id: "x" } });
  r.clear(T1, { taskIds: ["x"] });
  writeClearStash(T1, { ...readClearStash(T1), archives: { x: { task: { id: "x" }, paths: ["p/x.png"] } } });
  r.clear(T2, { taskIds: ["x"] });
  r.replay({ [T2]: "deleted" });
  assert.deepEqual(queuedTaskUploads(), []);
  assert.deepEqual(r.st.fileDeletes, ["p/x.png"]);
  assert.deepEqual(readClearStashes(), []);
});

test("stashFollowers: transitive, none while the target is pending, none with an intent of its own", () => {
  writeClearStash(100, { tasks: [{ id: "a" }] });
  queueDeleteIntents("task-delete", ["a"], 100);
  writeClearStash(200, { tasks: [{ id: "b" }] });
  queueDeleteIntents("task-delete", ["b", "own"], 200);
  queueDeleteIntents("task-delete", ["a", "b"], 300);   // 100 and 200 lose ids to 300
  queueDeleteIntents("task-delete", ["a", "b"], 400);   // and 300 loses them to 400: the chain follows
  assert.deepEqual(readClearStash(100).movedTo, [300, 400]);
  assert.deepEqual([...stashFollowers(400)], [], "400 pending: its void or confirm has not come");
  settleDeleteIntents("task-delete", ["a", "b"]);
  assert.deepEqual([...stashFollowers(400)], [100], "200 still has an intent of its own");
  assert.deepEqual([...stashFollowers(300)], [100]);
  const which = voidedClearStashes(400);
  assert.equal(which(400), true); assert.equal(which(100), true); assert.equal(which(200), false);
  settleDeleteIntents("task-delete", ["own"]);
  assert.deepEqual([...stashFollowers(400)].sort(), [100, 200]);
  assert.deepEqual([...stashFollowers("x")], []);
});

test("a follower waits while the target's other group is pending, and follows its later void", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "A", data: { id: "A" } });
  r.clear(T1, { taskIds: ["A"] });
  r.clear(T2, { taskIds: ["A"], logIds: ["h"] });
  // The task group is voided first; the History group of T2 is still pending (its replay failed).
  settleDeleteIntents("task-delete", ["A"]);
  r.applyClearStashes(voidedClearStashes(T2));
  assert.deepEqual(queuedTaskUploads(), [], "nothing yet");
  assert.deepEqual(readClearStashes().map(s => s.at), [T1, T2]);
  r.replay({ [T2]: "voided" });
  assert.deepEqual(queuedTaskUploads(), ["A"]);
  assert.deepEqual(readClearStashes(), []);
});

test("versions held now win: the inline put-back's task is the archive's base, a stash copy does not replace it", () => {
  const r = rig();
  r.st.tasks = [{ id: "loc", v: 2 }];
  const c = r.clear(T1, { taskIds: ["loc"], local: [{ id: "loc", v: 1 }], cloudTaskIds: new Set() });
  recordStashArchive("loc", { task: { id: "loc", v: 0 }, paths: ["p/loc.png"] });
  r.answer(c, "voided");
  assert.deepEqual(r.st.tasks, [{ id: "loc", v: 2 }], "the version put back in memory stays");
  assert.deepEqual(r.st.reapplied, [{ id: "loc", base: { id: "loc", v: 2 }, paths: ["p/loc.png"] }]);
});

test("an id pending deletion by a later clear is not given back by a follower; its archive record moves there", () => {
  const r = rig();
  r.clear(T1, { taskIds: ["A", "B"], local: [{ id: "A" }, { id: "B" }], cloudTaskIds: new Set() });
  writeClearStash(T1, { ...readClearStash(T1), archives: { B: { task: { id: "B" }, paths: ["p/b.png"] } } });
  const c2 = r.clear(T2, { taskIds: ["A"] });
  writeClearStash(3000, buildClearStash({}));                         // a later clear of B, still pending
  queueDeleteIntents("task-delete", ["B"], 3000);
  r.answer(c2, "voided");
  assert.deepEqual(r.st.tasks.map(t => t.id), ["A"], "B stays deleted");
  assert.deepEqual(readClearStash(3000).archives.B.paths, ["p/b.png"], "B's archive record moved to the pending delete");
});

// Review round 18 #3 (r18-correctness/plain-void.mjs): a clear's stash whose ids all moved to a PLAIN delete (no stash of
// its own: bulk delete, History delete, dropLogItemsFor, purgeEverywhere) that is voided inline was dropped as confirmed
// by the next settle pass, and its archive paths queued for deletion. Every void now records its queue time
// (voidDeleteIntents), and settleClearStashes gives back, never drops, a stash tied to a recorded voided time.
const T4 = 5000, FAV = { scope: "d", byType: { image: ["m1"] }, updatedAt: 1, resetAt: T1 };
const resetMovedToPlain = (r) => {
  addFailedSync({ kind: "task", id: "X", data: { id: "X", status: "completed" } });
  r.clear(T1, { taskIds: ["X"], favorites: FAV });                 // Reset R1: no answer, takes X's newer upload
  writeClearStash(T1, { ...readClearStash(T1), archives: { X: { task: { id: "X" }, paths: ["p/x.png"] } } });
  r.plainDelete("task-delete", ["X"], T4);                          // tab B (stale view) bulk-deletes X
  assert.deepEqual(readClearStash(T1).movedTo, [T4]);
  assert.equal(S.intentsPendingAt(T1), false);
};
test("round 18 #3: a Reset stash moved wholly to a plain delete voided inline is given back at the void", () => {
  const r = rig();
  resetMovedToPlain(r);
  r.plainAnswer("task-delete", ["X"], T4, "voided");
  assert.deepEqual(queuedTaskUploads(), ["X"], "X's taken upload is queued again");
  assert.equal(getFailedSyncs().find(e => e.kind === "task").data.status, "completed");
  assert.deepEqual(r.st.favorites, [FAV], "the Reset's favorites come back");
  assert.deepEqual(r.st.reapplied.map(a => a.id), ["X"]);
  r.settleClearStashes();
  assert.deepEqual(r.st.fileDeletes, [], "no archive file is queued for deletion");
  assert.deepEqual(readClearStashes(), []);
});
test("round 18 #3: the same with a void site that forgot the give-back: the settle pass gives it back, never drops it", () => {
  const r = rig();
  resetMovedToPlain(r);
  r.plainAnswer("task-delete", ["X"], T4, "voided", { giveBack: false });
  assert.deepEqual([...voidedTimes()], [T4], "the void is recorded");
  assert.equal(stashTiedToVoided(readClearStash(T1)), true);
  r.settleClearStashes();                                            // forceSaveAll / settleCloudClear
  assert.deepEqual(queuedTaskUploads(), ["X"], "given back, not dropped as confirmed");
  assert.deepEqual(r.st.favorites, [FAV]);
  assert.deepEqual(r.st.fileDeletes, [], "p/x.png is not deleted");
  assert.deepEqual(readClearStashes(), []);
  assert.deepEqual([...voidedTimes()], [], "the record is pruned once no stash refers to it");
});
test("round 18 #3: two-tab race: the follower's own last group confirms AFTER its target's void: moved part back, confirmed not", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "A", data: { id: "A", v: 2 } });
  addFailedSync({ kind: "task", id: "B", data: { id: "B", v: 2 } });
  r.clear(T1, { taskIds: ["A", "B"] });
  writeClearStash(T1, { ...readClearStash(T1), archives: { A: { task: { id: "A" }, paths: ["p/a.png"] }, B: { task: { id: "B" }, paths: ["p/b.png"] } } });
  r.plainDelete("task-delete", ["A"], T4);                          // tab B deletes A only: B stays pending at T1
  r.plainAnswer("task-delete", ["A"], T4, "voided");                // handled while T1 still has B pending
  assert.deepEqual(queuedTaskUploads(), [], "not yet: T1 is not settled");
  assert.deepEqual(readClearStashes().map(s => s.at), [T1]);
  r.confirmIntents("task-delete", ["B"]);                            // T1's last group confirms afterwards
  assert.deepEqual(r.st.fileDeletes, ["p/b.png"], "the confirmed task's archive files go");
  r.settleClearStashes();
  assert.deepEqual(queuedTaskUploads(), ["A"], "A's taken upload comes back, B's does not");
  assert.deepEqual(r.st.reapplied.map(a => a.id), ["A"]);
  assert.deepEqual(r.st.fileDeletes, ["p/b.png"], "A's files are kept");
  assert.deepEqual(readClearStashes(), []);
});
test("round 18 #3: a stash whose plain-delete target was confirmed is dropped with its archive paths queued", () => {
  const r = rig();
  resetMovedToPlain(r);
  r.plainAnswer("task-delete", ["X"], T4, "deleted");
  r.settleClearStashes();
  assert.deepEqual(queuedTaskUploads(), [], "the taken upload stays taken");
  assert.deepEqual(r.st.favorites, [], "nothing comes back");
  assert.deepEqual(r.st.fileDeletes, ["p/x.png"]);
  assert.deepEqual(readClearStashes(), []);
  assert.deepEqual([...voidedTimes()], []);
});
test("round 18 #3: a voided time whose other group is still pending waits; its later confirm still gives back the voided part", () => {
  const r = rig();
  addFailedSync({ kind: "task", id: "A", data: { id: "A" } });
  r.clear(T1, { taskIds: ["A"] });
  r.plainDelete("task-delete", ["A"], T4); r.plainDelete("history-delete", ["h"], T4);   // bulk delete: tasks and History at T4
  r.plainAnswer("task-delete", ["A"], T4, "voided");
  r.settleClearStashes();
  assert.deepEqual(queuedTaskUploads(), [], "T4's History group is pending: not yet");
  r.plainAnswer("history-delete", ["h"], T4, "deleted");
  r.settleClearStashes();
  assert.deepEqual(queuedTaskUploads(), ["A"]);
  assert.deepEqual(readClearStashes(), []);
});
test("round 18 #3: the voided-at record: void sites record only real voids, unreferenced and 30-day-old times are pruned", () => {
  voidDeleteIntents("task-delete", [], 700);
  assert.deepEqual([...voidedTimes()], [], "nothing voided: nothing recorded");
  writeClearStash(100, { tasks: [{ id: "a" }], movedTo: [300] });
  recordVoidedAt(300); recordVoidedAt(999);
  assert.deepEqual([...voidedTimes()], [300], "999 is referenced by no stash");
  recordVoidedAt(100);
  assert.deepEqual([...voidedTimes()].sort(), [100, 300]);
  localStorage.setItem("proximaai-voided-at", JSON.stringify({ 100: Date.now() - 31 * 24 * 60 * 60 * 1000, 300: Date.now() }));
  assert.deepEqual([...voidedTimes()], [300], "older than 30 days: not counted");
  pruneVoidedAt();
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem("proximaai-voided-at"))), ["300"]);
  dropClearStash(100); pruneVoidedAt();
  assert.equal(localStorage.getItem("proximaai-voided-at"), null, "empty record removed");
  localStorage.setItem("proximaai-voided-at", "garbage");
  assert.deepEqual([...voidedTimes()], [], "an unreadable record counts as none");
});
test("round 18 #3: a restore's drop of older intents (restoreGuard) records their times as voided", () => {
  writeClearStash(T1, { tasks: [{ id: "a" }] });
  queueDeleteIntents("task-delete", ["a"], T1);
  queueDeleteIntents("history-delete", ["h"], T2);
  queueDeleteIntents("task-delete", ["later"], 9000);
  writeClearStash(T2, {}); writeClearStash(9000, {});
  dropDeleteIntentsBefore(T4);
  assert.deepEqual([...voidedTimes()].sort((a, b) => a - b), [T1, T2]);
  assert.equal(stashTiedToVoided(readClearStash(9000)), false, "still pending");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
