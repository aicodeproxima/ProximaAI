// Task B9 (review round 22, all 7 findings): a confirm keeps its QUEUE time and a restore after it supersedes it; delete
// calls in flight are shared by the tabs; History uploads strip only FINAL confirmed items; malformed shared records
// never change whether a confirm is recorded. Runs the real storage.js, syncReconcile.js and batchLog.js; the App.jsx
// reconcile pass, persistLog and replayHistoryUploads are mirrored as they now read (their wiring is checked from the
// source). The previous build's record code (a1623bf) is embedded verbatim to check both directions of compatibility.
// Run: node scripts/test-b9-superseded-flight.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
let failWrites = null;   // a key whose writes throw (a full localStorage), or null
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (failWrites === k) throw new Error("QuotaExceededError"); mem.set(k, String(v)); }, removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const C = await import("../src/lib/serverClock.js");
const S = await import("../src/lib/storage.js");
const R = await import("../src/lib/syncReconcile.js");
const B = await import("../src/lib/batchLog.js");

// Tests first: run against the previous build (a1623bf) these helpers did not exist. The stand-ins below keep its
// OUTCOMES measurable there (they are never used on this build), so each test fails on the defect, not on a missing name.
const knownRestoreAt = () => (S.knownRestoreAt ? S.knownRestoreAt() : 0);
const noteRestoreKnown = (t) => (S.noteRestoreKnown ? S.noteRestoreKnown(t) : undefined);
const historyUploadPlan = S.historyUploadPlan ?? ((entries) => ({ upload: S.withoutBlockedItems(entries), skip: [], defer: [] }));
const beginFlight = (parts, at) => (S.beginDeleteFlight ? S.beginDeleteFlight(parts, at) : null);
const endFlight = (call) => (S.endDeleteFlight ? S.endDeleteFlight(call) : undefined);
const inFlightIds = (kind) => (S.inFlightIds ? S.inFlightIds(kind) : new Set());
const confirmStates = (kind) => (S.confirmStates ? S.confirmStates(kind) : { final: new Set(S.confirmedDeletes(kind).keys()), superseded: new Set() });
const confirmQueuedAt = (kind) => (S.confirmQueuedAt ? S.confirmQueuedAt(kind) : new Map());
const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const st = readFileSync(new URL("../src/lib/storage.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};

let n = 0, failed = 0;
const test = (name, fn) => {
  try { mem.clear(); failWrites = null; fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const ids = (list) => (list || []).map(x => (typeof x === "string" ? x : x.id)).sort();
const itemsOf = (logs) => logs.map(l => ({ id: l.id, items: (l.tasks || []).map(i => i.id) }));
const OLD = Date.now() - 10 * 60 * 1000;
const task = (id, extra = {}) => ({ id, status: "completed", startTime: OLD, endTime: OLD + 1000, outputs: [`https://ws/${id}.png`], ...extra });
const item = (id) => ({ id, status: "completed", outputs: [`https://ws/${id}.png`] });
const entry = (id, itemIds) => ({ id, timestamp: OLD, prompt: "p", tasks: itemIds.map(item) });

// One reconcile pass as App.jsx reconcileWithCloud runs it (task B9): the restore known before the reads, the restore
// guard, the shared delete state with the cloud's evidence, the stale step and its History drop (dropLogItemsFor), the
// task plan's uploads and the History uploads. `cloud`: { tasks: ids, history: entries, restoreRemoved: ids | null,
// taskTombstones, settings }. `local`: { tasks, logs } of this tab (changed in place).
function pass(local, cloud) {
  const sinceSeq = S.confirmSeqNow(), restoreKnownAt = knownRestoreAt(), since = C.serverNow();
  const guard = S.restoreGuard(cloud.settings ?? {});
  const stashBack = [];
  if (guard.restoreAt > 0) for (const s of S.readClearStashes()) if (s.at < guard.restoreAt) {
    const back = S.stashGiveBack(s);
    if (!back) continue;
    stashBack.push(...back.tasks.map(t => t.id));
    for (const t of back.tasks) if (!local.tasks.some(x => x.id === t.id)) local.tasks.push(t);
    S.putBackQueuedUploads(back.uploads);
    S.dropGivenBackStash(s);
  }
  const cloudIds = { tasks: new Set(cloud.tasks || []), history: new Set((cloud.history || []).map(l => l.id)) };
  const restoreRemoved = cloud.restoreRemoved === undefined ? new Set() : cloud.restoreRemoved;
  const cloudItemIds = (cloud.history || []).flatMap(l => l.tasks || []).map(i => i?.id).filter(Boolean);
  const taskDel = S.sharedDeleteState("task", { deleting: new Set(), cloudIds: cloudIds.tasks, sinceSeq, restoreKnownAt,
    evidence: { present: [...cloudItemIds, ...(restoreRemoved || [])], complete: !!restoreRemoved } });
  const logDel = S.sharedDeleteState("history", { deleting: new Set(), cloudIds: cloudIds.history, sinceSeq, restoreKnownAt });
  const staleTasks = new Set(taskDel.stale(local.tasks)), staleLogs = new Set(logDel.stale(local.logs));
  const staleTaskRows = local.tasks.filter(t => staleTasks.has(t.id));
  local.tasks = local.tasks.filter(t => !staleTasks.has(t.id)); local.logs = local.logs.filter(l => !staleLogs.has(l.id));
  const staleItemIds = taskDel.stale(local.logs.flatMap(l => l.tasks || []).filter(i => i?.id)).filter(id => !staleTasks.has(id));
  const removed = [...staleTaskRows, ...[...new Set(staleItemIds)].map(id => ({ id }))];
  const emptied = [], rewritten = [];
  if (removed.length) {
    const { remove, rewrite } = B.purgeLogsForDeleted(local.logs, removed, local.tasks, { removeEntries: false });
    if (remove.length) { S.queueDeleteIntents("history-delete", remove); emptied.push(...remove); }
    rewritten.push(...rewrite);
    const byId = new Map(rewrite.map(l => [l.id, l]));
    local.logs = local.logs.filter(l => !remove.includes(l.id)).map(l => byId.get(l.id) || l);
  }
  // cloud entries this tab lacks are added (logPlan.add)
  for (const l of cloud.history || []) if (!local.logs.some(x => x.id === l.id) && !logDel.deleting.has(l.id)) local.logs.push(l);
  const failedQ = S.getFailedSyncs();
  const pendingTasks = new Set(failedQ.filter(f => f.kind === "task").map(f => f.id));
  const taskPlan = R.planTaskSync({ local: local.tasks, cloud: [], cloudIds: cloudIds.tasks, tombstones: cloud.taskTombstones || new Set(),
    pending: pendingTasks, deleting: taskDel.deleting, since });
  const taskUploads = S.uploadable("task", taskPlan.upload);
  const logUploads = historyUploadPlan(S.uploadable("history", local.logs.filter(l => !cloudIds.history.has(l.id)))).upload;
  return { guard, released: taskDel.released, staleTasks: [...staleTasks], staleItemIds, emptied, rewritten, taskUploads, logUploads, stashBack };
}
// persistLog as App.jsx now reads (task B9): what it queues and sends.
function persistLog(e) {
  if (S.uploadBlockedIds("history").has(e?.id)) return null;
  const send = historyUploadPlan([e]).defer.length ? e : S.withoutBlockedItems([e])[0];
  if (!send) return null;
  S.addFailedSync({ kind: "history", id: send.id, data: send });
  const sent = S.uploadable("history", S.withoutBlockedItems([send]));
  if (sent.length) S.removeFailedSync("history", send.id, q => B.sameLogContent(q.data, send));
  return { queued: send, sent };
}
// replayHistoryUploads as App.jsx now reads: what reaches the cloud.
function replayHistory() {
  const queued = S.getFailedSyncs().filter(f => f.kind === "history");
  const byId = new Map(S.uploadable("history", S.withoutConfirmedUploads(queued)).filter(f => f.data).map(f => [f.id, f]));
  const { upload, skip } = historyUploadPlan([...byId.values()].map(f => f.data));
  for (const id of skip) S.removeFailedSync("history", id, S.sentVersion(byId.get(id).data));
  return S.uploadable("history", S.withoutBlockedItems(upload));
}

// ─── #4/#6 (r22 p1-restored-history-only): a restore's History-only generations stay ───
test("r22 p1-restored-history-only: released by the pass after the restore, nothing dropped, no History delete queued", () => {
  const q = S.queueDeleteIntents("task-delete", ["x", "y"]);
  S.confirmDeleteIntents("task-delete", ["x", "y"], q);
  const R1 = q + 50;   // the owner restores the pre-delete backup: L1 = [x], L2 = [y, z]; task row z only
  const L1 = entry("L1", ["x"]), L2 = entry("L2", ["y", "z"]);
  const cloud = { tasks: ["z"], history: [L1, L2], restoreRemoved: new Set(["x", "y"]), settings: { last_restore_at: R1 } };
  const local = { tasks: [task("z")], logs: [] };
  const p1 = pass(local, cloud);                                         // learns the restore: decides nothing yet
  assert.deepEqual([p1.released, p1.staleItemIds, p1.emptied, p1.rewritten], [[], [], [], []], "first pass: nothing dropped");
  assert.deepEqual(historyUploadPlan([L1, L2]).upload, [], "no stripped copy of a restored entry is sent while undecided");
  const p2 = pass(local, cloud);
  assert.deepEqual(ids(p2.released), ["x", "y"], "the next pass releases both");
  assert.deepEqual([p2.staleItemIds, p2.emptied, p2.rewritten], [[], [], []], "nothing dropped");
  assert.deepEqual(S.pendingDeleteIds("history-delete"), new Set(), "no History delete queued");
  assert.deepEqual(itemsOf(local.logs), [{ id: "L1", items: ["x"] }, { id: "L2", items: ["y", "z"] }], "both entries keep their items");
  assert.deepEqual(itemsOf(S.withoutBlockedItems([L1, L2])), [{ id: "L1", items: ["x"] }, { id: "L2", items: ["y", "z"] }], "uploads are not stripped");
  assert.equal(S.uploadBlockedIds("task").has("x") || S.uploadBlockedIds("task").has("y"), false, "no longer blocked");
});
test("r22 p1 variant: only the restore's own removal (by_restore) proves it; absent everywhere it stays deleted", () => {
  const q = S.queueDeleteIntents("task-delete", ["x", "w"]);
  S.confirmDeleteIntents("task-delete", ["x", "w"], q);
  const cloud = { tasks: [], history: [], restoreRemoved: new Set(["x"]), settings: { last_restore_at: q + 50 } };
  const local = { tasks: [], logs: [entry("L1", ["x"]), entry("L2", ["w", "k"])] };
  pass(local, cloud);
  const p = pass(local, cloud);
  assert.deepEqual(p.released, ["x"], "x came back by the restore (History-only, by_restore)");
  assert.deepEqual(p.staleItemIds, ["w"], "w's delete stands: final now");
  assert.deepEqual(itemsOf(p.rewritten), [{ id: "L2", items: ["k"] }]);
  assert.ok(confirmStates("task-delete").final.has("w"));
  // An unreadable source decides nothing absent (complete false): a record stays superseded.
  const q2 = S.queueDeleteIntents("task-delete", ["v"]);
  S.confirmDeleteIntents("task-delete", ["v"], q2);
  noteRestoreKnown(q2 + 100);
  const p3 = pass(local, { ...cloud, restoreRemoved: null, settings: { last_restore_at: q2 + 100 } });
  assert.deepEqual(p3.released, []);
  assert.ok(confirmStates("task-delete").superseded.has("v"), "still waiting");
  assert.equal(S.giveBackRule(0)("task", "v"), "keep");
});

// ─── #5/#7 (r22 p2-persistlog-voided-item, p2-persist-strips-voided) ───
test("r22 p2-persistlog-voided-item: the item of a pending delete survives the void (queued and replayed with it)", () => {
  const queuedAt = S.queueDeleteIntents("task-delete", ["y"]);           // the phone's bulk delete of y, call lost
  const L = { id: "L", timestamp: 1, tasks: [item("x"), item("y")] };
  failWrites = null;
  const r = persistLog(L);
  assert.deepEqual(itemsOf([r.queued]), [{ id: "L", items: ["x", "y"] }], "queued with y");
  assert.deepEqual(itemsOf(r.sent), [{ id: "L", items: ["x", "y"] }], "sent with y (its delete's transaction strips it)");
  S.addFailedSync({ kind: "history", id: "L", data: L });                  // the upload failed: still queued
  const dropped = S.dropDeleteIntentsBefore(queuedAt + 1);                // a restore voids y's delete
  assert.deepEqual(dropped.task, ["y"]);
  assert.deepEqual(itemsOf(replayHistory()), [{ id: "L", items: ["x", "y"] }], "the replay sends y");
});
test("r22 p2-persist-strips-voided: another tab's pending delete, a restore before this tab's guard: the replay keeps y", () => {
  const T = S.queueDeleteIntents("task-delete", ["y"], C.serverNow() - 1000);
  const Rt = T + 10;   // before this tab queues its upload below (a restore this tab's guard has not seen yet)
  const L = { id: "L", timestamp: T - 1000, tasks: [item("y"), item("z")] };
  S.addFailedSync({ kind: "history", id: "L", data: persistLog(L).queued });
  const g = S.restoreGuard({ last_restore_at: Rt });
  assert.deepEqual(g.voided.task, ["y"]);
  const sent = replayHistory();
  assert.deepEqual(itemsOf(sent), [{ id: "L", items: ["y", "z"] }]);
});
test("History strip: only FINAL confirmed items go; superseded and in-flight items hold the entry back; pending items stay", () => {
  S.queueDeleteIntents("task-delete", ["p"], 4000);                        // pending
  S.queueDeleteIntents("task-delete", ["s"], 1000);
  S.confirmDeleteIntents("task-delete", ["s"], 1000);
  noteRestoreKnown(2000);                                               // s: superseded
  S.queueDeleteIntents("task-delete", ["c"], 3000);
  S.confirmDeleteIntents("task-delete", ["c"], 3000);                     // c: final (queued after the restore)
  beginFlight({ "task-delete": ["f"] }, 5000);                    // f: in flight
  const plan = historyUploadPlan([entry("a", ["c"]), entry("b", ["p", "c", "k"]), entry("e", []), entry("d", ["s", "k"]), entry("g", ["f"]), entry("h", ["s", "c"])]);
  assert.deepEqual(itemsOf(plan.upload), [{ id: "b", items: ["p", "k"] }, { id: "e", items: [] }]);
  assert.deepEqual([plan.skip, plan.defer], [["a"], ["d", "g", "h"]]);
});

// ─── #1 (r22 p1-skip-then-void): a stale tab's voided clear with no restore before it ───
test("r22 #1: the voided clear does NOT give back x; x is never uploaded and its stash part goes once decided", () => {
  const now = C.serverNow(), T1 = now - 60_000, T2 = now - 30_000, Rt = now - 5_000;
  const x = task("x");
  S.queueDeleteIntents("task-delete", ["x"], T1);                         // tab A: bulk delete, call sent
  const flightA = beginFlight({ "task-delete": ["x"] }, T1);
  S.writeClearStash(T2, S.buildClearStash({ uploads: [], tasks: [x], cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.queueDeleteIntents("task-delete", ["x"], T2);                         // tab B's stale Clear Outputs moves x to T2
  S.confirmDeleteIntents("task-delete", ["x"], T1);                       // A thaws: the server deleted x at T1
  endFlight(flightA);
  assert.ok(S.confirmedDeletes("task-delete").has("x"), "the late confirm records x (the B8c skip is gone)");
  assert.equal(confirmQueuedAt("task-delete").get("x"), T1, "with T1, its group's queue time");
  const local = { tasks: [], logs: [] };
  const p1 = pass(local, { tasks: [], history: [], settings: { last_restore_at: Rt } });   // the PC's restore voids T2
  assert.deepEqual(p1.guard.voided.task, ["x"]);
  assert.deepEqual(p1.stashBack, [], "not given back (superseded, undecided: kept)");
  assert.deepEqual(S.uploadable("task", [x]), [], "and blocked");
  const p2 = pass(local, { tasks: [], history: [], settings: { last_restore_at: Rt } });
  assert.deepEqual([p2.released, p2.stashBack, p2.taskUploads], [[], [], []], "decided: x stays deleted, never uploaded");
  assert.ok(confirmStates("task-delete").final.has("x"));
  const p3 = pass(local, { tasks: [], history: [], settings: { last_restore_at: Rt } });
  assert.deepEqual([p3.stashBack, p3.taskUploads, local.tasks], [[], [], []], "the next give-back leaves x out");
  assert.equal(S.readClearStash(T2), null, "nothing of x is kept in the stash");
});

// ─── #2 (r22 p2-moved-inflight-inline-void): another tab's call in flight ───
test("r22 #2: no give-back and no upload while the other tab's call is in flight; its later 'deleted' leaves x blocked", () => {
  const now = C.serverNow(), T1 = now - 60_000, T2 = now - 30_000;
  const x = task("x");
  S.queueDeleteIntents("task-delete", ["x"], T1);
  const flightA = beginFlight({ "task-delete": ["x"] }, T1);
  const flights = JSON.parse(mem.get("proximaai-deletes-in-flight") || "{}");
  if (flights[flightA]) flights[flightA].tab = "tab-A";                   // tab A's call, not this tab's
  mem.set("proximaai-deletes-in-flight", JSON.stringify(flights));
  S.writeClearStash(T2, S.buildClearStash({ uploads: [], tasks: [x], cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.queueDeleteIntents("task-delete", ["x"], T2);                         // B's stale clear
  const flightB = beginFlight({ "task-delete": ["x"] }, T2);
  // B's clear answers "voided" (the PC's restore landed during it): App.jsx's inline voided branch.
  S.voidDeleteIntents("task-delete", ["x"], T2);
  const back = S.inlineVoidPutBack(T2, { tasks: [x] });
  endFlight(flightB);
  assert.deepEqual(back.tasks, [], "x is not put back while A's call is in flight");
  assert.ok(inFlightIds("task-delete").has("x"), "A's entry stays (B's void lands only B's own)");
  assert.deepEqual(S.uploadable("task", [x]), [], "x blocked for uploads");
  const local = { tasks: [], logs: [] };
  const pB = pass(local, { tasks: [], history: [] });
  assert.deepEqual([pB.taskUploads, pB.stashBack], [[], []], "B's pass uploads nothing");
  assert.equal(S.giveBackRule(T2)("task", "x"), "keep");
  S.confirmDeleteIntents("task-delete", ["x"], T1);                       // A thaws: "deleted" for T1
  endFlight(flightA);
  assert.ok(S.uploadBlockedIds("task").has("x"), "x stays blocked after A's answer");
  assert.ok(confirmStates("task-delete").superseded.has("x"), "superseded by the restore B's void proved");
  const p1 = pass(local, { tasks: [], history: [] });
  assert.deepEqual([p1.released, p1.taskUploads], [[], []], "the cloud lacks x: never released, never uploaded");
  assert.ok(confirmStates("task-delete").final.has("x"));
  assert.equal(S.giveBackRule(T2)("task", "x"), "gone");
});
test("in flight: a foreign tab's entry is not landed by this tab's answer, ends with its call, and lapses after 30 min", () => {
  const f = beginFlight({ "task-delete": ["a"], "history-delete": ["L"], other: ["z"] }, 1000);
  assert.deepEqual([[...inFlightIds("task-delete")], [...inFlightIds("history-delete")]], [["a"], ["L"]]);
  assert.deepEqual(S.uploadable("history", ["L", "M"]), ["M"], "an entry in flight is not uploaded");
  S.addFailedSync({ kind: "history", id: "L", data: entry("L", []) });
  assert.equal(S.getFailedSyncs().some(e => e.id === "L"), false, "nor queued");
  const m = JSON.parse(mem.get("proximaai-deletes-in-flight"));
  m[f].tab = "tab-A";
  mem.set("proximaai-deletes-in-flight", JSON.stringify(m));
  S.confirmDeleteIntents("task-delete", ["a"], 1000);
  assert.ok(inFlightIds("task-delete").has("a"), "another tab's call keeps its entry");
  endFlight(f);
  assert.equal(mem.has("proximaai-deletes-in-flight"), false, "its finally removes it");
  const g = beginFlight({ "task-delete": ["b"] }, 2000);
  S.voidDeleteIntents("task-delete", ["b"], 2000);
  assert.equal(inFlightIds("task-delete").has("b"), false, "this tab's own void lands its own entry");
  endFlight(g);
  mem.set("proximaai-deletes-in-flight", JSON.stringify({ dead: { tab: "t", at: 1, until: Date.now() - 1, ids: { "task-delete": ["k"] } } }));
  assert.equal(inFlightIds("task-delete").has("k"), false, "a killed tab's entry lapses");
  for (const bad of ["5", "[1]", '{"c":5}', '{"c":{"until":"x","ids":5}}', "{nope"]) {
    mem.set("proximaai-deletes-in-flight", bad);
    assert.deepEqual([...inFlightIds("task-delete")], [], `malformed ${bad}`);
    const h = beginFlight({ "task-delete": ["q"] }, 3);
    assert.ok(inFlightIds("task-delete").has("q"), `a call still records itself over ${bad}`);
    endFlight(h);
  }
});

// ─── #3 (r22 p3-forged-seqs): malformed shared records ───
test("r22 #3: a malformed confirmed-seqs (or confirmed-queued / confirmed-deletes / restore-known) value: confirms still recorded", () => {
  const cases = [["proximaai-confirmed-seqs", '{"task-delete":5}'], ["proximaai-confirmed-seqs", '{"task-delete":"x"}'], ["proximaai-confirmed-seqs", '{"task-delete":true}'],
    ["proximaai-confirmed-seqs", "[1,2]"], ["proximaai-confirmed-seqs", "{bad json"], ["proximaai-confirmed-queued", '{"task-delete":5}'],
    ["proximaai-confirmed-queued", '{"task-delete":{"x":7}}'], ["proximaai-confirmed-deletes", '{"task-delete":5}'], ["proximaai-confirmed-deletes", "7"],
    ["proximaai-restore-known", "nope"]];
  for (const [key, bad] of cases) {
    mem.clear();
    mem.set(key, bad);
    const at = S.queueDeleteIntents("task-delete", ["x"]);
    S.confirmDeleteIntents("task-delete", ["x"], at);
    const tag = `${key}=${bad}`;
    assert.equal(S.pendingDeleteIds("task-delete").has("x"), false, `${tag}: settled`);
    assert.ok(S.confirmedDeletes("task-delete").has("x"), `${tag}: recorded`);
    assert.ok(S.uploadBlockedIds("task").has("x"), `${tag}: blocked`);
    assert.equal(S.giveBackRule(0)("task", "x"), "gone", `${tag}: final`);
  }
});
test("r22 #3: a record that cannot be written settles nothing (the replay sends the group again); a failed seq write changes nothing", () => {
  const at = S.queueDeleteIntents("task-delete", ["x"]);
  failWrites = "proximaai-confirmed-deletes";
  S.confirmDeleteIntents("task-delete", ["x"], at);
  failWrites = null;
  assert.ok(S.pendingDeleteIds("task-delete").has("x"), "the intent is still pending");
  assert.ok(S.uploadBlockedIds("task").has("x"));
  failWrites = "proximaai-confirmed-seqs";
  S.confirmDeleteIntents("task-delete", ["x"], at);
  failWrites = null;
  assert.equal(S.pendingDeleteIds("task-delete").has("x"), false);
  assert.ok(S.confirmedDeletes("task-delete").has("x"), "recorded without its sequence (seq 0)");
  assert.equal(S.confirmSeqs("task-delete").get("x"), 0);
});

// ─── round 21 #8: a late T1 confirm after a restore brought x back, x re-queued at T2, T2 voided ───
test("r21 #8: x comes back once the pass sees x in the cloud after the restore that voided T2", () => {
  const now = C.serverNow(), T1 = now - 90_000, R1 = now - 80_000, T2 = now - 60_000, R2 = now - 30_000;
  const x = task("x"), up = { kind: "task", id: "x", data: { ...x, outputs: ["https://ws/x-new.png"] }, ts: R1 + 1000, attempts: 1 };
  const local = { tasks: [], logs: [] };
  S.queueDeleteIntents("task-delete", ["x"], T1);                         // deleted at T1; A's call goes unanswered
  const flightA = beginFlight({ "task-delete": ["x"] }, T1);
  pass(local, { tasks: ["x"], history: [], settings: { last_restore_at: R1 } });   // R1 brings x back (voids T1 here)
  S.putBackQueuedUploads([up]);                                          // x changed here after the restore
  S.writeClearStash(T2, S.buildClearStash({ tasks: [x], uploads: S.peekQueuedUploads(["task"]), cloudTaskIds: new Set() }));
  S.takeQueuedUploads("task", ["x"]);
  S.queueDeleteIntents("task-delete", ["x"], T2);                         // cleared again at T2
  S.confirmDeleteIntents("task-delete", ["x"], T1);                       // T1's "deleted" handled only now
  endFlight(flightA);
  assert.ok(confirmStates("task-delete").superseded.has("x"), "T1 < R1: superseded");
  assert.deepEqual(S.intentGroups("task-delete"), [[T2, ["x"]]], "T2 still pending");
  const p1 = pass(local, { tasks: ["x"], history: [], settings: { last_restore_at: R2 } });   // R2 voids T2
  assert.deepEqual(p1.guard.voided.task, ["x"]);
  assert.deepEqual(p1.stashBack, [], "undecided at the give-back: kept, not lost");
  assert.ok(S.readClearStash(T2), "the stash still holds x");
  assert.deepEqual(p1.released, ["x"], "the cloud holds x after R1 (known before the reads): T1's confirm is released");
  const p2 = pass(local, { tasks: ["x"], history: [], settings: { last_restore_at: R2 } });
  assert.deepEqual(p2.stashBack, ["x"], "the next give-back returns x");
  assert.deepEqual(S.uploadable("task", S.getFailedSyncs().filter(e => e.kind === "task")).map(e => e.data.outputs), [["https://ws/x-new.png"]], "with its upload");
});

// ─── give-back rule ───
test("giveBackRule: pending elsewhere / in flight / superseded -> keep; final -> gone; else back (no time comparison)", () => {
  const at = 5000;
  S.queueDeleteIntents("task-delete", ["pend"], 9000);
  beginFlight({ "task-delete": ["fly"] }, 7000);
  S.confirmDeleteIntents("task-delete", ["fin", "early"], 6000);
  S.confirmDeleteIntents("task-delete", ["sup"], 1000);
  mem.set("proximaai-restore-known", "3000");
  const rule = S.giveBackRule(at);
  assert.deepEqual(["pend", "fly", "sup", "fin", "free"].map(id => rule("task", id)), ["keep", "keep", "keep", "gone", "back"]);
  assert.equal(rule("setting", "x"), "back");
  assert.doesNotMatch(st.slice(st.indexOf("export function giveBackRule("), st.indexOf("// A stash's uploads and archive records")), /c > ts|> ts \?/, "no 'confirmed after the clear' comparison");
});
test("B8c removed: a late confirm records every id it answers, even one pending again at a later time", () => {
  S.queueDeleteIntents("history-delete", ["L"], 1000);
  S.queueDeleteIntents("history-delete", ["L"], 3000);
  S.confirmDeleteIntents("history-delete", ["L"], 1000);
  assert.ok(S.confirmedDeletes("history-delete").has("L"));
  assert.deepEqual(S.intentGroups("history-delete"), [[3000, ["L"]]], "the later intent is untouched");
  const c = st.slice(st.indexOf("export function confirmDeleteIntents("), st.indexOf("export function forgetConfirmed("));
  assert.doesNotMatch(c, /later\.add|later\.has/, "no skip");
});

// ─── old-build compatibility (a1623bf, embedded verbatim) ───
function a1623bf({ getFailedSyncs, serverNow, settleDeleteIntents, forgetStashedIds, dropQueuedUploadsOf }) {
// ---- git show a1623bf:src/lib/storage.js, lines 756-886, verbatim (export keywords removed) ----
const CONFIRMED_KEY = "proximaai-confirmed-deletes";
const CONFIRMED_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const readConfirmed = () => { try { return JSON.parse(localStorage.getItem(CONFIRMED_KEY) || "{}") || {}; } catch { return {}; } };
// Task B8a (review round 21 #6): every record's value is a plain server time (withoutConfirmedUploads compares it with
// upload stamps), exactly as the builds before 21d8266 write it: a tab still running such a build prunes the record with
// `if (!(at > cut)) delete`, which deleted every {at, seq} object 21d8266 wrote. The confirm sequence (releaseRestored
// compares it with a pass's start) lives in its own key, kind -> id -> seq, pruned with the record. An id without one
// (written by an older build) is seq 0, i.e. confirmed before any pass. A 21d8266 {at, seq} object still reads (its own
// seq wins) and is rewritten in the new layout by the next confirm.
const CONFIRM_SEQS_KEY = "proximaai-confirmed-seqs";
const readConfirmSeqs = () => { try { const v = JSON.parse(localStorage.getItem(CONFIRM_SEQS_KEY) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const recordAt = (v) => (v && typeof v === "object" ? Number(v.at) || 0 : Number(v) || 0);
const confirmRecord = (v, seq) => (v && typeof v === "object" ? { at: recordAt(v), seq: Number(v.seq) || 0 } : { at: recordAt(v), seq: Number(seq) || 0 });
// The sequences of ids no longer in the record go (an older build's prune or forget left them behind).
const pruneConfirmSeqs = (seqs, all) => {
  for (const k of Object.keys(seqs)) {
    for (const id of Object.keys(seqs[k] || {})) if (!(all[k] && id in all[k])) delete seqs[k][id];
    if (!Object.keys(seqs[k] || {}).length) delete seqs[k];
  }
  return seqs;
};
const writeConfirmSeqs = (seqs) => {
  if (Object.keys(seqs).length) localStorage.setItem(CONFIRM_SEQS_KEY, JSON.stringify(seqs));
  else localStorage.removeItem(CONFIRM_SEQS_KEY);
};
// Task B7a (review round 20 #4): "confirmed before this pass" is decided by ORDER, not by time. A shared counter (every
// tab of this browser) numbers each confirm call; a reconcile pass takes the counter value at its start
// (confirmSeqNow), and a confirm made after that has a seq >= it, whatever the server-clock offset did meanwhile.
const CONFIRM_SEQ_KEY = "proximaai-confirm-seq";
function confirmSeqNow() {
  try { return Math.max(1, Math.floor(Number(localStorage.getItem(CONFIRM_SEQ_KEY))) || 1); } catch { return 1; }
}
function takeConfirmSeq() {
  const seq = confirmSeqNow();
  try { localStorage.setItem(CONFIRM_SEQ_KEY, String(seq + 1)); } catch {}
  return seq;
}
// Returns the archived file paths of confirmed tasks that a clear's stash held (forgetStashedIds): the caller queues
// them for deletion through the file-delete queue.
// Task B7b (review round 20 #7): `at` is the queue time of the group the cloud answered (App.jsx passes it at every
// confirm site). Only intents queued at or before it are settled: an id a later delete re-queued (its intent moved to a
// later time, e.g. after a restore brought it back) keeps that intent, so that delete is still sent (the server answers
// "deleted" if nothing is left). `at` omitted: every queue time (no App.jsx caller; scripts/test-delete-wiring.mjs).
// Task B8a (review round 21 #8): the clean-up is bounded the same way. Only the stashes of clears queued at or before
// `at` lose the confirmed ids, and only queued uploads stamped at or before `at` are dropped: a later delete's stash and a
// later upload (both after a restore brought the id back) keep their content for that later delete to decide. The
// confirm record is written for every id it confirms (sharedDeleteState releases it once a restore's row is back).
// Task B8c (review round 21 #3 follow-up): an id that still has a pending intent of this kind at a LATER time than `at`
// (a restore brought it back and a later delete re-queued it) is skipped entirely: no confirm record, no sequence, no
// stash strip, no queued-upload drop. Only that later delete's own answer decides it (its confirm records it then, its
// void gives it back through giveBackRule). A late answer of an older group therefore never leaves a record that would
// hold back what a void of the later delete puts back. Every other id is confirmed as before.
function confirmDeleteIntents(kind, ids, at) {
  const isDelete = kind === "task-delete" || kind === "history-delete";
  const bound = at == null ? null : Number(at);
  if (bound != null && Number.isFinite(bound)) {
    const later = new Set();
    for (const e of getFailedSyncs()) if (e.kind === kind && e.id && (e.ts || 0) > bound) later.add(e.id);
    if (later.size) ids = (ids || []).filter(id => !later.has(id));
  }
  // The record first (task B7a): another tab must never see the id with neither its intent nor its confirm.
  if (isDelete) {
    try {
      // Server time, like the queued uploads' stamps (addFailedSync) that withoutConfirmedUploads compares it with: a
      // device clock off by more than a few ms would otherwise keep a stale upload or drop a real one (round 19
      // follow-up, scripts/test-confirm-clock.mjs). The sequence orders it against reconcile passes (round 20 #4).
      const all = readConfirmed(), seqs = readConfirmSeqs(), now = serverNow(), cut = now - CONFIRMED_FOR_MS, seq = takeConfirmSeq();
      for (const k of Object.keys(all)) for (const [id, v] of Object.entries(all[k] || {})) {
        if (!(recordAt(v) > cut)) { delete all[k][id]; continue; }
        // A 21d8266 object: back to a plain number, its seq into the separate key (round 21 #6).
        if (v && typeof v === "object") { all[k][id] = recordAt(v); (seqs[k] = seqs[k] || {})[id] = Number(v.seq) || 0; }
      }
      all[kind] = all[kind] || {};
      seqs[kind] = seqs[kind] || {};
      for (const id of ids || []) if (id) { all[kind][id] = now; seqs[kind][id] = seq; }
      // The sequences first: a reader that sees the new time also finds its sequence.
      writeConfirmSeqs(pruneConfirmSeqs(seqs, all));
      localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
    } catch {}
  }
  settleDeleteIntents(kind, ids, at);
  if (!isDelete) return [];
  // A delete the cloud confirmed is never given back by a later void of its clear (review round 15 S2), up to its time.
  const paths = forgetStashedIds(kind, ids, at);
  // Nor uploaded again (review round 19 #2): a queued upload of a confirmed id (one a give-back put back while its delete
  // was pending, or a stale tab's) would re-insert a row the server holds no tombstone for. Up to its time (round 21 #8).
  dropQueuedUploadsOf(kind === "task-delete" ? "task" : "history", ids, at);
  return paths;
}
// A new delete of these ids starts: their older confirmations no longer say anything (a restore brought them back and
// they are going again). Task B8a (review round 21 #2/#7): called only right after that delete's own intents are queued
// (App.jsx), so the pending intent blocks the id in every tab from then on and releaseRestored skips it; called earlier,
// a delete aborted before queueing (a failed safety backup) left the id with neither record nor intent. Forgotten, not
// kept: kept, a void of the new delete would leave this older record behind, and every put-back upload of the id would be
// dropped as a confirmed delete's (uploadable) until a pass released it.
function forgetConfirmed(kind, ids) {
  try {
    const all = readConfirmed(), seqs = readConfirmSeqs();
    if (!all[kind] && !seqs[kind]) return;
    for (const id of ids || []) { if (all[kind]) delete all[kind][id]; if (seqs[kind]) delete seqs[kind][id]; }
    localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
    writeConfirmSeqs(pruneConfirmSeqs(seqs, all));
  } catch {}
}
// The live records of one kind (recorded within 30 days): id -> { at, seq }.
function confirmRecords(kind) {
  const cut = serverNow() - CONFIRMED_FOR_MS, seqs = readConfirmSeqs()[kind] || {};
  return Object.entries(readConfirmed()[kind] || {}).map(([id, v]) => [id, confirmRecord(v, seqs[id])]).filter(([, r]) => r.at > cut);
}
// id -> the confirm's server time, recorded within 30 days.
function confirmedDeletes(kind) {
  return new Map(confirmRecords(kind).map(([id, r]) => [id, r.at]));
}
// id -> the confirm's sequence (confirmSeqNow), for the same records (0: none recorded).
function confirmSeqs(kind) {
  return new Map(confirmRecords(kind).map(([id, r]) => [id, r.seq]));
}
// A restore brought these confirmed ids back (syncReconcile.js releaseRestored): their records go, so every tab may
// upload them again. Re-checked at the write: a record confirmed again at or after `sinceSeq` (deleted again during
// the pass) stays. Returns the ids released.
function releaseConfirmed(kind, ids, sinceSeq) {
  const out = [];
  try {
    const all = readConfirmed(), recs = all[kind], seqs = readConfirmSeqs();
    if (!recs) return out;
    const own = seqs[kind] || {};
    for (const id of ids || []) if (id in recs && confirmRecord(recs[id], own[id]).seq < sinceSeq) { delete recs[id]; out.push(id); }
    if (out.length) { localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all)); writeConfirmSeqs(pruneConfirmSeqs(seqs, all)); }
  } catch {}
  return out;
}
// ---- end of a1623bf ----
  return { confirmDeleteIntents, forgetConfirmed, confirmedDeletes, confirmSeqs, releaseConfirmed };
}
const OLDB = a1623bf({ getFailedSyncs: S.getFailedSyncs, serverNow: C.serverNow, settleDeleteIntents: S.settleDeleteIntents,
  forgetStashedIds: () => [], dropQueuedUploadsOf: () => {} });
test("old build reads this build's records: plain-number record, sequence in its key, nothing pruned by its confirm", () => {
  const at = S.queueDeleteIntents("task-delete", ["x"]);
  S.confirmDeleteIntents("task-delete", ["x"], at);
  const c = S.confirmedDeletes("task-delete").get("x"), seq = S.confirmSeqs("task-delete").get("x");
  assert.equal(OLDB.confirmedDeletes("task-delete").get("x"), c, "a1623bf reads the record");
  assert.equal(OLDB.confirmSeqs("task-delete").get("x"), seq, "and its sequence");
  assert.equal(typeof JSON.parse(mem.get("proximaai-confirmed-deletes"))["task-delete"].x, "number");
  assert.equal(typeof JSON.parse(mem.get("proximaai-confirmed-seqs"))["task-delete"].x, "number");
  OLDB.confirmDeleteIntents("task-delete", ["y"], S.queueDeleteIntents("task-delete", ["y"]));
  assert.ok(S.confirmedDeletes("task-delete").has("x") && S.confirmedDeletes("task-delete").has("y"), "the old confirm kept x");
  assert.equal(confirmQueuedAt("task-delete").get("x"), at, "x keeps its queue time");
  // A cleaned malformed value is still the layout the old build reads.
  mem.set("proximaai-confirmed-seqs", '{"task-delete":5,"history-delete":{"L":3}}');
  S.confirmDeleteIntents("task-delete", ["z"], S.queueDeleteIntents("task-delete", ["z"]));
  assert.ok(OLDB.confirmSeqs("task-delete").get("z") > 0, "the old reader finds z's sequence");
  assert.equal(OLDB.confirmSeqs("history-delete").get("L"), undefined, "(L has no record: pruned, as the old build prunes it)");
});
test("this build reads the old build's records: its own time as the queue time; a stale queue entry is ignored", () => {
  const at = S.queueDeleteIntents("task-delete", ["y"]);
  OLDB.confirmDeleteIntents("task-delete", ["y"], at);
  const c = S.confirmedDeletes("task-delete").get("y");
  assert.ok(c > 0, "read");
  assert.equal(confirmQueuedAt("task-delete").get("y"), c, "no queue time recorded: the record's own time");
  assert.ok(confirmStates("task-delete").final.has("y"), "final while no restore is known after it");
  noteRestoreKnown(c + 1);
  assert.ok(confirmStates("task-delete").superseded.has("y"), "superseded by a restore after it");
  mem.clear();
  const q1 = S.queueDeleteIntents("task-delete", ["x"]);
  S.confirmDeleteIntents("task-delete", ["x"], q1 - 10_000);
  const c1 = S.confirmedDeletes("task-delete").get("x");
  OLDB.forgetConfirmed("task-delete", ["x"]);                             // an old tab's new delete of x ...
  const q2 = S.queueDeleteIntents("task-delete", ["x"]);
  while (C.serverNow() <= c1) {}
  OLDB.confirmDeleteIntents("task-delete", ["x"], q2);                     // ... confirmed by the old build
  const c2 = S.confirmedDeletes("task-delete").get("x");
  assert.equal(confirmQueuedAt("task-delete").get("x"), c2, "the earlier confirm's queue time no longer applies");
  assert.deepEqual(OLDB.releaseConfirmed("task-delete", ["x"], S.confirmSeqNow() + 1), ["x"]);
  assert.equal(S.confirmedDeletes("task-delete").has("x"), false, "released by the old build: gone here too");
});

// ─── App.jsx wiring ───
test("wiring: every delete call records itself in flight before it fires and ends it in a finally", () => {
  const calls = [["const replayDeleteIntents = async", "deleteQueuedRemote("], ["const dropLogItemsFor = useCallback(", "deleteHistoryRemote("],
    ["const purgeEverywhere = useCallback(", "deleteHistoryRemote("], ["const deleteSelectedTasks = async", "deleteTasksRemote("],
    ["const deleteSelectedLogs = async", "deleteHistoryRemote("], ["const cloudLogIds = isSupabaseConfigured()", "clearQueuedRemote(\"history\""],
    ["const rowIds = realTasks.map(t => t.id);", "clearQueuedRemote(\"task\""], ["const clearedLogIds = [...plannedLogIds];", "resetQueuedRemote("]];
  for (const [from, call] of calls) {
    const i = src.indexOf(from); assert.ok(i >= 0, from);
    const c = src.indexOf(call, i), b = src.lastIndexOf("beginDeleteFlight(", c);
    assert.ok(c > i && b > i, `${from}: in flight before ${call}`);
    assert.ok(src.indexOf("endDeleteFlight(", c) > c, `${from}: ended after`);
  }
  assert.equal(src.match(/beginDeleteFlight\(/g).length, 8, "eight delete calls");
  assert.equal(src.match(/finally \{[^}]*endDeleteFlight\(|\.finally\(\(\) => endDeleteFlight\(|endDeleteFlight\(taskFlight\)|endDeleteFlight\(logFlight\)/g).length, 8, "each ended in a finally");
  for (const fn of ["deleteTasksRemote", "deleteHistoryRemote", "deleteQueuedRemote", "clearQueuedRemote", "resetQueuedRemote"])
    assert.equal((src.match(new RegExp(`\\b${fn}\\(`, "g")) || []).length, { deleteTasksRemote: 1, deleteHistoryRemote: 3, deleteQueuedRemote: 1, clearQueuedRemote: 2, resetQueuedRemote: 1 }[fn], fn);
});
test("wiring: the reconcile decides superseded confirms from the cloud after the restore; History uploads plan with historyUploadPlan", () => {
  const rc = between("const reconcileWithCloud = useCallback(", "\n  }, []);");
  const known = rc.indexOf("const restoreKnownAt = knownRestoreAt();"), reads = rc.indexOf("await Promise.all([pullAllRemoteData(), pullCloudIds()])");
  assert.ok(known > 0 && reads > known, "the restore known before the reads");
  assert.match(rc, /sharedDeleteState\("task", \{[^;]*restoreKnownAt,\s*evidence: \{ present: \[\.\.\.\(cloudItemIds \|\| \[\]\), \.\.\.\(restoreRemoved \|\| \[\]\)\], complete: !!cloudItemIds && !!restoreRemoved \} \}\);/);
  assert.match(rc, /sharedDeleteState\("history", \{[^;]*restoreKnownAt \}\);/);
  assert.match(rc, /const logUploads = historyUploadPlan\(uploadable\("history", logPlan\.upload\.slice\(0, 100\)\)\)\.upload;/);
  assert.match(between("const replayHistoryUploads = async", "\n  };"), /const \{ upload, skip \} = historyUploadPlan\(/);
  assert.doesNotMatch(src, /withoutDeleting\([^;]*(uploadBlockedIds|pendingDeleteIds)\(/, "no History upload strips pending ids");
  const pl = between("const persistLog = useCallback(", "}, [trackedSync]);");
  assert.match(pl, /const send = historyUploadPlan\(\[entry\]\)\.defer\.length \? entry : withoutBlockedItems\(\[entry\]\)\[0\];/);
  assert.match(pl, /\.then\(\(sent\) => \{ if \(sent\?\.length\) removeFailedSync\("history", send\.id/, "the queue entry goes only with a sent upload");
  assert.match(st.slice(st.indexOf("export function restoreGuard("), st.indexOf("export function deletesGoingSince(")), /if \(known && restoreAt > 0\) noteRestoreKnown\(restoreAt\);/);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
