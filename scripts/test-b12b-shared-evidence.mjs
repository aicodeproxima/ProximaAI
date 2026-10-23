// Task B12b (review round 25 #3, #6, #7, #10-#15; simulator findings F1, F3): a held delete is decided from evidence every
// tab shares and from complete reads only; late results and archives held for an undecided delete go back to a kept
// generation; a confirm is released only on a restore's evidence (a late row is deleted again); History copies a delete
// trimmed here are re-taken from the cloud once it settles.
// Runs the real storage.js, purge.js, wsDelete.js and batchLog.js; two storage.js instances (two tabs) share one
// localStorage and each have their own sessionStorage. App.jsx's steps are mirrored as they now read and their wiring is
// checked from the source. Written first: against the previous build (B12B_ROOT=<a copy of the tree before B12b>) every
// test below fails (the B12b functions do not exist there, or the defect shows).
// Run: node scripts/test-b12b-shared-evidence.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.B12B_ROOT ? pathToFileURL(process.env.B12B_ROOT.replace(/\/?$/, "/")).href : new URL("../", import.meta.url).href;
const mem = new Map();
const failKeys = new Set();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (failKeys.has(k)) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; } mem.set(k, String(v)); },
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sessionOf = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
globalThis.sessionStorage = sessionOf();
const A = await import(ROOT + "src/lib/storage.js?tab=a");   // tab A (the one that deletes)
globalThis.sessionStorage = sessionOf();
const B = await import(ROOT + "src/lib/storage.js?tab=b");   // tab B (same browser, its own page)
const P = await import(ROOT + "src/lib/purge.js");
const W = await import(ROOT + "src/lib/wsDelete.js");
const BL = await import(ROOT + "src/lib/batchLog.js");
const src = readFileSync(new URL("src/App.jsx", ROOT), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); failKeys.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
  finally { failKeys.clear(); }
};
const need = (mod, name) => { assert.equal(typeof mod[name], "function", `${name} exists`); return mod[name]; };
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const OLD = Date.now() - 10 * 60 * 1000;
const gen = (id, extra = {}) => ({ id, taskId: `pred-${id}`, status: "completed", startTime: OLD, outputs: [`${BASE}scope/${id}-out.png`],
  sourceImageUrl: `${BASE}uploads/scope/${id}-src.png`, ...extra });
const HELD = "proximaai-held-purges-v2";
const heldNow = () => JSON.parse(mem.get(HELD) || "{}");
const heldPaths = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.files || {})))].sort();
const heldWs = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.ws || {})))].sort();
const filesQueued = () => Object.keys(A.readFileDeletes()).sort();
const wsQueued = () => Object.keys(A.readWsDeletes()).sort();
// A delete of `ids` queued at T whose files and WaveSpeed ids are held for it (its reservation, App.jsx reserveDelete).
const reserve = (S, removed, T) => {
  const hold = { files: P.pathOwners(removed, [], P.storagePathsToDelete(removed, [], []), {}), ws: W.queueDeletes({}, removed, Date.now()) };
  assert.ok(S.reserveDelete({ intents: [{ kind: "task-delete", ids: removed.map(t => t.id), at: T }], holdAt: T, hold }));
};
// The evidence a reconcile pass builds (App.jsx reconcileWithCloud, as it now reads): the restore it knew before its
// reads, the cloud's ids (task rows, History items, the restore's own removals), this tab's state and what every tab
// shares (IndexedDB: storedEvidenceIds), complete only when every source was read.
const evidence = (rk, { tasks = [], items = [], restoreRemoved = [], local = [], shared = { task: new Set(), history: new Set() }, logs = [], localLogs = [] } = {}) => ({
  restoreKnownAt: rk,
  task: { present: [...tasks, ...items, ...(restoreRemoved || [])], local: new Set([...local, ...(shared?.task || [])]), complete: !!restoreRemoved && !!shared },
  history: { present: logs, local: new Set([...localLogs, ...(shared?.history || [])]), complete: !!shared },
});

// ─── #10: the evidence is the browser's, not one tab's ───
// Owner ruling 2026-10-23 rewrote this test: B's give-back no longer cancels the holds at once (keepGivenBack removed);
// they wait, and A's pass keeps x because B gave it back into this browser's IndexedDB (the shared evidence).
await test("#10: a generation tab B got back from a voided clear keeps its files and result when tab A decides (B's give-back is in the shared IndexedDB)", async () => {
  const T = 1_790_000_000_000, x = gen("x");
  reserve(A, [x], T);
  assert.deepEqual([heldPaths(), heldWs()], [[`scope/x-out.png`, `uploads/scope/x-src.png`], ["pred-x"]]);
  // The restore in tab B voids the clear; B gives x back (state and IndexedDB); its holds wait.
  B.voidDeleteIntents("task-delete", ["x"], T);
  B.releaseHeldPurges(Date.now());
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], ["pred-x"]], "the give-back decides nothing: still held");
  // Tab A's next usable pass: x absent from the cloud (local-only) and from A's own state, present in IndexedDB.
  const rk = A.knownRestoreAt();
  assert.ok(rk > T);
  const shared = await A.storedEvidenceIds({ tasks: async () => [x], history: async () => [] });
  A.releaseHeldPurges(Date.now(), evidence(rk, { shared }));
  assert.deepEqual([filesQueued(), wsQueued(), heldPaths(), heldWs()], [[], [], [], []], "nothing of x is deleted");
});
await test("#10: without that cancel (B gave x back into IndexedDB only), A's pass reads IndexedDB and keeps x; unreadable: it decides nothing", async () => {
  const T = 1_790_000_000_000, x = gen("x");
  reserve(A, [x], T);
  B.voidDeleteIntents("task-delete", ["x"], T);
  const rk = A.knownRestoreAt();
  const unreadable = await need(A, "storedEvidenceIds")({ tasks: async () => { throw new Error("idb"); }, history: async () => [] });
  assert.equal(unreadable, null);
  A.releaseHeldPurges(Date.now(), evidence(rk, { shared: unreadable }));
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], ["pred-x"]], "IndexedDB unread: waits");
  const shared = await A.storedEvidenceIds({ tasks: async () => [x], history: async () => [] });
  assert.ok(shared.task.has("x"));
  A.releaseHeldPurges(Date.now(), evidence(rk, { shared }));
  assert.deepEqual([filesQueued(), wsQueued(), heldPaths(), heldWs()], [[], [], [], []], "kept: B holds it");
  // The History items of an entry stored by any tab count too.
  reserve(A, [gen("y")], T + 10);
  B.voidDeleteIntents("task-delete", ["y"], T + 10);
  const s2 = await A.storedEvidenceIds({ tasks: async () => [], history: async () => [{ id: "L", tasks: [{ id: "y" }] }] });
  A.releaseHeldPurges(Date.now(), evidence(A.knownRestoreAt(), { shared: s2 }));
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], []]);
});
await test("#10: a generation nobody keeps is still decided gone (files and result queued)", async () => {
  const T = 1_790_000_000_000, x = gen("x");
  reserve(A, [x], T);
  B.voidDeleteIntents("task-delete", ["x"], T);
  const shared = await need(A, "storedEvidenceIds")({ tasks: async () => [], history: async () => [] });
  A.releaseHeldPurges(Date.now(), evidence(A.knownRestoreAt(), { shared }));
  assert.deepEqual([filesQueued(), wsQueued()], [[`scope/x-out.png`, `uploads/scope/x-src.png`], ["pred-x"]]);
});
// Owner ruling 2026-10-23 rewrote this wiring test: no give-back cancels holds (keepGivenBack removed); the pass still
// reads IndexedDB when anything is held, leaving out copies of ids the cloud tombstones or the pass removes.
await test("#10 wiring: give-backs leave holds to the pass; the pass reads IndexedDB when anything is held", () => {
  assert.ok(!/const keepGivenBack|keepGivenBack\s*\(/.test(src), "no give-back cancels holds");
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  assert.match(rec, /const shared = hasHeldPurges\(\) \? await storedEvidenceIds\(\) : null;/);
  assert.match(rec, /for \(const id of shared\.task\) if \(!tombT\.has\(id\) && !rmTasks\.has\(id\)\) keptTaskIds\.add\(id\);/);
});

// ─── #3: complete evidence only; the restore's own removals count as present ───
await test("#3: a generation the restore brought back History-only (by_restore) is alive even when its entry is beyond the History read", () => {
  const T = 1_790_000_000_000, g = gen("g");
  reserve(A, [g], T);
  A.voidDeleteIntents("task-delete", ["g"], T);
  const rk = A.knownRestoreAt();
  // Tombstones unread (restoreRemoved null): incomplete, nothing decided.
  A.releaseHeldPurges(Date.now(), evidence(rk, { restoreRemoved: null }));
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], ["pred-g"]]);
  A.releaseHeldPurges(Date.now(), evidence(rk, { restoreRemoved: ["g"] }));
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], []], "kept: the restore's removal is its decision");
});
await test("#3: a capped History read asks the server about every owner it would call gone (heldGoneCandidates); unanswered, no decision", () => {
  const T = 1_790_000_000_000;
  reserve(A, [gen("g"), gen("h")], T);
  A.voidDeleteIntents("task-delete", ["g", "h"], T);
  const ev = evidence(A.knownRestoreAt(), { items: ["h"] });
  assert.deepEqual(need(A, "heldGoneCandidates")(ev), ["g"], "h is in the read; g would be gone");
  // generations_live says g has a live History item older than the read: present.
  ev.task.present.push("g");
  A.releaseHeldPurges(Date.now(), ev);
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], []]);
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  assert.match(rec, /if \(evidence\.task\.complete && \(remote\.history \|\| \[\]\)\.length >= HISTORY_PULL_LIMIT\) \{\s*const candidates = heldGoneCandidates\(evidence\);\s*const live = candidates\.length \? await generationsLiveRemote\(candidates\) : new Set\(\);\s*if \(live\) evidence\.task\.present\.push\(\.\.\.live\); else evidence\.task\.complete = false;/);
  assert.match(rec, /complete: ids\.tasks instanceof Set && !!cloudItemIds && !!restoreRemoved && !!shared/);
});

// ─── late results and archives go back to a kept generation ───
// App.jsx applyRelinks as it now reads, over a tab's tasks.
function applyRelinks(S, tasks, deleting = new Set()) {
  const ready = S.readyRelinks();
  const done = new Map(), unrelease = [];
  const out = tasks.map(t => {
    const r = ready.get(t.id);
    if (!r || deleting.has(t.id)) return t;
    let x = t;
    const parts = {};
    if (r.p) { if (!t.taskId) { if (t.status === "pending") unrelease.push(r.p); else x = { ...x, taskId: r.p }; } parts.p = true; }
    if (r.a) { if (!t.isArchived) x = { ...x, ...r.a, isArchived: true, archiving: false }; parts.a = true; }
    done.set(t.id, parts);
    return x;
  });
  if (unrelease.length) S.unreleasePredictions(unrelease);
  S.dropRelinks(done);
  return out;
}
await test("r1 (#6/#11/#14): a late result held while a bulk delete has not reserved yet goes back to the task when that delete aborts", () => {
  const c = gen("c", { taskId: undefined, status: "failed", error: "Cancelled" });
  assert.equal(A.deleteHoldAt("c"), undefined, "nothing records c's delete during the safety backup");
  // The fallback path (the task not in this tab's state): held with a relink at "now".
  const e = W.queueDeletes({}, [{ id: "c", taskId: "pred-c", status: "processing" }], Date.now());
  assert.ok(need(A, "holdLateResult")(Date.now(), "c", "pred-c", e["pred-c"]));
  assert.deepEqual(heldWs(), ["pred-c"]);
  // The backup fails (or storage is full): the abort releases it and links it back.
  assert.deepEqual(need(A, "releaseAbortedLate")(["c"]), ["pred-c"]);
  assert.deepEqual([heldWs(), wsQueued()], [[], []], "out of the hold, not deleted");
  const [after] = applyRelinks(A, [c]);
  assert.equal(after.taskId, "pred-c", "the cancelled task keeps the result it paid for");
  assert.equal(A.readyRelinks().size, 0);
  // Wiring: keepLateSubmitId attaches before the reservation; both aborts release and relink.
  const late = between("function keepLateSubmitId(", "const submittingIds = useRef(");
  assert.match(late, /if \(deleting && deletingIds\.current\.has\(id\) && deleteHoldAt\(id\) === undefined\) \{\s*const t = tasksRef\.current\.find\(x => x\.id === id\);/);
  // Task B13a (review round 26 #7): the attach goes through linkLate (tasksRef, state, IndexedDB and the queued upload).
  assert.match(late, /tasksRef\.current = tasksRef\.current\.map\(x => \(x\.id === id && !x\.taskId \? next : x\)\);/);
  assert.match(late, /if \(!t\.taskId\) linkLate\(t\);/);
  const bulk = between("const deleteSelectedTasks = async () =>", "const renderSelectBar = ");
  assert.match(bulk, /const keepLate = \(\) => \{ releaseAbortedLate\(ids\); applyRelinks\(\); \};/);
  assert.equal(bulk.match(/keepLate\(\);/g)?.length, 2, "the failed backup and the storage-full abort");
});
await test("r1: a late result held for a delete that is still recorded (pending) is not released by another call's abort", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["c"], T);
  const e = W.queueDeletes({}, [{ id: "c", taskId: "pred-c", status: "processing" }], Date.now());
  assert.ok(A.holdLateResult(T, "c", "pred-c", e["pred-c"]));
  assert.deepEqual(A.releaseAbortedLate(["c"]), []);
  assert.deepEqual(heldWs(), ["pred-c"]);
});
await test("r2 (#7/#12/#15): a deleted claimant's prediction held for a delete a restore voids goes back to the claimant once a pass sees it kept", () => {
  const Q = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x"], Q);
  assert.equal(A.deleteHoldAt("x"), Q);
  const e = W.queueDeletes({}, [{ id: "x", taskId: "pred-p", status: "processing" }], Date.now());
  assert.ok(A.holdLateResult(Q, "x", "pred-p", e["pred-p"]));
  A.releasePredictions(["pred-p"]);
  A.voidDeleteIntents("task-delete", ["x"], Q);
  // The pass: x is in the cloud again (the restore kept it). The hold is cancelled AND the relink is ready.
  A.releaseHeldPurges(Date.now(), evidence(A.knownRestoreAt(), { tasks: ["x"] }));
  assert.deepEqual([heldWs(), wsQueued()], [[], []]);
  assert.equal(A.readyRelinks().get("x")?.p, "pred-p");
  // A waiting lost submit (given back pending, no id): un-released, so its lookup adopts it.
  const [pending] = applyRelinks(A, [{ id: "x", status: "pending", startTime: OLD }]);
  assert.equal(pending.taskId, undefined);
  assert.equal(A.releasedPredictions().has("pred-p"), false, "no longer owned: the lookup pairs it with x");
  // Wiring: the lookup holds claimant deletes with a relink; the pass and the flush apply relinks after releasing.
  assert.match(between("const recoverOrphans = useCallback(", "const decided = new Map("), /\{ relink: true \}\) : \[\]\);/);
  assert.match(between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect("), /releaseHeldPurges\(Date\.now\(\), evidence\);\s*applyRelinks\(\);/);
  assert.match(between("const flushWsDeletes = useCallback(", "const deleteOnWaveSpeed = useCallback("), /releaseHeldPurges\(\);[^\n]*\n\s*applyRelinks\(\);/);
});
await test("r2: a cancelled claimant (not waiting) gets the id linked; a final delete sends it and drops the relink", () => {
  const Q = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x", "z"], Q);
  const e = W.queueDeletes({}, [{ id: "x", taskId: "pred-p", status: "processing" }, { id: "z", taskId: "pred-z", status: "processing" }], Date.now());
  assert.ok(A.holdLateResult(Q, "x", "pred-p", e["pred-p"]) && A.holdLateResult(Q, "z", "pred-z", e["pred-z"]));
  A.confirmDeleteIntents("task-delete", ["z"], Q);
  assert.deepEqual(wsQueued(), ["pred-z"], "z's delete is final: its result goes");
  A.voidDeleteIntents("task-delete", ["x"], Q);
  A.releaseHeldPurges(Date.now(), evidence(A.knownRestoreAt(), { tasks: ["x"] }));
  const [x] = applyRelinks(A, [{ id: "x", status: "failed", error: "Cancelled", startTime: OLD }]);
  assert.equal(x.taskId, "pred-p");
  assert.equal(A.readyRelinks().size, 0);
  assert.equal(JSON.parse(mem.get("proximaai-relinks") || "{}").z, undefined, "z's relink went with its result");
});
await test("r2: a relink that cannot be written keeps the result held (decided again), never silently unlinked", () => {
  const Q = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x"], Q);
  const e = W.queueDeletes({}, [{ id: "x", taskId: "pred-p", status: "processing" }], Date.now());
  failKeys.add("proximaai-relinks");
  assert.equal(A.holdLateResult(Q, "x", "pred-p", e["pred-p"]), false, "not stored: the caller keeps the claim");
  failKeys.clear();
  assert.ok(A.holdLateResult(Q, "x", "pred-p", e["pred-p"]));
  A.voidDeleteIntents("task-delete", ["x"], Q);
  failKeys.add("proximaai-relinks");
  A.releaseHeldPurges(Date.now(), evidence(A.knownRestoreAt(), { tasks: ["x"] }));
  assert.deepEqual(heldWs(), ["pred-p"], "kept held");
  failKeys.clear();
  A.releaseHeldPurges(Date.now(), evidence(A.knownRestoreAt(), { tasks: ["x"] }));
  assert.deepEqual([heldWs(), A.readyRelinks().get("x")?.p], [[], "pred-p"]);
});
await test("r3 (#13): an archive that finishes while a delete holds its task is held for that delete (not queued) and re-applied if it is kept", () => {
  const Q = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x", "y"], Q);
  const patch = (id) => ({ outputs: [`${BASE}scope/${id}-0.png`], archivedOutputs: [`${BASE}scope/${id}-0.png`], archivedPaths: [`scope/${id}-0.png`] });
  assert.ok(need(A, "holdArchiveFiles")(A.deleteHoldAt("x"), "x", ["scope/x-0.png"], patch("x")));
  assert.ok(A.holdArchiveFiles(A.deleteHoldAt("y"), "y", ["scope/y-0.png"], patch("y")));
  assert.deepEqual([filesQueued(), heldPaths()], [[], ["scope/x-0.png", "scope/y-0.png"]], "never straight to the file-delete queue");
  A.confirmDeleteIntents("task-delete", ["y"], Q);
  assert.deepEqual(filesQueued(), ["scope/y-0.png"], "y's delete is final: its archive goes");
  A.voidDeleteIntents("task-delete", ["x"], Q);
  A.releaseHeldPurges(Date.now(), evidence(A.knownRestoreAt(), { tasks: ["x"] }));
  assert.deepEqual([filesQueued(), heldPaths()], [["scope/y-0.png"], []]);
  const [x] = applyRelinks(A, [gen("x")]);
  assert.deepEqual([x.isArchived, x.archivedPaths], [true, ["scope/x-0.png"]], "the kept generation gets its archive");
  const arch = between("const onCloudArchiveTask = useCallback(", "const onCopyUrlTask = useCallback(");
  assert.match(arch, /else if \(!holdArchiveFiles\(holdAt, task\.id, paths, anyOk \? patch : null\)\)/);
});

// ─── F1: a confirm is released only on a restore's evidence ───
await test("F1: a FINAL confirm whose row reappears without a restore stays (blocks every tab) and is listed to delete again at its queue time", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x"], T);
  A.confirmDeleteIntents("task-delete", ["x"], T);
  const sinceSeq = A.confirmSeqNow();
  const st = A.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(["x"]), sinceSeq, restoreKnownAt: 0, evidence: { present: [], complete: true } });
  assert.deepEqual(st.released, [], "a late upload is not a restore");
  assert.deepEqual(st.reappeared, [{ id: "x", at: T }]);
  assert.ok(st.deleting.has("x") && B.uploadBlockedIds("task").has("x"), "blocked in every tab");
  // Known restore after the confirm was checked: the re-delete goes at that restore (not voided by it).
  const R = T + 5000;
  A.noteRestoreKnown(R);
  A.resolveSuperseded("task-delete", new Set(), { restoreKnownAt: R, complete: true });   // a pass checked x against R: still final
  const st2 = A.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(["x"]), sinceSeq: A.confirmSeqNow(), restoreKnownAt: R, evidence: { present: [], complete: true } });
  assert.deepEqual([st2.released, st2.reappeared], [[], [{ id: "x", at: R }]]);
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  assert.match(rec, /if \(restoreKnownAt >= knownRestoreAt\(\)\) \{\s*for \(const \[kind, st\] of \[\["task-delete", taskDel\], \["history-delete", logDel\]\]\) \{/);
  assert.match(rec, /for \(const \[at, list\] of byAt\) queueDeleteIntents\(kind, list, at\);/);
});
await test("F1: an ASSUMED confirm (Clear Outputs' unnamed History-only generation: the server left its row alone) is released when its row shows up, never deleted again", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["t8", "t2"], T);
  need(A, "markAssumedConfirms")("task-delete", ["t8"], T);
  // Task B13a (review round 26 #3/#5): rewritten from one confirm of both ids. App.jsx now confirms an assumed id as such
  // (confirmIntents(..., { assumed: true }): no final mark) and a named one normally; the outcome is the same.
  A.confirmDeleteIntents("task-delete", ["t8"], T, { assumed: true });
  A.confirmDeleteIntents("task-delete", ["t2"], T);
  const st = A.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(["t8", "t2"]), sinceSeq: A.confirmSeqNow(), restoreKnownAt: 0, evidence: { present: [], complete: true } });
  assert.deepEqual([st.released, st.reappeared], [["t8"], [{ id: "t2", at: T }]], "t8 is the server's answer; t2 (named) a late upload");
  assert.equal(A.confirmedDeletes("task-delete").has("t8"), false);
  // A later delete of t8 (its own confirm at another time) is no longer assumed.
  A.queueDeleteIntents("task-delete", ["t8"], T + 100);
  A.confirmDeleteIntents("task-delete", ["t8"], T + 100);
  const st2 = A.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(["t8"]), sinceSeq: A.confirmSeqNow(), restoreKnownAt: 0, evidence: { present: [], complete: true } });
  assert.deepEqual([st2.released, st2.reappeared.map(r => r.id)], [[], ["t8"]]);
  // Task B13a (review round 26 #2): only the unnamed ids a read found a row for are assumed (wiring checked in
  // scripts/test-b13a-round26.mjs).
  assert.match(src, /markAssumedConfirms\("task-delete", assumedIds, queuedAt\); confirmIntents\("task-delete", assumedIds, queuedAt, \{ assumed: true \}\);/);
});
await test("F1: a confirm a newer restore superseded is still released when the cloud holds it after that restore", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x"], T);
  A.confirmDeleteIntents("task-delete", ["x"], T);
  const R = T + 5000;
  A.noteRestoreKnown(R);
  const st = A.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(["x"]), sinceSeq: A.confirmSeqNow(), restoreKnownAt: R, evidence: { present: [], complete: true } });
  assert.deepEqual([st.released, st.reappeared], [["x"], []]);
  assert.equal(A.confirmedDeletes("task-delete").has("x"), false);
});

// ─── F3: a trimmed History copy is re-taken from the cloud once its delete settles ───
// App.jsx reconcileWithCloud's re-sync step as it now reads: the settled records this tab has not applied; the cloud's
// copies less items of FINAL deletes; an entry holding an undecided item (pending, in a call, superseded), with an upload
// queued here, or being deleted waits (its record is not marked applied).
function resyncPass(S, local, cloudLogs, cloudTaskIds, applied, { pendingLogs = new Set() } = {}) {
  const taskDel = S.sharedDeleteState("task", { deleting: new Set(), cloudIds: cloudTaskIds, sinceSeq: S.confirmSeqNow() });
  const logDel = S.sharedDeleteState("history", { deleting: new Set(), cloudIds: new Set(cloudLogs.map(l => l.id)), sinceSeq: S.confirmSeqNow() });
  const due = S.historyResyncDue().filter(r => !applied.has(r.key));
  if (!due.length) return local;
  const want = new Set(due.flatMap(r => r.ids));
  const undecided = (id) => taskDel.deleting.has(id) && !taskDel.final.has(id);
  const waits = new Set([...want].filter(id => pendingLogs.has(id) || logDel.deleting.has(id)));
  const cloudCopies = [];
  for (const c of cloudLogs) {
    if (!c?.id || !want.has(c.id) || waits.has(c.id)) continue;
    const items = Array.isArray(c.tasks) ? c.tasks : [];
    if (items.some(x => x?.id && undecided(x.id))) { waits.add(c.id); continue; }
    cloudCopies.push({ ...c, tasks: items.filter(x => !(x?.id && taskDel.final.has(x.id))) });
  }
  const take = new Map(BL.restoredVersions(local.filter(l => want.has(l.id)), cloudCopies, pendingLogs).map(l => [l.id, l]));
  for (const r of due) if (!r.ids.some(id => waits.has(id))) applied.add(r.key);
  return local.map(l => take.get(l.id) || l);
}
const show = (logs) => logs.map(l => `${l.id}(${l.tasks.map(x => x.id)})`);
// The simulator's minimal trace (seed 354, --net window, 250 steps, shrunk to 15 ops): L1(t2 t3) and L4(t5 t6) are in the
// cloud and in tab B; B bulk-deletes [t6, t2] (its copies trimmed to L1(t3), L4(t5)); a restore lands first, B handles it,
// and the delete's call comes back voided. Before: the trimmed copies stayed in B for good (I4).
await test("F3: a bulk delete voided after the restore was handled: the trimmed copies take the cloud's whole entries", () => {
  const T = 1_790_000_000_000, h = T + 1;
  const L1 = { id: "L1", timestamp: OLD, tasks: [{ id: "t2", status: "completed" }, { id: "t3", status: "completed" }] };
  const L4 = { id: "L4", timestamp: OLD, tasks: [{ id: "t5", status: "completed" }, { id: "t6", status: "completed" }] };
  const plan = P.planPurge([L1, L4], [{ id: "t6" }, { id: "t2" }], [{ id: "t3" }, { id: "t5" }]);
  assert.deepEqual(show(plan.rewrite).sort(), ["L1(t3)", "L4(t5)"]);
  B.queueDeleteIntents("task-delete", ["t6", "t2"], T);
  assert.ok(need(B, "markHistoryResync")([T, h], plan.rewrite.map(l => l.id)));
  let local = [L1, L4].map(l => plan.rewrite.find(r => r.id === l.id) || l);
  const applied = new Set();
  local = resyncPass(B, local, [L1, L4], new Set(["t2", "t3", "t5", "t6"]), applied);
  assert.deepEqual(show(local), ["L1(t3)", "L4(t5)"], "not while the delete is pending");
  B.markRestoreSeen(T + 3);   // the restore was handled first
  B.voidDeleteIntents("task-delete", ["t6", "t2"], T);
  local = resyncPass(B, local, [L1, L4], new Set(["t2", "t3", "t5", "t6"]), applied);
  assert.deepEqual(show(local), ["L1(t2,t3)", "L4(t5,t6)"], "equal to the cloud again");
  assert.equal(applied.size, 1);
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  assert.match(rec, /const due = historyResyncDue\(\)\.filter\(r => !resyncAppliedRef\.current\.has\(r\.key\)\);/);
  assert.match(rec, /const undecided = \(id\) => taskDel\.deleting\.has\(id\) && !taskDel\.final\.has\(id\);/);
  assert.match(rec, /if \(items\.some\(i => i\?\.id && undecided\(i\.id\)\)\) \{ waits\.add\(c\.id\); continue; \}/);
  assert.match(rec, /cloudCopies\.push\(\{ \.\.\.c, tasks: items\.filter\(i => !\(i\?\.id && taskDel\.final\.has\(i\.id\)\)\) \}\);/);
  assert.match(rec, /for \(const r of due\) if \(!r\.ids\.some\(id => waits\.has\(id\)\)\) resyncAppliedRef\.current\.add\(r\.key\);/);
  assert.match(between("const stagePurge = useCallback(", "const purgeEverywhere = useCallback("),
    /if \(plan\.rewrite\.length\) markHistoryResync\(\[staged\.holdAt, historyQueuedAt\], plan\.rewrite\.map\(l => l\.id\)\);/);
});
await test("F3: a confirmed delete settles its record (the cloud's stripped copy changes nothing); an entry with an undecided item waits for it", () => {
  const T = 1_790_000_000_000;
  const L1 = { id: "L1", timestamp: OLD, tasks: [{ id: "t2" }, { id: "t3" }, { id: "t9" }] };
  A.queueDeleteIntents("task-delete", ["t2"], T);
  A.queueDeleteIntents("task-delete", ["t9"], T + 50);   // another delete (another tab's clear), still pending
  A.markHistoryResync([T], ["L1"]);
  A.confirmDeleteIntents("task-delete", ["t2"], T);
  let local = [{ ...L1, tasks: [{ id: "t3" }] }];   // trimmed here by both deletes
  const cloud = [{ ...L1, tasks: [{ id: "t3" }, { id: "t9" }] }];   // t2 stripped by the server
  const applied = new Set();
  local = resyncPass(A, local, cloud, new Set(["t3", "t9"]), applied);
  assert.deepEqual([show(local), applied.size], [["L1(t3)"], 0], "waits while t9's delete is undecided (never taken minus t9)");
  // t9's delete is voided by a restore (simulator seed 11542: taken minus t9 then, the entry stayed short for good).
  A.voidDeleteIntents("task-delete", ["t9"], T + 50);
  local = resyncPass(A, local, cloud, new Set(["t3", "t9"]), applied);
  assert.deepEqual([show(local), applied.size], [["L1(t3,t9)"], 1]);
  // Confirmed instead: the cloud's copy (t9 stripped by the server) equals the trimmed one: nothing changes.
  mem.clear();
  A.queueDeleteIntents("task-delete", ["t2", "t9"], T);
  A.markHistoryResync([T], ["L1"]);
  A.confirmDeleteIntents("task-delete", ["t2", "t9"], T);
  const applied2 = new Set();
  const after = resyncPass(A, [{ ...L1, tasks: [{ id: "t3" }] }], [{ ...L1, tasks: [{ id: "t3" }] }], new Set(["t3"]), applied2);
  assert.deepEqual([show(after), applied2.size], [["L1(t3)"], 1]);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
