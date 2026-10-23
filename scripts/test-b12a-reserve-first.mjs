// Task B12a (review round 25 #1, #2, #4, #5, #9, #16, #17, #18): a delete RESERVES first. Every delete that can stop for
// "storage full" (bulk delete, History delete, Clear Logs, Clear Outputs, Reset) computes its plan, then writes its
// durable reservation (its delete intents AND the hold of its files and WaveSpeed ids, storage.js reserveDelete) as its
// FIRST state change. A refused write stops it with NOTHING changed (no undo code), and the honest storage-full message.
// Also: deleteOnWaveSpeed checks its writes and never falls back to the direct queue (#18); the flush's hold of a pending
// delete's directly queued WaveSpeed entry has no 48 h cap (#2); an item-less History entry gets no owner that waits
// forever (#4); holds live under a NEW key a previous build never reads, migrated once (#5).
// Runs the real storage.js, purge.js, wsDelete.js, fileDelete.js and batchLog.js; App.jsx's order is checked from the
// source, and its pre-call steps are mirrored over a fake app (state, IndexedDB mirror, debounced queue, favorites,
// Generate form). Written first: against the previous build (B12A_ROOT=<a copy of HEAD>) every test below fails.
// Run: node scripts/test-b12a-reserve-first.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.B12A_ROOT ? pathToFileURL(process.env.B12A_ROOT.replace(/\/?$/, "/")).href : new URL("../", import.meta.url).href;
// A localStorage that can enforce a quota (chars of keys + values) or refuse given keys, as a full origin does.
const mem = new Map();
let cap = Infinity;
const failKeys = new Set();
const used = () => { let n = 0; for (const [k, v] of mem) n += k.length + v.length; return n; };
const quota = () => { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; return e; };
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    const s = String(v), before = mem.has(k) ? k.length + mem.get(k).length : 0;
    if (failKeys.has(k)) throw quota();
    if (used() - before + k.length + s.length > cap) throw quota();
    mem.set(k, s);
  },
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sessionOf = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
globalThis.sessionStorage = sessionOf();
const S = await import(ROOT + "src/lib/storage.js");
const P = await import(ROOT + "src/lib/purge.js");
const W = await import(ROOT + "src/lib/wsDelete.js");
const B = await import(ROOT + "src/lib/batchLog.js");
const C = await import(ROOT + "src/lib/serverClock.js");
const src = readFileSync(new URL("src/App.jsx", ROOT), "utf8").replace(/\r\n/g, "\n");
const st = readFileSync(new URL("src/lib/storage.js", ROOT), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};

let n = 0, failed = 0;
const test = async (name, fn) => {
  const realNow = Date.now;
  try { mem.clear(); cap = Infinity; failKeys.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
  finally { Date.now = realNow; cap = Infinity; failKeys.clear(); }
};
const need = (mod, name) => { assert.equal(typeof mod[name], "function", `${name} exists`); return mod[name]; };
const HELD = "proximaai-held-purges-v3", LEGACY = "proximaai-held-purges";   // task B14 (round 27 #4): v3
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const OLD = Date.now() - 10 * 60 * 1000;
const gen = (id, extra = {}) => ({ id, taskId: `pred-${id}`, status: "completed", startTime: OLD, outputs: [`${BASE}scope/${id}-out.png`],
  sourceImageUrl: `${BASE}uploads/scope/${id}-src.png`, ...extra });
const pathsOf = (id) => [`scope/${id}-out.png`, `uploads/scope/${id}-src.png`];
const filesQueued = () => Object.keys(S.readFileDeletes()).sort();
const wsQueued = () => Object.keys(S.readWsDeletes()).sort();
const heldNow = () => JSON.parse(mem.get(HELD) || "{}");
const heldPaths = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.files || {})))].sort();
const heldWs = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.ws || {})))].sort();

// ─── The fake app: every store a delete may touch before its server call ───
// State (tasks, logs), the IndexedDB mirror, the debounced task queue, saved-id sets, favorites (refs + their IndexedDB
// setting), the Generate form's selected models and inputs (and its published form key), plus all of localStorage
// (failed-sync queue, held purges, clear stashes, claimants, released predictions, ws / file queues).
function makeApp() {
  const x = gen("x"), y = gen("y"), z = gen("z");
  const L = { id: "L", timestamp: OLD, tasks: [{ id: "x", status: "completed", outputs: x.outputs }, { id: "y", status: "completed", outputs: y.outputs }] };
  const M = { id: "M", timestamp: OLD, tasks: [{ status: "completed", outputs: [`${BASE}scope/legacy.png`] }] };   // an id-less item
  const app = {
    tasks: [x, y, z], logs: [L, M],
    idb: { tasks: Object.fromEntries([x, y, z].map(t => [t.id, t])), history: { L, M }, settings: { "model-favorites:me": { byType: { image: ["m1"] }, updatedAt: 5 } } },
    syncQueue: [x, z], savedTaskIds: ["x", "y", "z"], savedLogIds: ["L", "M"],
    favorites: { byType: { image: ["m1"] }, updatedAt: 5 }, selectedModels: ["m1", "m2"],
    form: { sourceImageUrl: `${BASE}uploads/scope/x-src.png` }, deletingIds: [], deletingLogIds: [], saveStatus: "idle", toast: "",
  };
  // localStorage content: a queued upload of x (an archive whose send failed), a queued History upload of L, the
  // published form inputs, an earlier pending delete of y with its clear stash (its id moves to a new delete), claimants.
  S.addFailedSync({ kind: "task", id: "x", data: { ...x, isArchived: true } });
  S.addFailedSync({ kind: "history", id: "L", data: L });
  S.addFailedSync({ kind: "model-favorites", id: "me", data: app.favorites });
  mem.set("proximaai-form-inputs:tab-1", JSON.stringify({ at: Date.now(), paths: ["uploads/scope/x-src.png"] }));
  S.writeClearStash(1000, S.buildClearStash({ tasks: [y], cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.queueDeleteIntents("task-delete", ["y"], 1000);
  S.queueDeleteIntents("history-delete", ["M"], 1000);
  S.recordClaimants([{ id: "q", modelId: "m", status: "pending", startTime: OLD, error: "Cancelled" }]);
  return app;
}
const snapshot = (app) => JSON.stringify({ ls: [...mem.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  app: { ...app, deletingIds: undefined, deletingLogIds: undefined, saveStatus: undefined, toast: undefined } });

// App.jsx's pre-call steps as they now read: plan (nothing changes), reserveDelete, and only then the removals.
const STORAGE_FULL = "storage full";
const abort = (app, release) => { release(); app.saveStatus = "error"; app.toast = STORAGE_FULL; return { aborted: true }; };
function removeTasksHere(app, ids) {
  const set = new Set(ids);
  app.syncQueue = app.syncQueue.filter(t => !set.has(t.id));
  app.savedTaskIds = app.savedTaskIds.filter(id => !set.has(id));
  for (const id of ids) S.removeFailedSync("task", id);
  app.tasks = app.tasks.filter(t => !set.has(t.id));
  for (const id of ids) delete app.idb.tasks[id];
}
function applyHistory(app, staged) {
  if (!staged.doHistory) return;
  const gone = new Set(staged.plan.remove), byId = new Map(staged.plan.rewrite.map(l => [l.id, l]));
  app.logs = app.logs.filter(l => !gone.has(l.id)).map(l => byId.get(l.id) || l);
  for (const id of gone) { delete app.idb.history[id]; S.removeFailedSync("history", id); }
  for (const l of staged.plan.rewrite) app.idb.history[l.id] = l;
}
function bulkDelete(app, ids) {
  for (const id of ids) app.deletingIds.push(id);
  const idSet = new Set(ids);
  const latest = app.tasks.filter(t => idSet.has(t.id));
  const queuedAt = C.serverNow();
  const staged = need(P, "planDeleteStage")(app.logs, latest, app.tasks.filter(t => !idSet.has(t.id)), { serverHistory: true, holdAt: queuedAt });
  if (!need(S, "reserveDelete")({ intents: [{ kind: "task-delete", ids, at: queuedAt }, ...staged.intents], holdAt: queuedAt, hold: staged.hold }))
    return abort(app, () => { app.deletingIds = app.deletingIds.filter(id => !idSet.has(id)); });
  removeTasksHere(app, ids);
  applyHistory(app, staged);
  S.forgetConfirmed("task-delete", ids);
  S.releasePredictions(latest.map(t => t.taskId)); S.recordClaimants(latest, { deleted: true });
  return { aborted: false, queuedAt, staged };
}
function historyDelete(app, ids) {
  const queuedAt = C.serverNow();
  if (!need(S, "reserveDelete")({ intents: [{ kind: "history-delete", ids, at: queuedAt }] })) return abort(app, () => {});
  for (const id of ids) { app.savedLogIds = app.savedLogIds.filter(x => x !== id); S.removeFailedSync("history", id); }
  app.logs = app.logs.filter(l => !ids.includes(l.id));
  for (const id of ids) delete app.idb.history[id];
  return { aborted: false };
}
function clearLogs(app) {
  const ids = app.logs.map(l => l.id), snap = C.serverNow();
  if (!need(S, "reserveDelete")({ intents: [{ kind: "history-delete", ids, at: snap }] })) return abort(app, () => {});
  S.writeClearStash(snap, S.clearLogsStash({ loaded: app.logs, uploads: S.peekQueuedUploads(["history"]), planned: new Set(ids) }).full);
  S.takeQueuedUploads("history", ids);
  app.logs = []; app.idb.history = {};
  return { aborted: false };
}
function clearOutputs(app) {
  const clearAt = C.serverNow() - 1000;
  const removed = app.tasks.slice(), ids = removed.map(t => t.id);
  const staged = need(P, "planDeleteStage")(app.logs, removed, [], { all: true, serverHistory: true, at: clearAt, holdAt: clearAt });
  if (!need(S, "reserveDelete")({ intents: [{ kind: "task-delete", ids, at: clearAt }, ...staged.intents], holdAt: clearAt, hold: staged.hold }))
    return abort(app, () => {});
  app.syncQueue = [];
  S.writeClearStash(clearAt, S.buildClearStash({ uploads: S.peekQueuedUploads(["task", "history"]), tasks: removed, cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.takeQueuedUploads("task", ids);
  S.releasePredictions(removed.map(t => t.taskId)); S.recordClaimants(removed, { deleted: true });
  applyHistory(app, staged);
  removeTasksHere(app, ids);
  return { aborted: false };
}
function reset(app) {
  const resetAt = C.serverNow() - 1000;
  const removedTasks = app.tasks.slice(), removedLogs = app.logs.slice();
  const taskIds = removedTasks.map(t => t.id), logIds = removedLogs.map(l => l.id);
  const staged = need(P, "planDeleteStage")(app.logs, removedTasks, [], { history: false, alsoLogs: removedLogs, holdAt: resetAt });
  if (!need(S, "reserveDelete")({ intents: [{ kind: "task-delete", ids: taskIds, at: resetAt }, { kind: "history-delete", ids: logIds, at: resetAt }],
    holdAt: resetAt, hold: staged.hold })) return abort(app, () => {});
  app.favorites = { byType: {}, updatedAt: Date.now() }; app.selectedModels = [];
  S.removeFailedSync("model-favorites", "me");
  app.idb.settings["model-favorites:me"] = app.favorites;
  S.writeClearStash(resetAt, S.buildClearStash({ uploads: S.peekQueuedUploads(["task", "history"]), tasks: removedTasks, logs: removedLogs }));
  S.takeQueuedUploads("task", taskIds); S.takeQueuedUploads("history", logIds);
  removeTasksHere(app, taskIds); app.logs = []; app.idb.history = {};
  return { aborted: false };
}
const FLOWS = [["bulk delete", (a) => bulkDelete(a, ["x", "y"])], ["History delete", (a) => historyDelete(a, ["L"])], ["Clear Logs", clearLogs],
  ["Clear Outputs", clearOutputs], ["Reset", reset]];

// ─── 1. Reserve first: an abort changes nothing ───
await test("#1/#9/#16/#17: each delete aborting on a full origin leaves every store byte-identical (queue, debounced queue, IndexedDB, favorites, form, stashes)", () => {
  for (const [name, flow] of FLOWS) {
    for (const [how, arm] of [
      ["the failed-sync queue refuses", () => failKeys.add("proximaai-failed-syncs")],
      ["the hold refuses", () => failKeys.add(HELD)],
      ["the intents fit, the hold does not", () => { cap = used() + 300; }],
      ["nothing fits", () => { cap = used(); }]]) {
      mem.clear(); cap = Infinity; failKeys.clear();
      const app = makeApp();
      const before = snapshot(app);
      arm();
      const r = flow(app);
      failKeys.clear(); cap = Infinity;
      // History delete and Clear Logs hold no files (log deletes delete none): only a refused intent write stops them.
      const holdsNothing = name === "History delete" || name === "Clear Logs";
      if (!r.aborted) { assert.ok(holdsNothing && /hold/.test(how), `${name} / ${how}: must abort`); continue; }
      assert.equal(snapshot(app), before, `${name} / ${how}: every store byte-identical`);
      assert.deepEqual([app.saveStatus, app.toast, app.deletingIds], ["error", STORAGE_FULL, []], `${name} / ${how}: honest error, nothing marked`);
    }
  }
});
await test("#1/#17: the bulk delete's abort keeps the task's unsent queued version (the next reconcile still counts it pending)", () => {
  const app = makeApp();
  failKeys.add(HELD);
  assert.equal(bulkDelete(app, ["x"]).aborted, true);
  assert.deepEqual(S.getFailedSyncs().filter(e => e.kind === "task").map(e => [e.id, e.data.isArchived]), [["x", true]], "x's archived version still queued");
  assert.deepEqual(app.syncQueue.map(t => t.id), ["x", "z"], "the debounced queue still holds x");
  assert.ok(app.savedTaskIds.includes("x"));
});
await test("reserveDelete with room: the intents at their times and the hold, written together; an earlier stash records the move only then", () => {
  const app = makeApp();
  const r = bulkDelete(app, ["x", "y"]);
  assert.equal(r.aborted, false);
  const intents = S.getFailedSyncs().filter(e => /-delete$/.test(e.kind)).map(e => [e.kind, e.id, e.ts]);
  assert.deepEqual(intents.filter(([k]) => k === "task-delete").map(([, id, ts]) => [id, ts]), [["x", r.queuedAt], ["y", r.queuedAt]]);
  assert.deepEqual(intents.filter(([k, id]) => k === "history-delete" && id === "M").map(([, , ts]) => ts), [1000], "M keeps its own earlier intent");
  assert.deepEqual(heldPaths(), [...pathsOf("x"), ...pathsOf("y")].sort());
  assert.deepEqual(heldWs(), ["pred-x", "pred-y"]);
  assert.deepEqual(S.readClearStash(1000).movedTo, [r.queuedAt], "y moved from the stash's clear to this delete");
  assert.equal(mem.has(LEGACY), false, "nothing written under the previous build's key");
});
await test("reserveDelete refused: the earlier stash is NOT marked as moved, the earlier intent of y stays at its time", () => {
  makeApp();
  const stashBefore = mem.get("proximaai-clear-stash:1000");
  failKeys.add(HELD);
  const ok = S.reserveDelete({ intents: [{ kind: "task-delete", ids: ["y"], at: 5000 }], holdAt: 5000, hold: { files: { "scope/y-out.png": ["y"] }, ws: {} } });
  assert.equal(ok, false);
  assert.equal(mem.get("proximaai-clear-stash:1000"), stashBefore);
  assert.deepEqual(S.getFailedSyncs().filter(e => e.kind === "task-delete").map(e => [e.id, e.ts]), [["y", 1000]]);
  failKeys.clear();
  assert.equal(S.reserveDelete({ intents: [] }), true, "nothing to reserve: true, nothing written");
});
await test("#1/#9/#16/#17 wiring: in every delete, reserveDelete comes before ANY state change; its abort undoes nothing", () => {
  const MUTATIONS = /setTasks\(|setLogs\(|deleteTasks\(|deleteHistoryEntries\(|takeQueuedUploads\(|taskSyncQueueRef\.current = |removeFailedSync\(|savedTaskIds\.current\.delete|savedLogIds\.current\.delete|setSelectedModels\(|setFavoriteModelsByType\(|favoriteModelsRef\.current = |favoriteModelsUpdatedAtRef\.current = |writeClearStash\(|releasePredictions\(|recordClaimants\(|stagePurge\(|queueDeleteIntents\(|setSetting\(|clearTimeout\(taskSyncTimerRef|addFailedSync\(|saveTasks?\(|forgetConfirmed\(|holdPurgeDeletes\(|addHistoryEntry\(/;
  const UNDO = /takeBackDeleteIntents\(|intentsOf\(|putBackQueuedUploads\(|putBackClaimants\(|dropClearStash\(|setFavoriteModelsByType\(|taskSyncQueueRef|syncQueueBefore|favoritesBefore/;
  for (const [name, h] of [
    ["bulk delete", between("const deleteSelectedTasks = async", "const renderSelectBar")],
    ["History delete", between("const deleteSelectedLogs = async", "const renderLogSelectBar")],
    ["Clear Logs", between('createBackup("pre-clear-logs"', ">Clear Logs</button>")],
    ["Clear Outputs", between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>")],
    ["Reset", between('createBackup("pre-reset"', ">Reset Everything</button>")]]) {
    const r = h.indexOf("if (!reserveDelete(");
    assert.ok(r > 0, `${name}: reserves`);
    const m = h.slice(0, r).match(MUTATIONS);
    assert.equal(m, null, `${name}: nothing changes before the reservation (found ${m?.[0]})`);
    const ab = h.slice(r, h.indexOf("return;", r));
    assert.match(ab, /setSaveStatus\("error"\);\s*setAccountToast\(STORAGE_FULL_TOAST\);/, `${name}: the honest storage-full message`);
    assert.doesNotMatch(ab, UNDO, `${name}: nothing to undo`);
    assert.equal(h.match(/reserveDelete\(/g).length, 1, `${name}: one reservation`);
    assert.doesNotMatch(h, /queueDeleteIntents\(|intentsOf\(|takeBackDeleteIntents\(|plan\.held/, `${name}: no separate intent write, no undo`);
  }
  assert.doesNotMatch(src, /takeBackDeleteIntents|intentsOf\b/, "the undo helpers are gone from App.jsx");
  assert.doesNotMatch(st, /export function takeBackDeleteIntents|export function intentsOf/, "and from storage.js");
  // Reset: the favorites, the selected models and the local setting change only after the reservation (#9, #16).
  const rs = between('createBackup("pre-reset"', ">Reset Everything</button>");
  const rv = rs.indexOf("if (!reserveDelete(");
  for (const s of ["setSelectedModels([])", "favoriteModelsRef.current = emptyFavorites", 'removeFailedSync("model-favorites", favoriteScope)', "await setSetting(localModelFavoritesKey(favoriteScope)"])
    assert.ok(rs.indexOf(s) > rv, `Reset: ${s} after the reservation`);
  // stagePurge only applies; the plan is purge.js planDeleteStage (pure), the hold goes with the reservation.
  const sp = between("const stagePurge = useCallback(", "const purgeEverywhere = useCallback(");
  assert.doesNotMatch(sp, /holdPurgeDeletes\(|queueDeleteIntents\(|planPurge\(/);
});

// ─── 2. No silent writes, no cap on a pending delete's WaveSpeed entry (#18, #2) ───
// App.jsx deleteOnWaveSpeed as it now reads: returns the prediction ids neither held nor queued.
function deleteOnWaveSpeed(removed, { holdAt } = {}) {
  const now = Date.now(), direct = [], unstored = [];
  for (const t of removed || []) {
    if (!t?.taskId) continue;
    const h = t?.id ? S.deleteHoldAt(t.id) : undefined;
    const at = h === undefined ? holdAt : h;
    if (at != null) { if (!S.holdPurgeDeletes(at, { ws: W.queueDeletes({}, [t], now) })) unstored.push(t.taskId); continue; }
    direct.push(t);
  }
  if (direct.length && !S.writeWsDeletes(W.queueDeletes(S.readWsDeletes(), direct, now))) unstored.push(...direct.map(t => t.taskId));
  return unstored;
}
await test("#18: a hold refused for a pending delete is NOT queued directly; it is reported (honest error)", () => {
  S.queueDeleteIntents("task-delete", ["c"], 7000);
  failKeys.add(HELD);
  assert.deepEqual(deleteOnWaveSpeed([{ id: "c", taskId: "pred-c", status: "processing" }]), ["pred-c"]);
  assert.deepEqual([wsQueued(), heldWs()], [[], []], "neither queued nor held: reported, not sent before the delete's outcome");
});
await test("#18: a final delete's direct write refused is reported, not silently dropped", () => {
  S.queueDeleteIntents("task-delete", ["d"], 8000);
  S.confirmDeleteIntents("task-delete", ["d"], 8000);
  failKeys.add("proximaai-ws-deletes");
  assert.deepEqual(deleteOnWaveSpeed([{ id: "d", taskId: "pred-d", status: "processing" }]), ["pred-d"]);
  failKeys.clear();
  assert.deepEqual(deleteOnWaveSpeed([{ id: "d", taskId: "pred-d", status: "processing" }]), [], "with room: queued");
  assert.deepEqual(wsQueued(), ["pred-d"]);
});
await test("#18 wiring: deleteOnWaveSpeed checks both writes, has no direct fallback, says so; the lookup resolves only stored deletes", () => {
  const dow = between("const deleteOnWaveSpeed = useCallback(", "}, [flushWsDeletes]);");
  // Task B12b: the held write is holdLateResult for a relinked result (its relink and its hold, both checked).
  // Task B13a (review round 26 #6): the generation's relink parts are held with it after the checked write (rewritten:
  // the held block now also holds them before `continue`).
  assert.match(dow, /if \(at != null\) \{\s*const ws = queueDeletes\(\{\}, \[t\], now\);\s*const ok = relink && t\.id \? holdLateResult\(at, t\.id, t\.taskId, ws\[t\.taskId\]\) : holdPurgeDeletes\(at, \{ ws \}\);\s*if \(!ok\) unstored\.push\(t\.taskId\);[\s\S]*?continue;\s*\}/);
  assert.match(dow, /if \(direct\.length && !writeWsDeletes\(queueDeletes\(readWsDeletes\(\), direct, now\)\)\) unstored\.push\(/);
  assert.match(dow, /if \(unstored\.length\) \{[^}]*setSaveStatus\("error"\);/);
  assert.match(dow, /return unstored;/);
  const ro = between("const recoverOrphans = useCallback(", "const decided = new Map(");
  const del = ro.indexOf("deleteOnWaveSpeed(delNow.map("), rel = ro.indexOf("releasePredictions("), res = ro.indexOf("resolveClaimants(");
  assert.ok(del > 0 && rel > del && res > del, "the delete is stored before the prediction is released and its claimant resolved");
  assert.match(ro, /releasePredictions\(claimed\.filter\(p => !unstored\.has\(p\)\)\);/);
  assert.match(ro, /resolveClaimants\(resolved\.filter\(id => !retry\.has\(id\)\)\);/);
});
await test("#2 (r25 P2): a directly queued entry of a delete pending 49 h moves into that delete's hold (no cap) and goes once it is confirmed", () => {
  const T = Date.now() - 49 * 3600 * 1000;
  S.queueDeleteIntents("task-delete", ["x"], T);
  S.writeWsDeletes(W.queueDeletes({}, [gen("x")], T));
  // flushWsDeletes as it now reads: the pending delete's own entries go into its hold; one the hold refuses waits uncapped.
  const deletingNow = new Set([...S.pendingDeleteIds("task-delete"), ...S.inFlightIds("task-delete")]);
  const q = S.readWsDeletes();
  const ofDeleting = Object.keys(q).filter(p => q[p]?.tid && deletingNow.has(String(q[p].tid)));
  const left = need(S, "holdDeletingWsEntries")(ofDeleting);
  assert.deepEqual([left, wsQueued(), heldWs()], [[], [], ["pred-x"]], "held for x's delete, out of the direct queue");
  S.confirmDeleteIntents("task-delete", ["x"], T);
  assert.deepEqual([wsQueued(), heldWs()], [["pred-x"], []], "x's confirm sends it");
});
await test("#2: the hold refused -> the entry waits with no 48 h cap (waitHeldIds), never dropped unsent", () => {
  const T = Date.now() - 49 * 3600 * 1000;
  S.queueDeleteIntents("task-delete", ["x"], T);
  S.writeWsDeletes(W.queueDeletes({}, [gen("x")], T));
  failKeys.add(HELD);
  const left = need(S, "holdDeletingWsEntries")(["pred-x"]);
  assert.deepEqual(left, ["pred-x"]);
  const now = Date.now();
  const q = need(W, "waitHeldIds")(S.readWsDeletes(), left, now);
  assert.ok(q["pred-x"], "kept although older than 48 h");
  assert.ok(q["pred-x"].next >= now + W.HELD_RECHECK_MS);
  assert.equal(W.holdHeldIds(S.readWsDeletes(), left, now)["pred-x"], undefined, "premise: the capped hold would drop it");
});
await test("#2 wiring: flushWsDeletes moves a pending delete's entries into its hold, never through holdHeldIds' cap", () => {
  const flush = between("const flushWsDeletes = useCallback(", "const deleteOnWaveSpeed = useCallback(");
  assert.match(flush, /const left = holdDeletingWsEntries\(ofDeleting\);/);
  assert.match(flush, /writeWsDeletes\(waitHeldIds\(readWsDeletes\(\), left, Date\.now\(\)\)\)/);
  assert.doesNotMatch(flush, /holdHeldIds\(queued, ofDeleting/);
});

// ─── 3. #4: an item-less History entry is decided by the delete that removes it ───
function clearWithEmptyEntry() {
  const x = gen("x");
  const L = { id: "L", timestamp: Date.now(), sourceImageUrl: `${BASE}uploads/scope/L-src.png`, tasks: [] };
  const at = C.serverNow() - 1000;
  const staged = P.planDeleteStage([L], [x], [], { all: true, serverHistory: true, at, holdAt: at });
  assert.deepEqual(staged.send.remove, [], "premise: no History intent of its own (the server removes it in the clear)");
  // Task B13a (review round 26 #1): rewritten from [] (owner-less): the path is recorded with its entry ("entry:L"); the
  // delete as a whole still decides it unless restore evidence does (then the entry itself).
  assert.deepEqual(staged.hold.files["uploads/scope/L-src.png"], ["entry:L"], "recorded with its entry, no History delete of its own");
  assert.ok(S.reserveDelete({ intents: [{ kind: "task-delete", ids: ["x"], at }, ...staged.intents], holdAt: at, hold: staged.hold }));
  return at;
}
await test("#4 (r25 P3): Clear Outputs with an item-less entry: the final confirm sends its path too (no owner waiting forever)", () => {
  const at = clearWithEmptyEntry();
  S.releaseHeldPurges();
  assert.deepEqual(filesQueued(), [], "pending: held");
  S.confirmDeleteIntents("task-delete", ["x"], at);
  assert.deepEqual(filesQueued(), ["scope/x-out.png", "uploads/scope/L-src.png", "uploads/scope/x-src.png"]);
  assert.equal(mem.has(HELD), false, "nothing left held");
});
await test("#4: the same clear voided -> the entry's path waits with x's (undecided), and is kept when the pass sees x back", () => {
  const at = clearWithEmptyEntry();
  S.voidDeleteIntents("task-delete", ["x"], at);
  assert.deepEqual(filesQueued(), [], "nothing deleted on a void");
  assert.ok(heldPaths().includes("uploads/scope/L-src.png"), "undecided like x: still held");
  // Task B13a (review round 26 #1): rewritten from "x came back: everything of that delete is kept". x came back, so its
  // paths are kept; the entry L did NOT come back (absent from the cloud and this browser), so its path goes. The variant
  // where L came back too keeps everything.
  S.releaseHeldPurges(Date.now(), { restoreKnownAt: S.knownRestoreAt(), task: { present: ["x"], local: [], complete: true }, history: { present: [], local: [], complete: true } });
  assert.deepEqual([filesQueued(), heldPaths()], [["uploads/scope/L-src.png"], []], "x came back (kept); L did not (its path goes)");
  mem.clear();
  const at2 = clearWithEmptyEntry();
  S.voidDeleteIntents("task-delete", ["x"], at2);
  S.releaseHeldPurges(Date.now(), { restoreKnownAt: S.knownRestoreAt(), task: { present: ["x"], local: [], complete: true }, history: { present: ["L"], local: [], complete: true } });
  assert.deepEqual([filesQueued(), heldPaths()], [[], []], "x and L came back: everything of that delete is kept");
});
await test("#4: a group naming no owner at all follows its queue time; a voided time stays known while its hold is kept", () => {
  const at = C.serverNow() - 1000;
  assert.ok(S.reserveDelete({ intents: [{ kind: "task-delete", ids: ["x"], at }], holdAt: at, hold: { files: { "uploads/scope/L-src.png": [] }, ws: {} } }));
  S.releaseHeldPurges();
  assert.deepEqual(filesQueued(), [], "pending: waits");
  S.voidDeleteIntents("task-delete", ["x"], at);
  assert.deepEqual([filesQueued(), heldPaths()], [[], []], "voided: cancelled (the voided time was not pruned away first)");
  mem.clear();
  assert.ok(S.reserveDelete({ intents: [{ kind: "task-delete", ids: ["x"], at }], holdAt: at, hold: { files: { "uploads/scope/L-src.png": [] }, ws: {} } }));
  S.confirmDeleteIntents("task-delete", ["x"], at);
  assert.deepEqual(filesQueued(), ["uploads/scope/L-src.png"], "confirmed: queued");
});
await test("#4: an entry that HAS its own History delete (or an id-less item) still owns its paths", () => {
  const L = { id: "L", timestamp: Date.now(), sourceImageUrl: `${BASE}uploads/scope/L-src.png`, tasks: [] };
  assert.deepEqual(P.pathOwners([], [L], ["uploads/scope/L-src.png"], { logOwners: new Set(["L"]) }), { "uploads/scope/L-src.png": ["history:L"] });
  const M = { id: "M", sourceImageUrl: `${BASE}uploads/scope/M-src.png`, tasks: [{ outputs: [] }] };
  assert.deepEqual(P.pathOwners([], [M], ["uploads/scope/M-src.png"]), { "uploads/scope/M-src.png": ["history:M"] });
});

// ─── 4. #5: a new key, migrated once; a previous build never sees the new holds ───
// Task B14 (review round 27 #4) rewrote this from v2: the holds moved again (THE KEY RULE), so neither older key is written.
await test("#5: holds are written under proximaai-held-purges-v3, never under a previous build's key", () => {
  assert.ok(S.holdPurgeDeletes(9000, { files: { "scope/a.png": ["a"] } }));
  assert.deepEqual(Object.keys(heldNow()), ["9000"]);
  assert.equal(mem.has(LEGACY), false);
  assert.equal(mem.has("proximaai-held-purges-v2"), false);
  assert.match(st, /const HELD_PURGE_KEY = "proximaai-held-purges-v3";/);
});
await test("#5: the previous key's items move into the new key once (merged), then the old key goes; a refused write keeps them", () => {
  const migrate = need(S, "migrateLegacyHeldPurges");
  S.holdPurgeDeletes(100, { files: { "p1": ["a"] } });
  mem.set(LEGACY, JSON.stringify({ 100: { files: { p1: ["b"], p2: ["c"] }, ws: { w1: { at: 1, attempts: 0, next: 1, tid: "c" } }, h: 150 }, 200: { files: { p3: ["d"] }, ws: {} } }));
  failKeys.add(HELD);
  migrate();
  assert.ok(mem.has(LEGACY), "the new key refused: nothing lost, the old key stays");
  failKeys.clear();
  migrate();
  assert.equal(mem.has(LEGACY), false, "moved");
  const m = heldNow();
  assert.deepEqual(m[100].files, { p1: ["a", "b"], p2: ["c"] }, "owners merged");
  assert.deepEqual(Object.keys(m[100].ws), ["w1"]);
  assert.equal(m[100].h, 150);
  assert.deepEqual(m[200].files, { p3: ["d"] });
  migrate();
  assert.deepEqual(heldNow(), m, "idempotent");
});
await test("#5: a fresh page migrates on load (module start)", async () => {
  mem.set(LEGACY, JSON.stringify({ 300: { files: { p9: ["z"] }, ws: {} } }));
  globalThis.sessionStorage = sessionOf();
  const S2 = await import(ROOT + "src/lib/storage.js?b12a-load");
  assert.equal(mem.has(LEGACY), false);
  assert.deepEqual(heldNow()[300].files, { p9: ["z"] });
  assert.deepEqual(S2.heldPurgeLeft(["p9"], []).files, 1);
});
await test("#5: a previous build's flush (reads only the old key, cancels an undecided owner) cannot touch the new holds", () => {
  const T = 1_790_000_000_000;
  S.queueDeleteIntents("task-delete", ["x"], T);
  assert.ok(S.holdPurgeDeletes(T, { files: Object.fromEntries(pathsOf("x").map(p => [p, ["x"]])) }));
  S.restoreGuard({ last_restore_at: T + 5000 });                           // x's delete dropped: undecided
  // a79a43c's releaseHeldPurges (storage.js:986-1029): read the OLD key, "cancel" every owner without a final confirm.
  const old = JSON.parse(mem.get(LEGACY) || "{}");
  for (const k of Object.keys(old)) delete old[k];
  if (mem.has(LEGACY)) mem.set(LEGACY, JSON.stringify(old));
  assert.deepEqual(heldPaths(), pathsOf("x").sort(), "still held for the new build's pass to decide");
  assert.match(st, /previous build/i, "the rule is documented at the key");
});
await test("#5: a hold the previous build writes under its key (after this page migrated) still guards this build's flushes, read only", () => {
  mem.set(LEGACY, JSON.stringify({ 400: { files: { "scope/old.png": ["o"] }, ws: { "pred-o": { at: 1, attempts: 0, next: 1, tid: "o" } } } }));
  const r = S.heldDeleteRefs();
  assert.ok(r.paths.has("scope/old.png") && r.predictions.has("pred-o"));
  S.releaseHeldPurges();
  assert.ok(mem.has(LEGACY), "not decided nor moved by this build until its next start");
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
