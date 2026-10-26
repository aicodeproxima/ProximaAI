// Task B13a (review round 26 #1-#7; simulator classes G and A2): the clear stash is part of the reservation; only the
// unnamed History-only ids whose row the server left in place are assumed; F1's re-delete applies only to confirms this
// build marked final (THE KEY RULE for confirm records); a relink is part of its generation; a late prediction linked to
// a kept task is uploaded; an item-less History entry's paths are decided by the entry under restore evidence; a
// by_restore tombstone no longer keeps a held generation's files; Reset strips removed ids from the entries it keeps.
// Runs the real storage.js, purge.js and wsDelete.js; two storage.js instances (two tabs) share one localStorage. App.jsx
// and supabase.js wiring is checked from the source. Written first: against the tree before B13a
// (B13A_ROOT=<a git archive of HEAD d72574e>) every test below fails.
// Run: node scripts/test-b13a-round26.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.B13A_ROOT ? pathToFileURL(process.env.B13A_ROOT.replace(/\/?$/, "/")).href : new URL("../", import.meta.url).href;
const mem = new Map();
let failWhen = null;   // (key, value) => true: that write is refused like a full localStorage
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (failWhen && failWhen(k, String(v))) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; } mem.set(k, String(v)); },
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sessionOf = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
globalThis.sessionStorage = sessionOf();
const A = await import(ROOT + "src/lib/storage.js?tab=a");
globalThis.sessionStorage = sessionOf();
const B = await import(ROOT + "src/lib/storage.js?tab=b");
const P = await import(ROOT + "src/lib/purge.js");
const W = await import(ROOT + "src/lib/wsDelete.js");
const C = await import(ROOT + "src/lib/serverClock.js");
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");
const src = read("src/App.jsx"), supa = read("src/lib/supabase.js");
const between = (from, to, s = src) => {
  const i = s.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = s.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return s.slice(i, j);
};

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); failWhen = null; await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
  finally { failWhen = null; }
};
const need = (mod, name) => { assert.equal(typeof mod[name], "function", `${name} exists`); return mod[name]; };
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const gen = (id, extra = {}) => ({ id, taskId: `pred-${id}`, status: "completed", startTime: Date.now() - 600_000, outputs: [`${BASE}s/${id}.png`], ...extra });
const FAILED = "proximaai-failed-syncs", HELD = "proximaai-held-purges-v3", CONFIRMED = "proximaai-confirmed-deletes";
const filesQueued = () => Object.keys(A.readFileDeletes()).sort();
const wsQueued = () => Object.keys(A.readWsDeletes()).sort();
const heldNow = () => JSON.parse(mem.get(HELD) || "{}");
const heldPaths = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.files || {})))].sort();
const heldWs = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.ws || {})))].sort();
const pass = (S, cloudTasks, { rk = 0 } = {}) => S.sharedDeleteState("task", { deleting: new Set(), cloudIds: new Set(cloudTasks), sinceSeq: S.confirmSeqNow(),
  restoreKnownAt: rk, evidence: { present: [], complete: true } });

// ─── 1. r26 #4: the clear stash is part of the reservation ───
await test("#4: a stash that does not fit refuses the whole reservation; the intents, the hold and the stash key get their exact previous strings", () => {
  const T = 1_790_000_000_000;
  // Earlier state: a queued upload and an unrelated hold (the exact strings must come back).
  mem.set(FAILED, JSON.stringify([{ kind: "task", id: "u", data: { id: "u" }, ts: 5, attempts: 1 }]));
  mem.set(HELD, JSON.stringify({ 100: { files: { "s/old.png": ["old"] }, ws: {} } }));
  mem.set(`proximaai-clear-stash:${T}`, JSON.stringify({ uploads: [], tasks: [{ id: "keepme" }], logs: [], at: T }));
  const before = new Map(mem);
  const x = gen("x");
  const stash = A.buildClearStash({ tasks: [x], cloudTaskIds: new Set() });
  failWhen = (k) => k === `proximaai-clear-stash:${T}`;
  const ok = A.reserveDelete({ intents: [{ kind: "task-delete", ids: ["x"], at: T }], holdAt: T,
    hold: { files: { "s/x.png": ["x"] }, ws: W.queueDeletes({}, [x], Date.now()) }, stash: { at: T, value: stash } });
  assert.equal(ok, false, "refused: no stash, no clear");
  assert.deepEqual([...mem.entries()].sort(), [...before.entries()].sort(), "every key exactly as before");
});
await test("#4: the stash is written inside the reservation; a full stash that does not fit falls back to the smaller one", () => {
  const T = 1_790_000_000_000;
  const big = A.buildClearStash({ logs: [{ id: "L1", note: "x".repeat(5000) }, { id: "L2" }], cloudLogIds: new Set() });
  const small = A.buildClearStash({ logs: [{ id: "L2" }], cloudLogIds: new Set() });
  assert.ok(A.reserveDelete({ intents: [{ kind: "history-delete", ids: ["L1", "L2"], at: T }], stash: { at: T, value: big, fallback: small } }));
  assert.deepEqual(A.readClearStash(T)?.logs.map(l => l.id), ["L1", "L2"], "the full stash fits: stored");
  mem.clear();
  failWhen = (k, v) => k.startsWith("proximaai-clear-stash:") && v.length > 1000;
  assert.ok(A.reserveDelete({ intents: [{ kind: "history-delete", ids: ["L1", "L2"], at: T }], stash: { at: T, value: big, fallback: small } }));
  assert.deepEqual(A.readClearStash(T)?.logs.map(l => l.id), ["L2"], "the loaded-only fallback");
  assert.deepEqual(A.pendingDeleteIds("history-delete"), new Set(["L1", "L2"]));
  mem.clear();
  failWhen = (k) => k.startsWith("proximaai-clear-stash:");
  assert.equal(A.reserveDelete({ intents: [{ kind: "history-delete", ids: ["L1", "L2"], at: T }], stash: { at: T, value: big, fallback: small } }), false);
  assert.deepEqual([A.pendingDeleteIds("history-delete").size, A.readClearStash(T)], [0, null], "neither fits: nothing stored");
});
await test("#4 wiring: Clear Logs, Clear Outputs and Reset reserve WITH their stash and write no stash of their own", () => {
  const logs = between('createBackup("pre-clear-logs"', ">Clear Logs</button>");
  const outputs = between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>");
  const reset = between('createBackup("pre-reset"', ">Reset Everything</button>");
  assert.match(logs, /reserveDelete\(\{ intents: \[\{ kind: "history-delete", ids: clearedLogIds, at: snap \}\],\s*stash: \{ at: snap, value: logsStash\.full, fallback: logsStash\.loadedOnly \} \}\)/);
  assert.match(outputs, /hold: staged\.hold,\s*stash: \{ at: clearAt, value: outputsStash \} \}\)/);
  assert.match(reset, /hold: staged\.hold, stash: \{ at: resetAt, value: resetStash \} \}\)/);
  for (const [name, h] of [["Clear Logs", logs], ["Clear Outputs", outputs], ["Reset", reset]]) {
    assert.doesNotMatch(h, /writeClearStash\(/, `${name}: no unchecked stash write after the reservation`);
    const r = h.indexOf("reserveDelete("), t = h.indexOf("takeQueuedUploads(");
    assert.ok(r > 0 && t > r, `${name}: reserved before the take`);
  }
  // Reset: the favorites' reset time is taken before the reservation (the stash names it), set only after it.
  const fa = reset.indexOf("const resetFavoritesAt = Date.now();"), rv = reset.indexOf("reserveDelete("), set = reset.indexOf("favoriteModelsUpdatedAtRef.current = resetFavoritesAt;");
  assert.ok(fa > 0 && rv > fa && set > rv);
});

// ─── 2. r26 #2: only the unnamed ids whose row the server left in place are assumed ───
await test("#2: a cleared generation whose row arrives late is deleted again; one whose row the server left alone is released (with the wiring)", () => {
  const T = 1_790_000_000_000;
  // Clear Outputs named t2; t5 and t9 are unnamed History-only ids. The read after the clear finds a row only for t9.
  A.queueDeleteIntents("task-delete", ["t2", "t5", "t9"], T);
  A.confirmDeleteIntents("task-delete", ["t2"], T);
  A.markAssumedConfirms("task-delete", ["t9"], T);
  A.confirmDeleteIntents("task-delete", ["t9"], T, { assumed: true });
  A.confirmDeleteIntents("task-delete", ["t5"], T);
  // The phone then uploads t5's row (a late upload; the server never saw it); t9's row is the one the server kept.
  const st = pass(B, ["t5", "t9"]);
  assert.deepEqual([st.released, st.reappeared], [["t9"], [{ id: "t5", at: T }]]);
  assert.ok(st.deleting.has("t5") && !st.deleting.has("t9"));
  // App.jsx: a scoped read of the unnamed ids' rows right after the clear decides which are assumed; a failed read
  // assumes all.
  const h = between("const unnamedHistoryOnly = historyOnly.filter(", "const { note: purgedNote }");
  // Task B14 (review round 27 #2) rewrote this: the read is retried before the all-assumed fallback (test-b14-round27.mjs).
  assert.match(h, /if \(cr\.ok && unnamedHistoryOnly\.length\) \{[\s\S]{0,900}?withRow = await taskRowsPresentRemote\(unnamedHistoryOnly\);/);
  assert.match(h, /const assumedIds = withRow \? unnamedHistoryOnly\.filter\(id => withRow\.has\(id\)\) : unnamedHistoryOnly;/);
  assert.match(h, /markAssumedConfirms\("task-delete", assumedIds, queuedAt\); confirmIntents\("task-delete", assumedIds, queuedAt, \{ assumed: true \}\);/);
  assert.match(h, /if \(plainIds\.length\) confirmIntents\("task-delete", plainIds, queuedAt\);/);
  const fn = between("export async function taskRowsPresentRemote(ids)", "\n}\n", supa);
  assert.match(fn, /supabase\.from\("tasks"\)\.select\("id"\)\.eq\("device_id", getDeviceId\(\)\)\.in\("id", /, "scoped, through the session client");
  assert.match(fn, /if \(error \|\| !Array\.isArray\(data\)\) return null;/);
  assert.doesNotMatch(fn, /fetch\(/, "no raw fetch");
  assert.match(src, /import \{[^}]*\btaskRowsPresentRemote\b[^}]*\} from "\.\/lib\/supabase\.js";/);
});

// ─── 3. r26 #3/#5: THE KEY RULE for confirm records ───
await test("#5: a FINAL confirm a previous build made (no final mark) whose row is back is released, never deleted again", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["G"], T);
  A.confirmDeleteIntents("task-delete", ["G"], T);
  mem.delete("proximaai-final-confirms");   // the previous build writes the same records, and no mark
  const st = pass(B, ["G"]);
  assert.deepEqual([st.released, st.reappeared], [["G"], []]);
  assert.equal(B.pendingDeleteIds("task-delete").has("G"), false, "no re-delete queued");
});
await test("#3: a marked confirm whose record a previous-build tab released is deleted again when its row is back", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x"], T);
  A.confirmDeleteIntents("task-delete", ["x"], T);
  assert.equal(need(A, "finalConfirmMarks")("task-delete").get("x"), T, "marked with its queue time");
  // The old tab's pass (d0b3af6 releaseConfirmed): the record goes, the mark (a key it never reads) stays.
  const all = JSON.parse(mem.get(CONFIRMED)); delete all["task-delete"].x; mem.set(CONFIRMED, JSON.stringify(all));
  const st = pass(B, ["x"]);
  assert.deepEqual(st.reappeared, [{ id: "x", at: T }]);
  assert.ok(st.deleting.has("x"), "blocked in this pass's plans");
  // Absent from the cloud: nothing to delete again yet.
  assert.deepEqual(pass(B, []).reappeared, []);
});
await test("#3: a vanished mark with a restore known after its queue time is dropped, never deleted again (the restore may have released it)", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["x"], T);
  A.confirmDeleteIntents("task-delete", ["x"], T);
  const all = JSON.parse(mem.get(CONFIRMED)); delete all["task-delete"].x; mem.set(CONFIRMED, JSON.stringify(all));
  B.noteRestoreKnown(T + 5000);
  const st = pass(B, ["x"], { rk: B.knownRestoreAt() });
  assert.deepEqual(st.reappeared, []);
  assert.equal(B.finalConfirmMarks("task-delete").has("x"), false);
});
await test("#3/#5: a mark goes with its record (restore release, a new delete's forget); an assumed confirm has none", () => {
  const T = 1_790_000_000_000;
  A.queueDeleteIntents("task-delete", ["a", "b", "c"], T);
  A.confirmDeleteIntents("task-delete", ["a", "b"], T);
  A.confirmDeleteIntents("task-delete", ["c"], T, { assumed: true });
  assert.deepEqual([...A.finalConfirmMarks("task-delete").keys()].sort(), ["a", "b"]);
  A.forgetConfirmed("task-delete", ["a"]);
  A.noteRestoreKnown(T + 10);
  A.resolveSuperseded("task-delete", new Set(["b"]), { restoreKnownAt: A.knownRestoreAt(), complete: true });
  assert.deepEqual([...A.finalConfirmMarks("task-delete").keys()], []);
  assert.equal(mem.has("proximaai-confirmed-deletes"), true, "the confirm record layout and key are unchanged");
});

// ─── 4. r26 #6: a relink is part of its generation ───
const relinkSetup = () => {
  const X = { id: "X", taskId: null, status: "failed", error: "Cancelled", startTime: Date.now() - 600_000, outputs: [] };
  const T1 = Date.now() - 120_000;
  const st = P.planDeleteStage([], [X], [], { history: false, holdAt: T1 });
  assert.ok(A.reserveDelete({ intents: [{ kind: "task-delete", ids: ["X"], at: T1 }], holdAt: T1, hold: st.hold }));
  const entry = W.queueDeletes({}, [{ id: "X", taskId: "pred-late", status: "processing" }], Date.now())["pred-late"];
  assert.ok(A.holdLateResult(A.deleteHoldAt("X"), "X", "pred-late", entry));
  A.voidDeleteIntents("task-delete", ["X"], T1);
  // Given back and kept here: the next pass after the restore decides X alive (owner ruling 2026-10-23 rewrote this from
  // keepGivenBack's immediate cancel).
  A.releaseHeldPurges(Date.now(), { restoreKnownAt: A.knownRestoreAt(), task: { present: [], local: new Set(["X"]), complete: true }, history: { present: [], local: new Set(), complete: true } });
  return X;
};
await test("#6: a re-delete of a generation with a ready relink holds the relink's prediction with it and sends it once final", () => {
  const X = relinkSetup();
  const T2 = Date.now() - 1000;
  const st = P.planDeleteStage([], [X], [], { history: false, holdAt: T2, relinks: need(A, "relinksOf")(["X"]) });
  assert.deepEqual(Object.keys(st.hold.ws), ["pred-late"], "the plan holds the relink's prediction");
  assert.ok(A.reserveDelete({ intents: [{ kind: "task-delete", ids: ["X"], at: T2 }], holdAt: T2, hold: st.hold }));
  A.confirmDeleteIntents("task-delete", ["X"], T2);
  assert.deepEqual([wsQueued(), heldWs(), mem.get("proximaai-relinks") ?? null], [["pred-late"], [], null], "sent, the relink settled");
});
await test("#6: a relink whose generation's delete is FINAL is queued, never left to lapse (a plan that did not hold it)", () => {
  const X = relinkSetup();
  const T2 = Date.now() - 1000;
  const st = P.planDeleteStage([], [X], [], { history: false, holdAt: T2 });   // no relinks passed: the old plan
  assert.ok(A.reserveDelete({ intents: [{ kind: "task-delete", ids: ["X"], at: T2 }], holdAt: T2, hold: st.hold }));
  A.confirmDeleteIntents("task-delete", ["X"], T2);
  assert.deepEqual(wsQueued(), [], "premise: the hold did not carry it");
  A.readyRelinks(Date.now() + 8 * 864e5);   // any later applyRelinks, even after the 7-day lapse
  assert.deepEqual(wsQueued(), ["pred-late"]);
  assert.equal(A.readWsDeletes()["pred-late"].tid, "X", "with its generation id (the flush asks generations_live)");
  assert.equal(mem.get("proximaai-relinks") ?? null, null);
});
await test("#6: an archive relink's paths are held with a re-delete (kept generations' paths excluded)", () => {
  const T1 = Date.now() - 120_000, x = gen("x");
  assert.ok(A.reserveDelete({ intents: [{ kind: "task-delete", ids: ["x"], at: T1 }], holdAt: T1, hold: { files: {}, ws: {} } }));
  assert.ok(A.holdArchiveFiles(T1, "x", ["s/x-arch.png", "s/shared.png"], { archivedOutputs: ["a"] }));
  A.voidDeleteIntents("task-delete", ["x"], T1);
  // Kept here: the pass after the restore decides x alive (rewritten from keepGivenBack's cancel, owner ruling 2026-10-23).
  A.releaseHeldPurges(Date.now(), { restoreKnownAt: A.knownRestoreAt(), task: { present: [], local: new Set(["x"]), complete: true }, history: { present: [], local: new Set(), complete: true } });
  const keep = { id: "k", outputs: [`${BASE}s/shared.png`] };
  const st = P.planDeleteStage([], [x], [keep], { history: false, holdAt: Date.now(), relinks: A.relinksOf(["x"]) });
  assert.deepEqual(st.hold.files["s/x-arch.png"], ["x"]);
  assert.equal(st.hold.files["s/shared.png"], undefined, "a kept generation uses it");
});
await test("#6 wiring: plans and WaveSpeed deletes take the relinks; applyRelinks runs at every void put-back", () => {
  assert.match(between("const planStagePurge = useCallback(", "const stagePurge = useCallback("), /relinks: relinksOf\(\(removed \|\| \[\]\)\.map\(t => t\?\.id\)\)/);
  const dow = between("const deleteOnWaveSpeed = useCallback(", "}, [flushWsDeletes]);");
  assert.match(dow, /const relinks = relinksOf\(/);
  assert.match(dow, /const extra = relinkHold\(\[t\], relinks, now\);/);
  // Rewritten (owner ruling 2026-10-23: keepGivenBack removed): the three put-back sites still relink.
  assert.match(src, /applyRelinks\(\[\.\.\.heldTasks\.values\(\), \.\.\.backTasks\]\);/);
  assert.match(src, /applyRelinks\(tasksBack\);/);
  assert.match(src, /applyRelinks\(\[\.\.\.tasksBack, \.\.\.storedTasksBack\]\);/);
  assert.match(between("function applyRelinks(extra = [])", "const submittingIds = useRef("), /const pool = \[\.\.\.tasksRef\.current, \.\.\.\(extra \|\| \[\]\)\.filter\(/);
});

// ─── 5. r26 #7: a late prediction linked to a kept task reaches the cloud ───
await test("#7 wiring: both keepLateSubmitId linking paths save, queue the upload and leave savedTaskIds", () => {
  const late = between("function keepLateSubmitId(", "const submittingIds = useRef(");
  const link = between("const linkLate = (t) => {", "if (deleting && deletingIds", late);
  for (const re of [/savedTaskIds\.current\.delete\(id\);/, /saveTask\(next\);/, /addFailedSync\(\{ kind: "task", id, data: next \}\);/, /setTasks\(/])
    assert.match(link, re);
  assert.ok(link.indexOf("addFailedSync(") > link.indexOf("savedTaskIds.current.delete(id)"));
  assert.match(late, /if \(!t\.taskId\) linkLate\(t\);/, "the B12b attach branch");
  assert.match(late, /if \(cur\.taskId\) return;\s*linkLate\(cur\);/, "the cancel path");
  assert.doesNotMatch(late, /saveTask\(\{ \.\.\.cur, taskId: predictionId \}\)/);
});

// ─── 6. r26 #1: an item-less History entry's paths are decided by the entry under restore evidence ───
const clearAB = (S) => {
  const a = { id: "a", outputs: [BASE + "s/a.png"], status: "completed" }, b = { id: "b", outputs: [BASE + "s/b.png"], status: "completed" };
  const L = { id: "L", sourceImageUrl: BASE + "uploads/s/L-src.png", tasks: [] };
  const T = Date.now() - 60_000;
  const staged = P.planDeleteStage([L], [a, b], [], { all: true, serverHistory: true, at: T, holdAt: T });
  assert.ok(S.reserveDelete({ intents: [{ kind: "task-delete", ids: ["a", "b"], at: T }, ...staged.intents], holdAt: T, hold: staged.hold }));
  return { T, staged };
};
await test("#1: voided clear, the restore kept a but not b nor L: L's file goes with b's (it used to be cancelled for good)", () => {
  const { T, staged } = clearAB(A);
  assert.deepEqual(staged.hold.files["uploads/s/L-src.png"], ["entry:L"]);
  A.voidDeleteIntents("task-delete", ["a", "b"], T);
  A.noteRestoreKnown(T + 30_000);
  const ev = { restoreKnownAt: A.knownRestoreAt(), task: { present: ["a"], local: [], complete: true }, history: { present: [], local: [], complete: true } };
  A.releaseHeldPurges(Date.now(), ev);
  assert.deepEqual([filesQueued(), heldPaths()], [["s/b.png", "uploads/s/L-src.png"], []]);
});
await test("#1: the restore brought L back but none of the generations: L's file is kept", () => {
  const { T } = clearAB(A);
  A.voidDeleteIntents("task-delete", ["a", "b"], T);
  A.noteRestoreKnown(T + 30_000);
  const ev = { restoreKnownAt: A.knownRestoreAt(), task: { present: [], local: [], complete: true }, history: { present: ["L"], local: [], complete: true } };
  A.releaseHeldPurges(Date.now(), ev);
  assert.deepEqual([filesQueued(), heldPaths()], [["s/a.png", "s/b.png"], []]);
});
await test("#1: the entry is recorded with its path; without restore evidence it follows its delete: pending waits, confirmed for every owner goes", () => {
  const { T, staged } = clearAB(A);
  assert.deepEqual(staged.hold.files["uploads/s/L-src.png"], ["entry:L"], "recorded with its entry");
  A.releaseHeldPurges();
  assert.deepEqual([filesQueued(), heldPaths()], [[], ["s/a.png", "s/b.png", "uploads/s/L-src.png"]]);
  A.confirmDeleteIntents("task-delete", ["a"], T);
  assert.ok(heldPaths().includes("uploads/s/L-src.png"), "b still pending: waits");
  A.confirmDeleteIntents("task-delete", ["b"], T);
  assert.deepEqual([filesQueued(), heldPaths()], [["s/a.png", "s/b.png", "uploads/s/L-src.png"], []]);
});
await test("#1: a migrated round-24 hold with owner history:L keeps working next to a new entry:M hold (each decided by its own entry)", () => {
  const T = Date.now() - 60_000;
  mem.set("proximaai-held-purges", JSON.stringify({ [T]: { files: { "uploads/s/L-src.png": ["history:L"] }, ws: {} } }));
  A.migrateLegacyHeldPurges();
  A.queueDeleteIntents("history-delete", ["L"], T);
  A.releaseHeldPurges();
  assert.deepEqual(heldPaths(), ["uploads/s/L-src.png"]);
  A.confirmDeleteIntents("history-delete", ["L"], T);
  assert.deepEqual([filesQueued(), heldPaths()], [["uploads/s/L-src.png"], []]);
  // The same shape under restore evidence: L (history:L) and an item-less M (entry:M, its group's generation c kept) are
  // each decided by their own entry: L back -> kept, M gone -> sent.
  mem.clear();
  const c = { id: "c", outputs: [BASE + "s/c.png"], status: "completed" };
  const M = { id: "M", sourceImageUrl: BASE + "uploads/s/M-src.png", tasks: [] };
  const st = P.planDeleteStage([M], [c], [], { all: true, serverHistory: true, at: T, holdAt: T });
  mem.set("proximaai-held-purges", JSON.stringify({ [T]: { files: { "uploads/s/L-src.png": ["history:L"] }, ws: {} } }));
  A.migrateLegacyHeldPurges();
  assert.ok(A.reserveDelete({ intents: [{ kind: "task-delete", ids: ["c"], at: T }, { kind: "history-delete", ids: ["L"], at: T }], holdAt: T, hold: st.hold }));
  A.voidDeleteIntents("task-delete", ["c"], T); A.voidDeleteIntents("history-delete", ["L"], T);
  A.noteRestoreKnown(T + 30_000);
  A.releaseHeldPurges(Date.now(), { restoreKnownAt: A.knownRestoreAt(), task: { present: ["c"], local: [], complete: true }, history: { present: ["L"], local: [], complete: true } });
  assert.deepEqual([filesQueued(), heldPaths()], [["uploads/s/M-src.png"], []]);
});

// ─── 7. Simulator G: a by_restore tombstone no longer keeps a held generation's files ───
// The minimal trace: backup ; netAll ; gen A2 ; finish A2 ; bulkDel A2 ; restore B1. The restore (its backup predates A2)
// voids the bulk delete and removes A2's row (a by_restore tombstone). The next pass decides the hold from the cloud.
await test("G: the restore removed the generation (by_restore tombstone, no row, no History item): its files and WaveSpeed result are queued", () => {
  const T = Date.now() - 60_000, x = gen("A2", { sourceImageUrl: `${BASE}uploads/s/A2-src.png` });
  const st = P.planDeleteStage([], [x], [], { serverHistory: true, holdAt: T });
  assert.ok(A.reserveDelete({ intents: [{ kind: "task-delete", ids: ["A2"], at: T }, ...st.intents], holdAt: T, hold: st.hold }));
  A.voidDeleteIntents("task-delete", ["A2"], T);
  A.noteRestoreKnown(T + 5000);
  // App.jsx reconcileWithCloud's evidence as it now reads: task rows and History items only (restoreRemoved read, not present).
  const restoreRemoved = new Set(["A2"]), tasks = new Set(), cloudItemIds = [];
  const ev = { restoreKnownAt: A.knownRestoreAt(), task: { present: [...tasks, ...cloudItemIds], local: new Set(), complete: !!restoreRemoved },
    history: { present: [], local: new Set(), complete: true } };
  A.releaseHeldPurges(Date.now(), ev);
  assert.deepEqual([filesQueued(), wsQueued()], [["s/A2.png", "uploads/s/A2-src.png"], ["pred-A2"]]);
  const site = between("const evidence = { restoreKnownAt", "history: { present:");   // B18 round 3: `restoreKnownAt: guard.fresh ? -1 : …`
  assert.match(site, /task: \{ present: \[\.\.\.\(ids\.tasks \|\| \[\]\), \.\.\.\(cloudItemIds \|\| \[\]\)\], local: keptTaskIds,/);
  assert.doesNotMatch(site, /present: \[[^\]]*restoreRemoved/, "a by_restore tombstone is not present");
  // The superseded-confirm step keeps them (it decides blocking only).
  assert.match(src, /evidence: \{ present: \[\.\.\.\(cloudItemIds \|\| \[\]\), \.\.\.\(restoreRemoved \|\| \[\]\)\], complete: !!cloudItemIds && !!restoreRemoved \}/);
});

// ─── 8. Simulator A2: Reset strips the removed ids from the entries it keeps ───
await test("A2: Reset (history:false) deletes a removed generation's files although a kept entry lists it; the entry's batch input stays while it keeps another item", () => {
  const x = gen("x", { sourceImageUrl: `${BASE}uploads/s/K-in.png` }), y = gen("y", { sourceImageUrl: `${BASE}uploads/s/K-in.png` });
  const K = { id: "K", sourceImageUrl: `${BASE}uploads/s/K-in.png`, tasks: [{ id: "x", outputs: [`${BASE}s/x.png`] }, { id: "y", outputs: [`${BASE}s/y.png`] }] };
  let plan = P.planPurge([K], [x], [y], { history: false, alsoLogs: [] });
  assert.deepEqual(plan.paths.sort(), ["s/x.png"], "x's output goes; the batch input stays (y, kept, uses it)");
  // K lists only x: it owns nothing once x is removed, so x's input goes too.
  const K1 = { ...K, tasks: [{ id: "x", outputs: [`${BASE}s/x.png`] }] };
  plan = P.planPurge([K1], [x], [], { history: false, alsoLogs: [] });
  assert.deepEqual(plan.paths.sort(), ["s/x.png", "uploads/s/K-in.png"]);
  // Through planDeleteStage as Reset calls it.
  const st = P.planDeleteStage([K1], [x], [], { history: false, alsoLogs: [], holdAt: Date.now() });
  assert.deepEqual(Object.keys(st.hold.files).sort(), ["s/x.png", "uploads/s/K-in.png"]);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
