// Task B14 (review round 27). Runs the real storage.js and purge.js; App.jsx wiring is checked from the source. Written
// first: before the change each test below fails.
// #1 A queued upload or a clear stash's copy of an id the cloud tombstones (a user's delete, or the restore's own removal)
//    is not "this browser keeps it": the server never inserts a tombstoned id (_rows_not_tombstoned skips it), so a hold
//    a restore left undecided was cancelled and the files and WaveSpeed result of a generation the restore removed stayed
//    (owner ruling 2026-10-23).
// Run: node scripts/test-b14-round27.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
const S = await import("../src/lib/storage.js");
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
const test = async (name, fn) => {
  try { mem.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const gen = (id) => ({ id, taskId: `pred-${id}`, status: "completed", startTime: Date.now() - 600_000, outputs: [`${BASE}s/${id}.png`] });
const filesQueued = () => Object.keys(S.readFileDeletes()).sort();
const wsQueued = () => Object.keys(S.readWsDeletes()).sort();
// A delete of x reserved at T, then cancelled by a restore that removed x (no row, no History item after it).
const deleteThenVoid = (x, T) => {
  const st = P.planDeleteStage([], [x], [], { history: false, holdAt: T });
  assert.ok(S.reserveDelete({ intents: [{ kind: "task-delete", ids: [x.id], at: T }], holdAt: T, hold: st.hold }));
  S.voidDeleteIntents("task-delete", [x.id], T);
};
const evidence = (tombstoned) => ({ restoreKnownAt: S.knownRestoreAt(),
  task: { present: [], local: new Set(), tombstoned, complete: true }, history: { present: [], local: new Set(), tombstoned: [], complete: true } });

await test("#1: a queued upload of an id the cloud tombstones does not keep it: its files and result go", () => {
  const T = Date.now() - 60_000, x = gen("x");
  deleteThenVoid(x, T);
  S.addFailedSync({ kind: "task", id: "x", data: x });   // e.g. given back by the voided clear's stash
  S.releaseHeldPurges(Date.now(), evidence(["x"]));
  assert.deepEqual([filesQueued(), wsQueued()], [["s/x.png"], ["pred-x"]]);
});

await test("#1: the same queued upload without a tombstone still keeps it (it may land)", () => {
  const T = Date.now() - 60_000, x = gen("x");
  deleteThenVoid(x, T);
  S.addFailedSync({ kind: "task", id: "x", data: x });
  S.releaseHeldPurges(Date.now(), evidence([]));
  assert.deepEqual([filesQueued(), wsQueued()], [[], []]);
});

await test("#1 wiring: the pass hands the tombstones it read to the evidence", () => {
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  assert.match(rec, /task: \{ present: \[\.\.\.\(ids\.tasks \|\| \[\]\), \.\.\.\(cloudItemIds \|\| \[\]\)\], local: keptTaskIds, deleted: userTaskTombstones, tombstoned: \[\.\.\.tombT\],/);
  assert.match(rec, /history: \{ present: \[\.\.\.\(ids\.history \|\| \[\]\)\], local: keptLogIds, deleted: [^\n]*, tombstoned: \[\.\.\.tombH\],/);
});

// #4 THE KEY RULE: the owner ruling changed how holds are decided (a previous build cancels what this one sends), so the
//    holds move to a key no previous build reads, once, and the older keys only guard the flushes.
await test("#4: holds are written under proximaai-held-purges-v3, never under v2 or v1", () => {
  assert.ok(S.holdPurgeDeletes(9000, { files: { "scope/a.png": ["a"] } }));
  assert.deepEqual(Object.keys(JSON.parse(mem.get("proximaai-held-purges-v3") || "{}")), ["9000"]);
  assert.equal(mem.has("proximaai-held-purges-v2"), false);
  assert.equal(mem.has("proximaai-held-purges"), false);
});
await test("#4: a v2 hold (a bf37422 / 3d14d8a tab) moves into v3 once, merged, and the v2 key goes", () => {
  S.holdPurgeDeletes(100, { files: { p1: ["a"] } });
  mem.set("proximaai-held-purges-v2", JSON.stringify({ 100: { files: { p1: ["b"] }, ws: {} }, 200: { files: { p2: ["c"] }, ws: { w: { at: 1, attempts: 0, next: 1, tid: "c" } } } }));
  S.migrateLegacyHeldPurges();
  const v3 = JSON.parse(mem.get("proximaai-held-purges-v3"));
  assert.deepEqual(v3["100"].files.p1.sort(), ["a", "b"]);
  assert.deepEqual(Object.keys(v3["200"].ws), ["w"]);
  assert.equal(mem.has("proximaai-held-purges-v2"), false);
});
await test("#4: a v2 hold written after this page's migration guards the flushes and is not decided here", () => {
  mem.set("proximaai-held-purges-v2", JSON.stringify({ 300: { files: { "scope/old.png": ["o"] }, ws: { "pred-o": { at: 1, attempts: 0, next: 1, tid: "o" } } } }));
  const refs = S.heldDeleteRefs();
  assert.ok(refs.paths.has("scope/old.png") && refs.predictions.has("pred-o"));
  S.releaseHeldPurges(Date.now());
  assert.ok(mem.has("proximaai-held-purges-v2"), "left to the build that wrote it");
});

// #5 + #7: a browser's rows not uploaded yet are published in a settings row no previous build writes
//    (form-inputs:<browser>:unsent: the server keeps every form-inputs:% row out of backups, Reset and restores), with
//    their paths, generation ids and prediction ids; the WaveSpeed flush holds a prediction such a publication names.
const F = await import("../src/lib/fileDelete.js");
await test("#7: unsentGenerations: ids and prediction ids of queued task rows and of queued History entries' items", () => {
  assert.equal(typeof S.unsentGenerations, "function");
  S.addFailedSync({ kind: "task", id: "x", data: { id: "x", taskId: "pred-x", sourceImageUrl: `${BASE}uploads/s/in.png` } });
  S.addFailedSync({ kind: "history", id: "L", data: { id: "L", tasks: [{ id: "y", taskId: "pred-y", outputs: [] }, { id: "z" }] } });
  S.queueDeleteIntents("task-delete", ["gone"], 1000);
  const u = S.unsentGenerations();
  assert.deepEqual([u.ids.sort(), u.predictions.sort(), u.paths], [["x", "y", "z"], ["pred-x", "pred-y"], ["uploads/s/in.png"]]);
});
await test("#7: liveUnsent reads ids and predictions of live publications only", () => {
  assert.equal(typeof F.liveUnsent, "function");
  const now = Date.now();
  const u = F.liveUnsent([{ at: now, paths: [], ids: ["x"], predictions: ["pred-x"] }, { at: now - 8 * 864e5, ids: ["old"], predictions: ["pred-old"] }, { at: now, paths: ["a"] }, null], now);
  assert.deepEqual([[...u.ids], [...u.predictions]], [["x"], ["pred-x"]]);
});
await test("#5 wiring: form-inputs carries the forms only; the unsent row is its own key, published when it changes", () => {
  const eff = between("// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>");
  assert.equal((eff.match(/mine = \[\.\.\.liveFormPaths\(readFormPublications\(\), now\)\];/g) || []).length, 2, "publish() and bye(): forms only");
  // Task B15 (review round 28 #4/#2) rewrote these anchors: the :unsent write moved into the module-level publishUnsent.
  assert.match(eff, /publishUnsent\(\);/);
  const fn = between("async function publishUnsentOnce({ exiting = false } = {}) {", "\n}\n")   /* task B16: the chained body */;
  assert.match(fn, /const items = \[\.\.\.un\.paths, \.\.\.un\.ids\.map\(i => `id:\$\{i\}`\), \.\.\.un\.predictions\.map\(p => `p:\$\{p\}`\)\];/);
  assert.match(fn, /syncSetting\(`form-inputs:\$\{browserId\(\)\}:unsent`, \{ at: now, paths: un\.paths, ids: un\.ids, predictions: un\.predictions \}\)/);
});
await test("#7 wiring: the WaveSpeed flush holds a prediction any browser's unsent rows name; unreadable: nothing is sent", () => {
  const fl = between("const flushWsDeletes = useCallback(async () => {", "const checked = new Set(due);");
  assert.match(fl, /const pubs = isSupabaseConfigured\(\) \? await pullFormHolds\(\) : \[\];\s*if \(pubs === null\) return;/);
  assert.match(fl, /const unsent = liveUnsent\(\[\.\.\.pubs, \{ at: Date\.now\(\), \.\.\.unsentGenerations\(\) \}\], Date\.now\(\)\);/);
  assert.match(fl, /for \(const p of due\) if \(unsent\.predictions\.has\(p\) \|\| \(queue\[p\]\?\.tid && unsent\.ids\.has\(String\(queue\[p\]\.tid\)\)\)\) held\.push\(p\);/);
  assert.ok(fl.indexOf("const unsent = liveUnsent(") < fl.indexOf("if (held.length) writeWsDeletes(holdHeldIds("), "before the hold is written");
});

// #2: the row read right after Clear Outputs is retried (a frozen tab or a killed socket resumes) before the all-assumed
//    fallback, which keeps a row the server left alone but would release the files of a generation whose row is still to
//    come.
await test("#2 wiring: Clear Outputs retries taskRowsPresentRemote up to 3 times, 2 s apart, before assuming", () => {
  const h = between("const unnamedHistoryOnly = historyOnly.filter(", "const assumedSet = new Set(assumedIds);");
  assert.match(h, /let withRow = isSupabaseConfigured\(\) \? null : new Set\(\);\s*for \(let i = 0; i < 3 && withRow === null; i\+\+\) \{\s*if \(i\) await new Promise\(r => setTimeout\(r, 2000\)\);\s*withRow = await taskRowsPresentRemote\(unnamedHistoryOnly\);\s*\}/);
  assert.match(h, /const assumedIds = withRow \? unnamedHistoryOnly\.filter\(id => withRow\.has\(id\)\) : unnamedHistoryOnly;/);
});

// #3: task B15 (review round 28 #1/#3/#5) replaced B14's deferred drop: the give-back's IndexedDB transactions are
//    created before the synchronous drop, and the pass reads the stash before its IndexedDB read too
//    (scripts/test-b15-round28.mjs). Rewritten to that design.
await test("#3 wiring: the give-back writes IndexedDB in transactions created before the synchronous drop", () => {
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  assert.match(apply, /saveTasksNow\(\[\.\.\.backTasks, \.\.\.shownTasks\]\);/);   // task B16: + the shown copies
  assert.match(apply, /addHistoryEntriesNow\(\[\.\.\.backLogs, \.\.\.shownLogs\]\);/);
  assert.ok(apply.indexOf("saveTasksNow([...backTasks, ...shownTasks]);") < apply.indexOf("dropGivenBackStash(s);"), "written before the drop");
  assert.ok(!/givingBackRef|Promise\.allSettled\(writes\)/.test(src), "no deferred drop");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
