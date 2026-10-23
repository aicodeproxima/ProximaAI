// Task B13b (simulator classes A, C, D, E and I2 seed 12378; plus a WaveSpeed flush race the simulator found on the way):
// A  a reconcile pass that removes generations a user deleted elsewhere re-plans their files against this tab's kept view;
// C  it queues their WaveSpeed results, and History items carry the prediction id (History-only generations);
// D  an undecided held owner another browser deleted (a user tombstone) is decided "gone" without a restore; Clear Outputs
//    and Reset plan with the late rows and entries they do not delete as kept;
// E  Clear Outputs names its unnamed History-only ids that had no row after the clear (delete_queued_rows: tombstoned);
// I2 a voided Reset / Clear Logs gives back to STATE the stored-only entries a page load would show;
// WS the WaveSpeed flush sends only ids its checks saw.
// Runs the real storage.js, purge.js, batchLog.js and wsDelete.js; App.jsx wiring is checked from the source. Written first:
// against the tree before B13b (B13B_ROOT=<a copy of that tree>) every test below fails except the two D guards (what must
// still wait; a final confirm in the shared record), which hold before and after.
// Run: node scripts/test-b13b-sim-classes.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.B13B_ROOT ? pathToFileURL(process.env.B13B_ROOT.replace(/\/?$/, "/")).href : new URL("../", import.meta.url).href;
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
const S = await import(ROOT + "src/lib/storage.js");
const P = await import(ROOT + "src/lib/purge.js");
const B = await import(ROOT + "src/lib/batchLog.js");
const W = await import(ROOT + "src/lib/wsDelete.js");
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
  try { mem.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const need = (mod, name) => { assert.equal(typeof mod[name], "function", `${name} exists`); return mod[name]; };
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const IN = (b) => `${BASE}uploads/s/${b}.png`;
const task = (id, batch, extra = {}) => ({ id, batchId: batch, taskId: `pred-${id}`, status: "completed", startTime: 1000, modelName: "M",
  sourceImageUrl: IN(batch), outputs: [`${BASE}s/${id}.png`], ...extra });
const entry = (id, items, extra = {}) => ({ id, timestamp: 1000, sourceImageUrl: IN(id), tasks: items, ...extra });

// ─── A: re-plan what a user deleted elsewhere against this tab's kept view ───
await test("A: two devices each delete one sibling while the other still shows: the pass removing the second plans the shared input", () => {
  const elsewherePurge = need(P, "elsewherePurge");
  const t1 = task("t1", "L1"), t2 = task("t2", "L1");
  // Browser B deleted t2 itself (its plan kept the input: t1 still showed); its History is L1(t1). Now a pass removes t1,
  // which browser A deleted (user tombstone): L1 is emptied and dropped, nothing kept here uses the input any more.
  const logsBefore = [entry("L1", B.batchLogItems([t1]))];
  const r = elsewherePurge({ gone: [t1], logsBefore, keptTasks: [], keptLogs: [] });
  assert.deepEqual(r.paths.sort(), ["s/t1.png", "uploads/s/L1.png"]);
  // A sibling still kept here (t2 shows in this tab) keeps the input; the gone one's own output still goes.
  const r2 = elsewherePurge({ gone: [t1], logsBefore: [entry("L1", B.batchLogItems([t1, t2]))], keptTasks: [t2], keptLogs: [entry("L1", B.batchLogItems([t2]))] });
  assert.deepEqual(r2.paths, ["s/t1.png"]);
  // A History-only generation (an item, no task here) whose entry left with it: the entry's own input goes too.
  const item = B.batchLogItems([task("t9", "L9")])[0];
  const r3 = elsewherePurge({ gone: [item], logsBefore: [entry("L9", [item])], keptTasks: [], keptLogs: [] });
  assert.deepEqual(r3.paths.sort(), ["s/t9.png", "uploads/s/L9.png"]);
  // An entry this tab keeps for other reasons is not "emptied" (its input stays).
  const r4 = elsewherePurge({ gone: [item], logsBefore: [entry("L9", [item])], keptTasks: [], keptLogs: [entry("L9", [])] });
  assert.deepEqual(r4.paths, ["s/t9.png"]);
});
await test("A wiring: the reconcile pass re-plans stale rows, user-removed rows and gone History items once its History drops are done", () => {
  const pass = between("const reconcileWithCloud = useCallback(", "useEffect(() => {\n    if (!isAuthed) return;");
  assert.match(pass, /const logsBeforeDrops = logsRef\.current;[^\n]*\n\s*const staleTasks = new Set\(taskDel\.stale/);
  assert.match(pass, /userRemovedHere = userRemoved;/);
  const step = pass.slice(pass.indexOf("if (goneItems.length) dropLogItemsFor("), pass.indexOf("const taskUploads = uploadable("));
  assert.match(step, /const goneHere = \[\.\.\.staleTaskRows, \.\.\.userRemovedHere\];/);
  assert.match(step, /for \(const id of \[\.\.\.staleItemIds, \.\.\.goneItems\]\)/);
  assert.match(step, /elsewherePurge\(\{ gone: goneHere, logsBefore: logsBeforeDrops,\s*keptTasks: \[\.\.\.tasksRef\.current\.filter\(t => !rmTasks\.has\(t\.id\) && !goneHereIds\.has\(t\.id\)\), \.\.\.taskSyncQueueRef\.current\],\s*keptLogs: logsRef\.current\.filter\(l => !rmLogs\.has\(l\.id\)\) \}\)/);
  assert.match(step, /queueArchivedFileDeletes\(paths\);/);
});

// ─── C: the WaveSpeed result of a generation deleted elsewhere ───
await test("C: the pass queues the prediction of every removed generation that has one (once); History items carry it", () => {
  const elsewherePurge = need(P, "elsewherePurge");
  const r = elsewherePurge({ gone: [task("t1", "L1"), { ...task("t1b", "L1"), taskId: "pred-t1" }, { id: "t3" }], logsBefore: [], keptTasks: [], keptLogs: [] });
  assert.deepEqual(r.ws.map(t => [t.id, t.taskId]), [["t1", "pred-t1"]]);
  // History items carry the prediction id (batchLog.js itemOf), and so do History-only generations built from them.
  const [item] = B.batchLogItems([task("t5", "L5")]);
  assert.equal(item.taskId, "pred-t5");
  assert.equal(B.batchLogItems([{ id: "t6", status: "processing" }])[0].taskId, undefined, "no id yet: no field");
  const [g] = B.historyOnlyGenerations([entry("L5", [item])], new Set());
  assert.equal(g.taskId, "pred-t5");
  // So Clear Outputs' hold of a History-only generation names its WaveSpeed result.
  const staged = P.planDeleteStage([entry("L5", [item])], [g], [], { all: true, serverHistory: true, at: 5, holdAt: 5, now: 10 });
  assert.deepEqual(Object.keys(staged.hold.ws), ["pred-t5"]);
  // An item copy of a removed generation is found by the pass too.
  assert.deepEqual(elsewherePurge({ gone: [item], logsBefore: [], keptTasks: [], keptLogs: [] }).ws.map(t => t.taskId), ["pred-t5"]);
});
await test("C wiring: the pass sends them through deleteOnWaveSpeed without an early flush", () => {
  const step = between("if (goneItems.length) dropLogItemsFor(", "const taskUploads = uploadable(");
  assert.match(step, /if \(ws\.length\) deleteOnWaveSpeed\(ws, \{ flush: false \}\);/);
  const fn = between("const deleteOnWaveSpeed = useCallback(", "}, [flushWsDeletes]);");
  assert.match(fn, /\{ holdAt, relink = false, flush = true \} = \{\}/);
  assert.match(fn, /if \(flush\) flushWsDeletes\(\);/);
});

// ─── D: undecided owners another browser deleted ───
const T = 1_790_000_000_000;
const holdLate = () => {
  assert.ok(S.holdPurgeDeletes(T, { files: { "s/late.png": ["late"] }, ws: W.queueDeletes({}, [{ id: "late", taskId: "pred-late", status: "completed" }], T) }));
};
const ev = (over = {}) => ({ restoreKnownAt: 0, task: { present: [], local: [], deleted: ["late"], complete: true, ...over },
  history: { present: [], local: [], deleted: [], complete: true } });
await test("D: an undecided owner with a user tombstone, absent from the cloud and this browser, is gone without any restore", () => {
  holdLate();
  const r = S.releaseHeldPurges(T + 10, ev());
  assert.deepEqual([r.files, r.ws], [["s/late.png"], ["pred-late"]]);
  assert.deepEqual(Object.keys(S.readFileDeletes()), ["s/late.png"]);
  assert.deepEqual(Object.keys(S.readWsDeletes()), ["pred-late"]);
});
await test("D: no tombstone, a row or item in the cloud, a copy kept here, incomplete reads, or a restore learned during the pass: it waits", () => {
  for (const [why, e] of [["no tombstone", ev({ deleted: [] })], ["present", ev({ present: ["late"] })], ["kept here", ev({ local: ["late"] })],
    ["incomplete", ev({ complete: false })]]) {
    mem.clear(); holdLate();
    const r = S.releaseHeldPurges(T + 10, e);
    assert.deepEqual([r.files, r.ws, r.cancelled], [[], [], 0], why);
  }
  mem.clear(); holdLate();
  S.noteRestoreKnown(T + 5);   // learned after this pass's reads began (its restoreKnownAt is older)
  assert.deepEqual(S.releaseHeldPurges(T + 10, ev()).files, [], "restore learned during the pass");
});
await test("D: a final confirm in the shared record queued at or after the hold sends it (another tab's delete)", () => {
  holdLate();
  S.queueDeleteIntents("task-delete", ["late"], T + 1);
  S.confirmDeleteIntents("task-delete", ["late"], T + 1);   // its answer releases the hold (no pass, no evidence)
  S.releaseHeldPurges(T + 10);
  assert.deepEqual([Object.keys(S.readFileDeletes()), Object.keys(S.readWsDeletes()), S.hasHeldPurges()], [["s/late.png"], ["pred-late"], false]);
});
await test("D: a plan that keeps the late rows and entries holds nothing for them (Clear Outputs, Reset)", () => {
  const entriesWithout = need(P, "entriesWithout");
  const a = task("a", "L1"), late = task("late", "L1", { outputs: [`${BASE}s/late.png`] });
  const logs = [entry("L1", B.batchLogItems([a, late]))];
  const before = P.planDeleteStage(logs, [a], [], { all: true, serverHistory: true, at: T, holdAt: T, now: T });
  assert.ok(Object.values(before.hold.files).some(o => o.includes("late")), "kept = []: the late row is named");
  const after = P.planDeleteStage(logs, [a], [late], { all: true, serverHistory: true, at: T, holdAt: T, now: T });
  assert.ok(!Object.values(after.hold.files).some(o => o.includes("late")), "kept: never named");
  assert.deepEqual(after.plan.paths, ["s/a.png"]);
  // Late entries are kept without the removed generations' items (an entry left with none owns nothing).
  assert.deepEqual(entriesWithout([entry("L2", [{ id: "a" }, { id: "b" }]), entry("L3", [{ id: "a" }]), entry("L4", [])], new Set(["a"]))
    .map(l => [l.id, l.tasks.map(i => i.id)]), [["L2", ["b"]], ["L4", []]]);
});
await test("D wiring: the pass passes the tombstones; Clear Outputs and Reset plan with the late rows and entries kept", () => {
  const pass = between("const reconcileWithCloud = useCallback(", "useEffect(() => {\n    if (!isAuthed) return;");
  assert.match(pass, /const userTaskTombstones = ids\.taskTombstones instanceof Set && restoreRemoved \? \[\.\.\.ids\.taskTombstones\]\.filter\(id => !restoreRemoved\.has\(id\)\) : \[\];/);
  assert.match(pass, /task: \{ present: [^\n]*, deleted: userTaskTombstones,/);
  assert.match(pass, /history: \{ present: [^\n]*, deleted: ids\.historyTombstones instanceof Set \? \[\.\.\.ids\.historyTombstones\] : \[\],/);
  const outputs = between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>");
  assert.match(outputs, /const lateKept = \[\.\.\.remote\.tasks\.filter\(t => !plannedTaskIds\.has\(t\.id\)\), \.\.\.entriesWithout\(remote\.history\.filter\(l => late\.has\(l\.id\)\), plannedTaskIds\)\];\s*const staged = planStagePurge\(removed, lateKept,/);
  const reset = between('createBackup("pre-reset"', ">Reset Everything</button>");
  assert.match(reset, /const keptTasks = \[\.\.\.tasksRef\.current\.filter\(t => !plannedTaskIds\.has\(t\.id\)\),\s*\.\.\.remote\.tasks\.filter\(t => !plannedTaskIds\.has\(t\.id\) && !currentTasks\.has\(t\.id\)\), \.\.\.entriesWithout\(remote\.history\.filter\(l => !plannedLogIds\.has\(l\.id\)\), plannedTaskIds\)\];/);
});

// ─── E: Clear Outputs names the History-only ids that had no row after the clear ───
await test("E wiring: the plain unnamed History-only ids are named at the clear's time before their confirm", () => {
  const outputs = between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>");
  const i = outputs.indexOf("if (plainIds.length && isSupabaseConfigured()) { try { await deleteTasksRemote(plainIds, queuedAt); } catch {} }");
  const j = outputs.indexOf('if (plainIds.length) confirmIntents("task-delete", plainIds, queuedAt);');
  assert.ok(i > 0 && j > i, "named first, then confirmed");
});

// ─── I2 (seed 12378): a voided clear's stored-only give-back that a load would show goes back into state ───
await test("I2: intoLoadedView picks the stored-only copies within the newest 500 of state plus them", () => {
  const intoLoadedView = need(S, "intoLoadedView");
  const loaded = [{ id: "a", timestamp: 50 }, { id: "b", timestamp: 40 }];
  const stored = [{ id: "L4", timestamp: 45 }, { id: "old", timestamp: 1 }, { id: "a", timestamp: 50 }];
  assert.deepEqual(intoLoadedView(stored, loaded, { time: l => l.timestamp }).map(l => l.id), ["L4", "old"], "fewer than 500: all of them");
  assert.deepEqual(intoLoadedView(stored, loaded, { time: l => l.timestamp, limit: 3 }).map(l => l.id), ["L4"], "only the newest");
  assert.deepEqual(intoLoadedView([], loaded, { time: l => l.timestamp }), []);
});
await test("I2 wiring: the voided Reset and Clear Logs put those copies into state, saved", () => {
  const reset = between('createBackup("pre-reset"', ">Reset Everything</button>");
  assert.match(reset, /const logsIntoView = intoLoadedView\(storedLogsBack, \[\.\.\.logsRef\.current, \.\.\.logsBack\], \{ time: l => l\.timestamp \}\);/);
  assert.match(reset, /const tasksIntoView = intoLoadedView\(storedTasksBack\.filter\(t => t\.status === "completed" \|\| t\.status === "failed"\), \[\.\.\.tasksRef\.current, \.\.\.tasksBack\], \{ time: t => t\.startTime \}\);/);
  assert.match(reset, /const add = logsToState\.filter\(l => !have\.has\(l\.id\)\)/);
  assert.match(reset, /const add = tasksToState\.filter\(t => !have\.has\(t\.id\)\)/);
  assert.match(reset, /for \(const l of logsIntoView\) savedLogIds\.current\.add\(l\.id\);/);
  assert.match(reset, /for \(const t of tasksIntoView\) savedTaskIds\.current\.add\(t\.id\);/);
  const logs = between('createBackup("pre-clear-logs"', ">Clear Logs</button>");
  assert.match(logs, /const logsIntoView = intoLoadedView\(storedOnlyBefore\.filter\(l => backIds\.has\(l\.id\)\), \[\.\.\.logsRef\.current, \.\.\.logsBack\], \{ time: l => l\.timestamp \}\);/);
  assert.match(logs, /const add = logsToState\.filter\(l => !have\.has\(l\.id\)\)/);
  assert.match(logs, /for \(const l of logsIntoView\) savedLogIds\.current\.add\(l\.id\);/);
});

// ─── WS: the WaveSpeed flush sends only what its checks saw ───
await test("WS wiring: an id queued during the flush's checks is not sent unchecked", () => {
  const fn = between("const flushWsDeletes = useCallback(", "}, []);");
  assert.match(fn, /const checked = new Set\(due\);\s*for \(const chunk of dueDeletes\(readWsDeletes\(\), Date\.now\(\)\)\) \{\s*const ids = chunk\.filter\(p => checked\.has\(p\)\);\s*if \(!ids\.length\) continue;/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
