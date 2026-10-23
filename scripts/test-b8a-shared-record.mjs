// Task B8a (review round 21 #1/#5, #2/#7, #6, #8): the shared delete record (the failed-sync queue's delete intents and the
// confirmed-deletes record, shared by every tab of this browser) keeps a deleted generation out of every History upload,
// is never erased before a new delete's intent is queued, survives a tab still running the previous build, and a late
// confirm cleans only up to its own group's time. Runs the real storage.js, syncReconcile.js, batchLog.js and purge.js;
// the App.jsx wiring is checked from its source. Run: node scripts/test-b8a-shared-record.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const C = await import("../src/lib/serverClock.js");
const S = await import("../src/lib/storage.js");
const R = await import("../src/lib/syncReconcile.js");
const B = await import("../src/lib/batchLog.js");
const P = await import("../src/lib/purge.js");

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};

let n = 0, failed = 0;
const test = (name, fn) => {
  try { mem.clear(); fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

const OLD = Date.now() - 10 * 60 * 1000;
const X = { id: "x", batchId: "L1", status: "completed", startTime: OLD, endTime: OLD + 1000, outputs: ["https://ws/x.png"] };
const L1 = { id: "L1", timestamp: OLD, prompt: "p", tasks: [{ id: "x", status: "completed", outputs: ["https://ws/x.png"] }] };
const NONE = () => ({ tasks: new Set(), history: new Set(), taskTombstones: new Set(), historyTombstones: new Set() });
const itemsOf = (logs) => logs.map(l => ({ id: l.id, items: (l.tasks || []).map(i => i.id) }));

// Tab A: bulk delete of local-only x (App.jsx deleteSelectedTasks + stagePurge with serverHistory): L1 (holding only x)
// is removed locally with no History intent of its own; the delete is confirmed.
function tabADeletesX(logs = [L1]) {
  S.addFailedSync({ kind: "task", id: "x", data: X });
  for (const l of logs) S.addFailedSync({ kind: "history", id: l.id, data: l });
  S.removeFailedSync("task", "x");
  const queuedAt = S.queueDeleteIntents("task-delete", ["x"]);
  const plan = P.planPurge(logs, [X], [], {});
  const send = B.clientHistoryWork(logs, plan);
  S.queueDeleteIntents("history-delete", send.remove);
  for (const id of plan.remove) S.removeFailedSync("history", id);
  S.confirmDeleteIntents("task-delete", ["x"], queuedAt);
  return { plan, send };
}

// Tab B's reconcile pass as App.jsx reconcileWithCloud runs it after task B8a: the stale step removes this tab's copies
// of confirmed deletes the cloud lacks AND takes their items out of this tab's History (dropLogItemsFor: an emptied entry
// gets its own History delete); the History uploads strip items of every task id the shared record blocks.
function tabBPass({ tasks, logs, ids = NONE() }) {
  const since = C.serverNow(), sinceSeq = S.confirmSeqNow();
  const taskDel = S.sharedDeleteState("task", { deleting: new Set(), cloudIds: ids.tasks, sinceSeq });
  const logDel = S.sharedDeleteState("history", { deleting: new Set(), cloudIds: ids.history, sinceSeq });
  const staleTasks = new Set(taskDel.stale(tasks)), staleLogs = new Set(logDel.stale(logs));
  const staleRows = tasks.filter(t => staleTasks.has(t.id));
  tasks = tasks.filter(t => !staleTasks.has(t.id)); logs = logs.filter(l => !staleLogs.has(l.id));
  // dropLogItemsFor(staleRows + the confirmed items this tab holds no task of)
  const staleItems = taskDel.stale(logs.flatMap(l => l.tasks || [])).filter(id => !staleTasks.has(id));
  const removed = [...staleRows, ...[...new Set(staleItems)].map(id => ({ id }))];
  const emptied = [];
  if (removed.length) {
    const { remove, rewrite } = B.purgeLogsForDeleted(logs, removed, tasks, { removeEntries: false });
    if (remove.length) { S.queueDeleteIntents("history-delete", remove); emptied.push(...remove); }
    const byId = new Map(rewrite.map(l => [l.id, l]));
    logs = logs.filter(l => !remove.includes(l.id)).map(l => byId.get(l.id) || l);
  }
  const failedQ = S.getFailedSyncs();
  const pendingLogs = new Set(failedQ.filter(f => f.kind === "history").map(f => f.id));
  const logPlan = R.planLogSync({ local: logs, cloud: [], cloudIds: ids.history, tombstones: ids.historyTombstones, pending: pendingLogs, deleting: logDel.deleting, since });
  const logUploads = S.historyUploadPlan(S.uploadable("history", logPlan.upload.slice(0, 100))).upload;   // task B9
  for (const l of logUploads) S.addFailedSync({ kind: "history", id: l.id, data: l });
  // sendHistory: the central guard
  const sent = S.uploadable("history", S.withoutBlockedItems(logUploads));
  return { staleTasks: [...staleTasks], emptied, logs, sent };
}

// ─── #1/#5: History of deleted generations ───
test("#1 (p1-stale-history-entry): B's reconcile neither uploads L1 nor keeps item x; L1 gets its own History delete", () => {
  const { plan, send } = tabADeletesX();
  assert.deepEqual([plan.remove, send.remove], [["L1"], []], "A removed L1 locally with no History intent (premise)");
  assert.equal(S.confirmedDeletes("history-delete").has("L1"), false, "no history confirm record for L1 (premise)");
  const p = tabBPass({ tasks: [X], logs: [L1] });
  assert.deepEqual(p.staleTasks, ["x"]);
  assert.deepEqual(p.logs, [], "B no longer holds L1");
  assert.deepEqual(p.emptied, ["L1"], "L1, emptied, is queued for its own History delete");
  assert.deepEqual(S.pendingDeleteIds("history-delete"), new Set(["L1"]));
  assert.deepEqual(p.sent, [], "nothing uploaded");
  assert.equal(S.getFailedSyncs().some(e => e.kind === "history"), false, "no History upload queued");
});
test("#5 variant: B holds L1 but not task x (History-only): item x leaves L1, and a mixed entry is rewritten without it", () => {
  const L2 = { id: "L2", timestamp: OLD, tasks: [{ id: "x", status: "completed", outputs: ["https://ws/x.png"] }, { id: "y", status: "completed", outputs: ["https://ws/y.png"] }] };
  tabADeletesX([L1]);
  const Y = { id: "y", batchId: "L2", status: "completed", startTime: OLD, endTime: OLD + 1000, outputs: ["https://ws/y.png"] };
  const p = tabBPass({ tasks: [Y], logs: [L1, L2] });
  assert.deepEqual(p.emptied, ["L1"]);
  assert.deepEqual(itemsOf(p.logs), [{ id: "L2", items: ["y"] }], "L2 keeps y only");
  assert.deepEqual(itemsOf(p.sent), [{ id: "L2", items: ["y"] }], "the upload carries no item x");
});
// Task B9 (review round 22 #5/#7) rewrote this test (was: pending items stripped too): a pending delete's item stays in
// the upload (its own transaction strips it on the server, and a void keeps it); a confirmed one's goes.
test("#1 guard: every History sender strips items of confirmed (final) task ids, not pending ones; an emptied entry is not sent", () => {
  S.queueDeleteIntents("task-delete", ["p"]);                    // pending in another tab
  const at = S.queueDeleteIntents("task-delete", ["c"]);
  S.confirmDeleteIntents("task-delete", ["c"], at);               // confirmed, not released
  const E = (id, items) => ({ id, timestamp: OLD, tasks: items.map(i => ({ id: i, status: "completed", outputs: [] })) });
  const out = S.withoutBlockedItems([E("a", ["c"]), E("b", ["p", "k"]), E("e", []), E("d", ["k", "c"])]);
  assert.deepEqual(itemsOf(out), [{ id: "b", items: ["p", "k"] }, { id: "e", items: [] }, { id: "d", items: ["k"] }]);
});
test("#1 wiring: the senders, the reconcile, replayHistoryUploads and persistLog strip blocked task items; the stale step drops their History", () => {
  for (const name of ["sendHistory", "sendHistoryEntry", "sendQueuedHistory"])
    assert.match(between(`async function ${name}(`, "\n}\n"), /const send = uploadable\("history", withoutBlockedItems\(/, name);
  // Task B9 (review round 22 #5/#7) rewrote these checks (were: withoutDeleting by uploadBlockedIds, pending included):
  // the reconcile and the replay plan through historyUploadPlan (final confirms only), and persistLog queues and sends
  // the entry as planned (held back as given while an item is superseded or in flight).
  assert.match(between("const logUploads =", "setFailedSyncCount"), /historyUploadPlan\(uploadable\("history", logPlan\.upload\.slice\(0, 100\)\)\)\.upload/);
  assert.match(between("const replayHistoryUploads = async", "\n  };"), /historyUploadPlan\(\[\.\.\.byId\.values\(\)\]\.map\(f => f\.data\)\)/);
  assert.doesNotMatch(src, /withoutDeleting\([^;]*(pendingDeleteIds|uploadBlockedIds)\(/, "no upload strips pending ids");
  // Review round 23 #4 rewrote this check (was: persistLog stripped final items itself): it queues the entry as given,
  // sends nothing while it holds a final item, and its sender never strips (the reconcile and the replays do).
  assert.match(between("const persistLog = useCallback(", "}, [trackedSync]);"), /const held = historyUploadPlan\(\[entry\], \{ strip: false \}\)\.defer\.length > 0;\s*const send = entry;[\s\S]*addFailedSync\(\{ kind: "history", id: send\.id, data: send \}\)[\s\S]*if \(held\) return Promise\.resolve\(\);[\s\S]*sendHistoryEntry\(send, \{ strip: false \}\)/);
  const rc = between("const reconcileWithCloud = useCallback(", "\n  }, []);");
  const stale = rc.indexOf("taskDel.stale(tasksRef.current)"), drop = rc.indexOf("dropLogItemsFor(staleGone)"), plan = rc.indexOf("const logPlan = planLogSync(");
  assert.ok(stale >= 0 && drop > stale && plan > drop, "the stale step runs dropLogItemsFor before History is planned");
});

// ─── #2/#7: forget only after the new intent is queued ───
test("#2 (p2-forget-on-abort): a re-delete aborted by a failed backup leaves the confirm record intact; the stale copy still goes", () => {
  const at = S.queueDeleteIntents("task-delete", ["x"]);
  S.confirmDeleteIntents("task-delete", ["x"], at);
  const before = mem.get("proximaai-confirmed-deletes"), seqBefore = S.confirmSeqs("task-delete").get("x");
  // Tab A's bulk delete: hold, then the safety backup fails -> return (forgetConfirmed only runs after queueDeleteIntents).
  assert.equal(mem.get("proximaai-confirmed-deletes"), before, "record unchanged");
  assert.equal(S.confirmSeqs("task-delete").get("x"), seqBefore);
  assert.ok(S.uploadBlockedIds("task").has("x"));
  const st = S.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(), sinceSeq: S.confirmSeqNow() });
  assert.deepEqual(st.stale([X]), ["x"], "A's next pass removes its stale copy");
  const plan = R.planTaskSync({ local: [], cloud: [], cloudIds: new Set(), tombstones: new Set(), pending: new Set(), deleting: st.deleting, since: C.serverNow() });
  assert.deepEqual(S.uploadable("task", [X, ...plan.upload]), [], "nothing uploaded");
  // The completed re-delete: queued first, then the old confirmation forgotten; the pending intent blocks meanwhile.
  const at2 = S.queueDeleteIntents("task-delete", ["x"]);
  S.forgetConfirmed("task-delete", ["x"]);
  assert.ok(S.uploadBlockedIds("task").has("x"), "blocked by the pending intent");
  assert.equal(S.confirmSeqs("task-delete").has("x"), false, "its sequence is forgotten with it");
  S.confirmDeleteIntents("task-delete", ["x"], at2);
  assert.ok(S.uploadBlockedIds("task").has("x"));
});
test("#2 wiring: both bulk deletes forget older confirmations only right after queueing their own intents", () => {
  for (const [name, kind] of [["const deleteSelectedTasks = async", "task-delete"], ["const deleteSelectedLogs = async", "history-delete"]]) {
    const h = between(name, "\n  };\n");
    const backup = h.indexOf("await createBackup("), q = h.indexOf(`const queuedAt = queueDeleteIntents("${kind}", ids);`), f = h.indexOf(`forgetConfirmed("${kind}", ids);`);
    assert.ok(backup >= 0 && q > backup && f > q, `${name}: forgetConfirmed after the backup and the intent`);
    assert.doesNotMatch(h.slice(q, f), /await /, `${name}: nothing awaited in between`);
    assert.equal(h.match(/forgetConfirmed\(/g).length, 1);
  }
});

// ─── #6: a tab still on the previous build ───
// The pre-21d8266 (9406e5b) record write, verbatim apart from its inputs (git show 21d8266^:src/lib/storage.js).
function oldBuildConfirmRecord(kind, ids) {
  const CONFIRMED_KEY = "proximaai-confirmed-deletes", CONFIRMED_FOR_MS = 30 * 24 * 60 * 60 * 1000;
  const readConfirmed = () => { try { return JSON.parse(localStorage.getItem(CONFIRMED_KEY) || "{}") || {}; } catch { return {}; } };
  const all = readConfirmed(), now = C.serverNow(), cut = now - CONFIRMED_FOR_MS;
  for (const k of Object.keys(all)) for (const [id, at] of Object.entries(all[k] || {})) if (!(at > cut)) delete all[k][id];
  all[kind] = all[kind] || {};
  for (const id of ids || []) if (id) all[kind][id] = now;
  localStorage.setItem(CONFIRMED_KEY, JSON.stringify(all));
}
test("#6: a record written by this build survives the previous build's prune; the sequence lives in its own key", () => {
  const at = S.queueDeleteIntents("task-delete", ["x"]);
  S.confirmDeleteIntents("task-delete", ["x"], at);
  const rec = JSON.parse(mem.get("proximaai-confirmed-deletes"));
  assert.equal(typeof rec["task-delete"].x, "number", "a plain server time, as the previous build wrote it");
  const seq = S.confirmSeqs("task-delete").get("x");
  assert.ok(seq >= 1, "its sequence is kept separately");
  oldBuildConfirmRecord("task-delete", ["y"]);                       // the old tab confirms an unrelated delete
  assert.ok(S.uploadBlockedIds("task").has("x"), "x is still blocked");
  assert.equal(S.confirmSeqs("task-delete").get("x"), seq, "and keeps its sequence");
  assert.equal(S.confirmSeqs("task-delete").get("y"), 0, "an id without a sequence counts as seq 0");
  const st = S.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(), sinceSeq: S.confirmSeqNow() });
  assert.deepEqual(st.stale([X]), ["x"], "a frozen new-build tab still drops its stale copy");
});
test("#6: the 21d8266 layout ({at, seq}) still reads, and a new confirm rewrites it as a number plus its sequence", () => {
  const now = C.serverNow();
  mem.set("proximaai-confirmed-deletes", JSON.stringify({ "task-delete": { a: { at: now - 5, seq: 7 }, gone: { at: now - 31 * 864e5, seq: 2 } } }));
  assert.equal(S.confirmedDeletes("task-delete").get("a"), now - 5);
  assert.equal(S.confirmSeqs("task-delete").get("a"), 7);
  const at = S.queueDeleteIntents("task-delete", ["b"]);
  S.confirmDeleteIntents("task-delete", ["b"], at);
  const rec = JSON.parse(mem.get("proximaai-confirmed-deletes"))["task-delete"];
  assert.deepEqual(Object.keys(rec).sort(), ["a", "b"], "expired record pruned");
  assert.equal(rec.a, now - 5, "rewritten as a plain number");
  assert.equal(S.confirmSeqs("task-delete").get("a"), 7, "its sequence moved to the separate key");
  const seqs = JSON.parse(mem.get("proximaai-confirmed-seqs"));
  assert.deepEqual(Object.keys(seqs["task-delete"]).sort(), ["a", "b"], "sequences pruned with the record");
  // release removes both
  assert.deepEqual(S.releaseConfirmed("task-delete", ["a"], 7), [], "confirmed at or after the pass start: kept");
  assert.deepEqual(S.releaseConfirmed("task-delete", ["a"], 8), ["a"]);
  assert.equal("a" in JSON.parse(mem.get("proximaai-confirmed-seqs"))["task-delete"], false);
});

// ─── #8: a late confirm cleans only up to its own time ───
test("#8: a late confirm of T1 keeps the T2 clear's stash and a later queued upload of x; T2's void gives x back", () => {
  const T1 = 1_000_000, T2 = 3_000_000;
  const x = { id: "x", status: "completed", outputs: ["https://ws/x.png"] };
  S.queueDeleteIntents("task-delete", ["x"], T1);
  const xv = { ...x, outputs: ["https://ws/x-final.png"] };
  mem.set("proximaai-failed-syncs", JSON.stringify([...JSON.parse(mem.get("proximaai-failed-syncs")), { kind: "task", id: "x", data: xv, ts: 2_500_000 }]));
  S.writeClearStash(T2, S.buildClearStash({ uploads: S.peekQueuedUploads(["task"]).filter(e => e.id === "x"), tasks: [], cloudTaskIds: new Set(["x"]) }));
  S.takeQueuedUploads("task", ["x"]);
  S.queueDeleteIntents("task-delete", ["x"], T2);
  assert.ok(S.recordStashArchive("x", { paths: ["archive/x-0.png"], task: { ...xv, isArchived: true } }));
  // A later upload of another restored id, queued after T1, and a stale one queued before it.
  mem.set("proximaai-failed-syncs", JSON.stringify([...JSON.parse(mem.get("proximaai-failed-syncs")),
    { kind: "task", id: "z", data: { id: "z", v: "late" }, ts: 2_000_000 }, { kind: "task", id: "w", data: { id: "w" }, ts: 500_000 }]));
  const paths = S.confirmDeleteIntents("task-delete", ["x", "z", "w"], T1);
  assert.deepEqual(paths, [], "no archive path sent to the file-delete queue");
  assert.deepEqual(S.intentGroups("task-delete"), [[T2, ["x"]]], "T2's intent still pending");
  const s = S.readClearStash(T2);
  assert.deepEqual([s.uploads.map(e => e.id), Object.keys(s.archives || {})], [["x"], ["x"]], "T2's stash keeps x's upload and archive");
  const q = S.getFailedSyncs().filter(e => e.kind === "task").map(e => e.id);
  assert.deepEqual(q, ["z"], "the upload queued after T1 stays, the one before it goes");
  // Task B9 (review round 22 #1) restored the original assertion (B8c had rewritten it to "no record"): the late confirm
  // records x with T1, its group's queue time; T2's pending intent still decides x's uploads.
  assert.ok(S.confirmedDeletes("task-delete").has("x"), "the confirm record is still written");
  assert.equal(S.confirmQueuedAt("task-delete").get("x"), T1);
  assert.ok(S.confirmedDeletes("task-delete").has("z") && S.confirmedDeletes("task-delete").has("w"), "the group's other ids are recorded");
  S.voidDeleteIntents("task-delete", ["x"], T2);
  // Task B9 rewrote the rest into the outcome: T2's void proves a restore after T2, so T1's confirm is superseded and x is
  // kept (not lost, not given back) until a pass reads the cloud after that restore; it holds x (the restore brought it
  // back): x is released and T2's stash gives x back.
  assert.equal(S.stashGiveBack(S.readClearStash(T2)).uploads.length, 0, "undecided: kept in the stash");
  const st = S.sharedDeleteState("task", { cloudIds: new Set(["x"]), sinceSeq: S.confirmSeqNow(), restoreKnownAt: S.knownRestoreAt(), evidence: { present: [], complete: true } });
  assert.deepEqual(st.released, ["x"]);
  const back = S.stashGiveBack(S.readClearStash(T2));
  assert.deepEqual([back.uploads.map(e => e.id), Object.keys(back.archives)], [["x"], ["x"]], "T2's void gives x back");
});
test("#8: a stash at or before the confirmed group's time still loses the confirmed id (round 15 S2)", () => {
  S.queueDeleteIntents("task-delete", ["x"], 1000);
  S.writeClearStash(1000, { uploads: [], tasks: [{ id: "x" }], logs: [], archives: { x: { task: null, paths: ["archive/x.png"] } } });
  S.queueDeleteIntents("task-delete", ["q"], 2000);
  const paths = S.confirmDeleteIntents("task-delete", ["x"], 1000);
  assert.deepEqual(paths, ["archive/x.png"]);
  assert.deepEqual(S.readClearStash(1000).tasks, []);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
