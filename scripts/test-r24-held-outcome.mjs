// Review round 24 (#1-#7): a delete's held files and WaveSpeed deletes are decided by its OUTCOME, never cancelled on an
// uncertain one; every write that moves them is checked; every WaveSpeed delete of a generation goes through the hold.
// Runs the real storage.js, purge.js, fileDelete.js and wsDelete.js; App.jsx's stagePurge (hold first), the bulk delete's
// abort, deleteOnWaveSpeed, keepLateSubmitId and the flush's first steps are mirrored as they now read, and their wiring
// is checked from the source. Written first and run against the previous build (R24_ROOT=<a copy of a79a43c>), where
// every behaviour test below fails on the defect.
// Run: node scripts/test-r24-held-outcome.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.R24_ROOT ? pathToFileURL(process.env.R24_ROOT.replace(/\/?$/, "/")).href : new URL("../", import.meta.url).href;
// A localStorage that can enforce a quota (chars of keys + values), as a full origin's does (QuotaExceededError).
const mem = new Map();
let cap = Infinity;
const failKeys = new Set();   // keys whose writes throw (a full origin refusing exactly that write)
const used = () => { let n = 0; for (const [k, v] of mem) n += k.length + v.length; return n; };
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    const s = String(v), before = mem.has(k) ? k.length + mem.get(k).length : 0;
    if (failKeys.has(k)) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; }
    if (used() - before + k.length + s.length > cap) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; }
    mem.set(k, s);
  },
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sessionOf = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
globalThis.sessionStorage = sessionOf();
const S = await import(ROOT + "src/lib/storage.js");
const P = await import(ROOT + "src/lib/purge.js");
const F = await import(ROOT + "src/lib/fileDelete.js");
const W = await import(ROOT + "src/lib/wsDelete.js");
const C = await import(ROOT + "src/lib/serverClock.js");
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
  const realNow = Date.now;
  try { mem.clear(); cap = Infinity; failKeys.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
  finally { Date.now = realNow; cap = Infinity; failKeys.clear(); }
};
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const OLD = Date.now() - 10 * 60 * 1000;
const gen = (id, extra = {}) => ({ id, taskId: `pred-${id}`, status: "completed", startTime: OLD, outputs: [`${BASE}scope/${id}-out.png`],
  sourceImageUrl: `${BASE}uploads/scope/${id}-src.png`, ...extra });
const pathsOf = (id) => [`scope/${id}-out.png`, `uploads/scope/${id}-src.png`];
const filesQueued = () => Object.keys(S.readFileDeletes()).sort();
const wsQueued = () => Object.keys(S.readWsDeletes()).sort();
const heldNow = () => JSON.parse(mem.get("proximaai-held-purges-v3") || "{}");
const heldPaths = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.files || {})))].sort();
const heldWs = () => [...new Set(Object.values(heldNow()).flatMap(g => Object.keys(g.ws || {})))].sort();
// A reconcile pass's decision step (App.jsx reconcileWithCloud): the evidence its reads give, the restore it knew before them.
const pass = (restoreKnownAt, { tasks = [], items = [], localTasks = [], logs = [], localLogs = [] } = {}) =>
  S.releaseHeldPurges(Date.now(), { restoreKnownAt, task: { present: [...tasks, ...items], local: localTasks, complete: true },
    history: { present: logs, local: localLogs, complete: true } });
// App.jsx stagePurge as it now reads: the hold FIRST; no room -> { held: false } and nothing else (no direct queueing).
function stage(removed, holdAt, { logs = [], logOwners = new Set(), historyAt = null } = {}) {
  const plan = P.planPurge(logs, removed, [], { history: false, alsoLogs: logs });
  const held = holdAt != null && S.holdPurgeDeletes(holdAt, {
    files: P.pathOwners(removed, plan.goneLogs, plan.paths, { logOwners }), ws: W.queueDeletes({}, removed, Date.now()), historyAt });
  return { ...plan, held };
}
// App.jsx deleteOnWaveSpeed as it now reads (task B12a, review round 25 #18: no direct fallback when the hold is refused;
// both writes checked; scripts/test-b12a-reserve-first.mjs covers the refusals).
function deleteOnWaveSpeed(removed, { holdAt } = {}) {
  const now = Date.now(), direct = [], unstored = [];
  for (const t of removed || []) {
    if (!t?.taskId) continue;
    const h = t?.id && S.deleteHoldAt ? S.deleteHoldAt(t.id) : undefined;
    const at = h === undefined ? holdAt : h;
    if (at != null) { if (!S.holdPurgeDeletes(at, { ws: W.queueDeletes({}, [t], now) })) unstored.push(t.taskId); continue; }
    direct.push(t);
  }
  if (direct.length && !S.writeWsDeletes(W.queueDeletes(S.readWsDeletes(), direct, now))) unstored.push(...direct.map(t => t.taskId));
  return unstored;
}
// What the WaveSpeed flush would send now (App.jsx flushWsDeletes' first steps, before its cloud questions).
function wsDueNow(tasks = []) {
  S.releaseHeldPurges();
  const t = Date.now();
  S.writeWsDeletes(W.holdHeldIds(S.readWsDeletes(), tasks.map(x => x.taskId).filter(Boolean), t));
  S.writeWsDeletes(W.holdHeldIds(S.readWsDeletes(), [...S.heldDeleteRefs().predictions], t));
  const deletingNow = new Set([...S.pendingDeleteIds("task-delete"), ...S.inFlightIds("task-delete")]);
  const q = S.readWsDeletes();
  S.writeWsDeletes(W.holdHeldIds(q, Object.keys(q).filter(p => q[p]?.tid && deletingNow.has(String(q[p].tid))), t));
  return W.dueDeletes(S.readWsDeletes(), t).flat().sort();
}

// ─── #3: another tab's call bound lapsing is not "alive": the hold waits, and the confirm + pass release it ───
await test("#3 (r24 p1-flight-lapse): A's clear answered, A frozen >60 s, B drops x@T on a restore without x: held, then queued after A's confirm and the pass", async () => {
  globalThis.sessionStorage = sessionOf(); const A = await import(ROOT + "src/lib/storage.js?tab=A");
  globalThis.sessionStorage = sessionOf(); const B = await import(ROOT + "src/lib/storage.js?tab=B");
  const T = C.serverNow() - 1000;
  A.queueDeleteIntents("task-delete", ["x"], T);
  assert.ok(A.holdPurgeDeletes(T, { files: Object.fromEntries(pathsOf("x").map(p => [p, ["x"]])),
    ws: { "pred-x": { at: Date.now(), attempts: 0, next: Date.now(), running: false, tid: "x" } }, historyAt: T }));
  const flight = A.beginDeleteFlight({ "task-delete": ["x"] }, T);
  const realNow = Date.now; Date.now = () => realNow() + 70_000;           // A frozen past its call bound
  const R = T + 5000;                                                       // a restore of a backup without x, elsewhere
  assert.deepEqual(B.restoreGuard({ last_restore_at: R }).voided.task, ["x"]);
  assert.equal(B.inFlightIds("task-delete").has("x"), false, "premise: the call bound lapsed for B");
  B.releaseHeldPurges();                                                    // B's flush
  assert.deepEqual([heldPaths(), heldWs()], [pathsOf("x").sort(), ["pred-x"]], "not cancelled: still held");
  assert.deepEqual([filesQueued(), wsQueued()], [[], []]);
  A.confirmDeleteIntents("task-delete", ["x"], T);                          // A thaws: settleCloudClear confirms x at T
  A.endDeleteFlight(flight);
  assert.ok(A.confirmStates("task-delete").superseded.has("x"));
  const rk = A.knownRestoreAt();
  A.sharedDeleteState("task", { cloudIds: new Set(), sinceSeq: A.confirmSeqNow(), restoreKnownAt: rk, evidence: { present: [], complete: true } });
  A.releaseHeldPurges();
  assert.deepEqual([filesQueued(), wsQueued()], [pathsOf("x").sort(), ["pred-x"]], "paths and prediction end up queued");
  assert.equal(mem.has("proximaai-held-purges-v3"), false);
});
await test("#3: a pass after the restore decides an owner whose call lapsed and that the cloud lacks, without its confirm (A dead)", async () => {
  const T = 1_800_000_000_000;
  S.queueDeleteIntents("task-delete", ["x"], T);
  stage([gen("x")], T);
  const fl = { dead: { tab: "tab-dead", at: T, until: Date.now() - 1, t: Date.now() - 31 * 60_000, max: 60_000, ids: { "task-delete": ["x"] } } };
  mem.set("proximaai-deletes-in-flight", JSON.stringify(fl));             // its page died; its 30 minutes are over
  S.restoreGuard({ last_restore_at: T + 5000 });
  pass(T + 5000);                                                           // the cloud after the restore lacks x
  assert.deepEqual([filesQueued(), wsQueued()], [pathsOf("x").sort(), ["pred-x"]]);
});
await test("#3: while another tab's call is within its 30 minutes, even a pass with evidence waits (its give-back may follow)", () => {
  const T = 1_800_100_000_000;
  S.queueDeleteIntents("task-delete", ["x"], T);
  stage([gen("x")], T);
  const fl = { frozen: { tab: "tab-frozen", at: T, until: Date.now() + 20 * 60_000, t: Date.now() - 10 * 60_000, max: 60_000, ids: { "task-delete": ["x"] } } };
  mem.set("proximaai-deletes-in-flight", JSON.stringify(fl));
  S.restoreGuard({ last_restore_at: T + 5000 });
  pass(T + 5000);
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], ["pred-x"]]);
});

// ─── #1: a restore that voids or drops a delete without bringing the generation back ───
await test("#1 (r24 probe1 A): bulk delete held at T, restoreGuard drops x, the cloud after R lacks x -> files and prediction queued after the pass", () => {
  const T = 1_761_200_000_000;
  S.queueDeleteIntents("task-delete", ["x"], T);
  assert.ok(stage([gen("x")], T).held);
  S.releaseHeldPurges();
  assert.deepEqual([filesQueued(), wsQueued()], [[], []], "pending: held");
  const before = S.knownRestoreAt();
  const g = S.restoreGuard({ last_restore_at: T + 60_000 });
  assert.deepEqual(g.voided.task, ["x"]);
  S.releaseHeldPurges();
  assert.deepEqual([heldPaths(), heldWs()], [pathsOf("x").sort(), ["pred-x"]], "dropped: undecided, still held (not cancelled)");
  pass(before);                                                             // the pass that saw the restore fresh: its reads may predate it
  assert.deepEqual([filesQueued(), wsQueued()], [[], []], "that pass decides nothing");
  pass(T + 60_000);                                                         // the next pass: x absent from rows, History, this browser
  assert.deepEqual([filesQueued(), wsQueued()], [pathsOf("x").sort(), ["pred-x"]], "deleted after the pass");
  assert.equal(mem.has("proximaai-held-purges-v3"), false);
});
await test("#1 (r24 probe1 B): the delete answered 'voided' inline, the restore lacked x -> queued after the pass", () => {
  const T2 = 1_761_300_000_000;
  S.queueDeleteIntents("task-delete", ["x"], T2);
  stage([gen("x")], T2);
  S.voidDeleteIntents("task-delete", ["x"], T2);
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], ["pred-x"]]);
  pass(S.knownRestoreAt(), { tasks: ["other"] });
  assert.deepEqual([filesQueued(), wsQueued()], [pathsOf("x").sort(), ["pred-x"]]);
});
await test("#1: a restore that DID bring x back (a task row, or an item of a restored History entry): kept, nothing deleted", () => {
  for (const [label, ev] of [["row", { tasks: ["x"] }], ["History item", { items: ["x"] }], ["kept here (give-back)", { localTasks: ["x"] }]]) {
    mem.clear();
    const T = 1_761_400_000_000;
    S.queueDeleteIntents("task-delete", ["x"], T);
    stage([gen("x")], T);
    S.restoreGuard({ last_restore_at: T + 60_000 });
    pass(T + 60_000, ev);
    assert.deepEqual([filesQueued(), wsQueued()], [[], []], label);
    assert.equal(mem.has("proximaai-held-purges-v3"), false, `${label}: cancelled`);
  }
});
await test("#1: a clear stash or a queued upload of x on this browser keeps it alive at the pass", () => {
  const T = 1_761_500_000_000, x = gen("x");
  S.writeClearStash(T, S.buildClearStash({ tasks: [x], cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.queueDeleteIntents("task-delete", ["x"], T);
  stage([x], T);
  S.restoreGuard({ last_restore_at: T + 60_000 });
  pass(T + 60_000);
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], []], "the stash gives it back: kept");
});

// ─── #5: a path owned by a generation and by a History entry with its own delete ───
function sharedSetup() {
  const T = 1_762_000_000_000, H = T + 500;
  const x = gen("x");
  const L = { id: "L", timestamp: OLD, sourceImageUrl: `${BASE}uploads/scope/x-src.png`, tasks: [{ status: "completed", outputs: [x.outputs[0]] }] };   // a legacy item without id
  S.queueDeleteIntents("task-delete", ["x"], T);
  S.queueDeleteIntents("history-delete", ["L"], H);
  const plan = stage([x], T, { logs: [L], logOwners: new Set(["L"]), historyAt: H });
  assert.deepEqual(P.pathOwners([x], plan.goneLogs, plan.paths, { logOwners: new Set(["L"]) })["scope/x-out.png"].sort(), ["history:L", "x"]);
  S.voidDeleteIntents("history-delete", ["L"], H);                         // L's call lands after the restore R
  S.confirmDeleteIntents("task-delete", ["x"], T);                          // x's ran before R: superseded
  return { T, H };
}
await test("#5 (r24 p3): owners [x, history:L], L voided, x confirmed then FINAL, L gone -> the shared paths are deleted", () => {
  sharedSetup();
  S.releaseHeldPurges();
  assert.deepEqual([filesQueued(), wsQueued()], [[], []], "x superseded, L undecided: all wait");
  const rk = S.knownRestoreAt();
  S.sharedDeleteState("task", { cloudIds: new Set(), sinceSeq: S.confirmSeqNow(), restoreKnownAt: rk, evidence: { present: [], complete: true } });
  assert.ok(S.confirmStates("task-delete").final.has("x"), "premise: x final");
  pass(rk);                                                                 // L absent from the cloud's History and this browser
  assert.deepEqual([filesQueued(), wsQueued()], [pathsOf("x").sort(), ["pred-x"]], "deleted once both owners are gone");
});
await test("#5: the same, but the restore kept L: the shared paths stay (a live owner uses them), x's own result goes", () => {
  sharedSetup();
  const rk = S.knownRestoreAt();
  S.sharedDeleteState("task", { cloudIds: new Set(), sinceSeq: S.confirmSeqNow(), restoreKnownAt: rk, evidence: { present: [], complete: true } });
  pass(rk, { logs: ["L"] });
  assert.deepEqual([filesQueued(), wsQueued()], [[], ["pred-x"]], "kept while L is alive");
  assert.equal(mem.has("proximaai-held-purges-v3"), false);
});
await test("#5: L alive while x is still undecided: the path is kept at once; L gone while x is superseded: it waits", () => {
  sharedSetup();
  pass(S.knownRestoreAt(), { logs: ["L"] });                                // x superseded (wait), L alive
  assert.deepEqual([heldPaths(), filesQueued()], [[], []], "cancelled: a live owner uses them");
  mem.clear();
  sharedSetup();
  pass(S.knownRestoreAt());                                                 // L gone, x still superseded
  assert.deepEqual([heldPaths(), filesQueued()], [pathsOf("x").sort(), []], "waits for x");
});

// ─── #2/#4: checked writes ───
await test("#2/#4 (r24 p2): the file queue write fails at the release -> the files stay held and the note counts them; space back -> queued", () => {
  const T = 1_763_000_000_000;
  const gens = Array.from({ length: 40 }, (_, i) => gen(`g${i}`));
  S.queueDeleteIntents("task-delete", gens.map(g => g.id), T);
  assert.ok(stage(gens, T).held);
  const paths = gens.flatMap(g => pathsOf(g.id)), preds = gens.map(g => g.taskId);
  failKeys.add("proximaai-file-deletes");                                   // no room for 80 queued paths
  S.confirmDeleteIntents("task-delete", gens.map(g => g.id), T);
  assert.ok(S.confirmStates("task-delete").final.has("g0"), "premise: confirmed");
  const fq = S.readFileDeletes(), wq = S.readWsDeletes(), left = S.heldPurgeLeft(paths, preds);
  assert.equal(Object.keys(fq).length, 0, "the file queue could not take them");
  assert.equal(Object.keys(fq).length + left.files, paths.length, "every file is queued or still held: none lost");
  assert.equal(Object.keys(wq).length + left.ws, preds.length, "every prediction is queued or still held: none lost");
  const note = F.purgeNote({ files: F.pendingOf(fq, paths) + left.files, ws: preds.filter(id => wq[id]).length + left.ws });
  assert.match(note, /80 files still being deleted/, "the toast says so");
  failKeys.clear();
  S.releaseHeldPurges();
  assert.equal(filesQueued().length, paths.length, "the next release queues them");
  assert.equal(wsQueued().length, preds.length);
  assert.equal(mem.has("proximaai-held-purges-v3"), false);
});
await test("#2/#4: the WaveSpeed queue write fails -> the predictions stay held, the files go", () => {
  const T = 1_763_100_000_000;
  const gens = Array.from({ length: 30 }, (_, i) => gen(`w${i}`, { sourceImageUrl: undefined, outputs: [] }));
  S.queueDeleteIntents("task-delete", gens.map(g => g.id), T);
  stage(gens, T);
  failKeys.add("proximaai-ws-deletes");
  S.confirmDeleteIntents("task-delete", gens.map(g => g.id), T);
  assert.ok(S.confirmStates("task-delete").final.has("w0"), "premise: confirmed");
  const r = S.releaseHeldPurges();
  assert.equal(wsQueued().length, 0);
  assert.equal(heldWs().length, 30, "held, not lost");
  assert.equal(r.kept, 30, "reported as kept");
  failKeys.clear();
  assert.equal(S.releaseHeldPurges().ws.length, 30);
});
await test("#2/#4: writeFileDeletes / writeWsDeletes report whether they stored", () => {
  assert.equal(S.writeFileDeletes({ a: { at: 1, attempts: 0, next: 1 } }), true);
  assert.equal(S.writeWsDeletes({ p: { at: 1, attempts: 0, next: 1 } }), true);
  cap = used();
  assert.equal(S.writeFileDeletes({ a: { at: 1, attempts: 0, next: 1 }, b: { at: 1, attempts: 0, next: 1 } }), false);
  assert.equal(S.writeWsDeletes({ p: { at: 1, attempts: 0, next: 1 }, q: { at: 1, attempts: 0, next: 1 } }), false);
});
// The bulk delete's steps 2-6 as App.jsx now reads them (deleteSelectedTasks). Task B12a (review round 25 #1) rewrote this
// mirror: the plan, then ONE reservation (intents + hold, storage.js reserveDelete) before anything changes, abort or the
// server call (was: intents queued, the hold, and on a refusal the intents taken back).
function bulkDelete(targets, serverCalls) {
  const ids = targets.map(t => t.id);
  const queuedAt = C.serverNow();
  const staged = P.planDeleteStage([], targets, [], { serverHistory: true, holdAt: queuedAt });
  if (!S.reserveDelete({ intents: [{ kind: "task-delete", ids, at: queuedAt }, ...staged.intents], holdAt: queuedAt, hold: staged.hold }))
    return { aborted: true, saveStatus: "error" };
  serverCalls.push(["deleteTasksRemote", ids, queuedAt]);
  return { aborted: false };
}
await test("#2/#7: a delete that cannot hold aborts with no server call; its intents were never written (an earlier pending one untouched)", () => {
  const x = gen("x"), y = gen("y");
  S.queueDeleteIntents("task-delete", ["y"], 1000);                         // an earlier delete of y, still pending
  const failedBefore = mem.get("proximaai-failed-syncs");
  cap = used() + 230;                                                       // the intents fit, the hold does not
  const calls = [];
  const r = bulkDelete([x, y], calls);
  assert.deepEqual([r.aborted, calls.length], [true, 0], "stopped before any server call");
  assert.equal(mem.get("proximaai-failed-syncs"), failedBefore, "intents as before: y still pending at its own time (task B12a: nothing to take back)");
  assert.deepEqual([filesQueued(), wsQueued(), heldWs()], [[], [], []], "nothing queued directly");
  cap = Infinity;
  const ok = bulkDelete([x], calls);
  assert.deepEqual([ok.aborted, calls.length], [false, 1], "with room it proceeds");
});
// Task B12a (review round 25 #1) rewrote this check: the hold is written with the intents in ONE reservation
// (reserveDelete), before stagePurge applies anything; the abort has nothing to take back (was: stagePurge held first,
// returned held: false, and the caller took its intents back). The order of every state change is checked in
// scripts/test-b12a-reserve-first.mjs.
await test("#2/#7 wiring: the hold is reserved with the intents before any change and never queued directly; every caller stops before its server call", () => {
  const stageSrc = between("const stagePurge = useCallback(", "const purgeEverywhere = useCallback(");
  assert.doesNotMatch(stageSrc, /holdPurgeDeletes\(|queueDeleteIntents\(/, "stagePurge only applies");
  assert.doesNotMatch(stageSrc, /writeWsDeletes\(|writeFileDeletes\(/);
  for (const [name, h, call, at] of [
    ["bulk", between("const deleteSelectedTasks = async", "const renderSelectBar"), "deleteTasksRemote(", "queuedAt"],
    ["Clear Outputs", between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>"), "clearQueuedRemote(", "clearAt"],
    ["Reset", between('createBackup("pre-reset"', ">Reset Everything</button>"), "resetQueuedRemote(", "resetAt"]]) {
    const chk = h.indexOf('if (!reserveDelete({ intents: [{ kind: "task-delete"'), st = h.indexOf("const plan = stagePurge(staged)"), srv = h.indexOf(call);
    assert.ok(chk > 0 && st > chk && srv > st, `${name}: the reservation, stagePurge, then the server call`);
    assert.match(h.slice(chk, h.indexOf(")) {", chk)), new RegExp(`holdAt: ${at}, hold: staged\\.hold`), `${name}: held for its queue time`);
    const abort = h.slice(chk, h.indexOf("return;", chk));
    assert.match(abort, /setSaveStatus\("error"\);\s*setAccountToast\(STORAGE_FULL_TOAST\);/, name);
    assert.doesNotMatch(abort, /takeBackDeleteIntents|putBack/, `${name}: nothing to take back`);
    const removal = h.indexOf("setTasks(prev => prev.filter(");
    assert.ok(removal > chk, `${name}: nothing leaves this device before the check`);
  }
  assert.match(src, /const STORAGE_FULL_TOAST = "This device's storage is full — nothing was deleted\./);
});

// ─── #6: every WaveSpeed delete of a generation goes through the hold ───
await test("#6 (r24 safety p1): x mid-submit at a Clear Outputs, clear unanswered, the late answer p is held; a restore voids the clear -> x comes back WITH p, p never sent", () => {
  const now = Date.now();
  const x = { id: "x", modelId: "m", status: "pending", startTime: now - 5000 };
  const y = gen("y");
  S.addFailedSync({ kind: "task", id: "x", data: x }); S.addFailedSync({ kind: "task", id: "y", data: y });
  const clearAt = C.serverNow() - 1000;
  S.writeClearStash(clearAt, S.buildClearStash({ uploads: S.peekQueuedUploads(["task", "history"]), tasks: [x, y], cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.takeQueuedUploads("task", ["x", "y"]);
  S.releasePredictions([y.taskId]); S.recordClaimants([x, y], { deleted: true });
  S.queueDeleteIntents("task-delete", ["x", "y"], clearAt);
  assert.ok(stage([x, y], clearAt).held);
  // keepLateSubmitId (App.jsx) as it now reads: the submit answers p while the clear is pending.
  const p = "pred-x";
  S.resolveClaimants(["x"]); S.releasePredictions([p]);
  const deleting = S.pendingDeleteIds("task-delete").has("x") || S.uploadBlockedIds("task").has("x");
  assert.ok(deleting);
  if (S.recordStashPrediction) S.recordStashPrediction("x", p);
  deleteOnWaveSpeed([{ id: "x", taskId: p, status: "processing" }], { holdAt: C.serverNow() });
  assert.equal(S.readWsDeletes()[p], undefined, "not in the shared queue");
  assert.deepEqual(heldWs(), [p, "pred-y"].sort(), "held for the clear");
  assert.deepEqual(wsDueNow(), [], "the flush sends nothing while the clear is pending");
  // The restore on the PC voids the clear at the phone's next pass; the stash gives x back.
  const R = C.serverNow() + 5;
  assert.deepEqual(S.restoreGuard({ last_restore_at: R }).voided.task.sort(), ["x", "y"]);
  const back = S.stashGiveBack(S.readClearStash(clearAt));
  const bx = back.tasks.find(t => t.id === "x");
  assert.equal(bx?.taskId, p, "x comes back WITH its result");
  assert.deepEqual(wsDueNow([bx]), [], "still nothing sent");
  pass(R, { localTasks: back.tasks.map(t => t.id) });                      // the next pass: x and y are kept here
  assert.deepEqual([heldWs(), wsQueued()], [[], []], "held, then cancelled because x is alive: p is never deleted");
});
await test("#6: deleteHoldAt: pending -> its queue time; superseded -> the record's; final -> null (direct); nothing -> undefined", () => {
  assert.equal(typeof S.deleteHoldAt, "function");
  S.queueDeleteIntents("task-delete", ["a"], 5000);
  assert.equal(S.deleteHoldAt("a"), 5000);
  S.confirmDeleteIntents("task-delete", ["a"], 5000);
  assert.equal(S.deleteHoldAt("a"), null, "final");
  S.voidDeleteIntents("task-delete", ["zz"], 6000);                        // proves a restore > 6000: a's record superseded
  S.queueDeleteIntents("task-delete", ["zz"], 7000);
  assert.equal(S.deleteHoldAt("a"), 5000, "superseded: held at its queue time");
  assert.equal(S.deleteHoldAt("nobody"), undefined);
});
await test("#6: the deleted-claimant lookup's delete is held for the claimant's pending delete; a void of it keeps the result", () => {
  const T = 1_764_000_000_000;
  S.queueDeleteIntents("task-delete", ["c"], T);
  deleteOnWaveSpeed([{ id: "c", taskId: "pred-c", status: "processing" }]);
  assert.deepEqual([wsQueued(), heldWs()], [[], ["pred-c"]]);
  S.restoreGuard({ last_restore_at: T + 10 });
  pass(T + 10, { tasks: ["c"] });                                           // the restore kept c's row
  assert.deepEqual([wsQueued(), heldWs()], [[], []]);
  // A claimant whose delete is FINAL (confirmed, no restore after it): queued directly, as before.
  S.queueDeleteIntents("task-delete", ["d"], T + 100);
  S.confirmDeleteIntents("task-delete", ["d"], T + 100);
  deleteOnWaveSpeed([{ id: "d", taskId: "pred-d", status: "processing" }]);
  assert.deepEqual(wsQueued(), ["pred-d"]);
  assert.equal(S.readWsDeletes()["pred-d"].tid, "d", "with its generation id");
});
await test("#6/#7 wiring: keepLateSubmitId, the claimant lookup and deleteOnWaveSpeed hold; flushWsDeletes holds a pending delete's own entries", () => {
  const late = between("function keepLateSubmitId(", "const submittingIds = useRef(");
  // Task B12b (review round 25 #6/#7/#12/#15): both hold with a relink (a kept generation gets its result back).
  assert.match(late, /recordStashPrediction\(id, predictionId\);\s*deleteOnWaveSpeed\(\[\{ id, taskId: predictionId, status: "processing" \}\], \{ holdAt: serverNow\(\), relink: true \}\);/);
  assert.match(between("const recoverOrphans = useCallback(", "const decided = new Map("),
    /deleteOnWaveSpeed\(delNow\.map\(id => \(\{ id: claimantOf\.get\(id\), taskId: id, status: "processing" \}\)\), \{ relink: true \}\)/);
  const dow = between("const deleteOnWaveSpeed = useCallback(", "}, [flushWsDeletes]);");
  assert.match(dow, /const h = t\?\.id \? deleteHoldAt\(t\.id\) : undefined;\s*const at = h === undefined \? holdAt : h;/);
  assert.match(dow, /const ws = queueDeletes\(\{\}, \[t\], now\);\s*const ok = relink && t\.id \? holdLateResult\(at, t\.id, t\.taskId, ws\[t\.taskId\]\) : holdPurgeDeletes\(at, \{ ws \}\);/);
  const flush = between("const flushWsDeletes = useCallback(", "const deleteOnWaveSpeed = useCallback(");
  assert.doesNotMatch(flush, /deletesGoingSince\(|going\.has\(/, "no exemption for a pending delete's own rows");
  assert.match(flush, /const deletingNow = new Set\(\[\.\.\.pendingDeleteIds\("task-delete"\), \.\.\.inFlightIds\("task-delete"\)\]\);/);
  assert.match(flush, /const held = \[\.\.\.inUse\]\.map\(\(\[prediction\]\) => prediction\);/);
  assert.match(flush, /if \(queue\[p\]\?\.tid && live\.has\(queue\[p\]\.tid\)\) held\.push\(p\);/);
});
await test("#7: an entry queued directly (a previous build, a hold that failed) for a pending delete's generation is not sent", () => {
  const T = 1_765_000_000_000;
  S.queueDeleteIntents("task-delete", ["x"], T);
  S.writeWsDeletes(W.queueDeletes({}, [gen("x")], Date.now()));
  assert.deepEqual(wsDueNow(), []);
  S.confirmDeleteIntents("task-delete", ["x"], T);
  const q = S.readWsDeletes(); q["pred-x"].next = Date.now(); S.writeWsDeletes(q);
  assert.deepEqual(wsDueNow(), ["pred-x"], "sent once its delete is confirmed");
});
await test("#1 wiring: the reconcile decides the holds with its evidence after its plans, in the same pass", () => {
  const rec = between("const reconcileWithCloud = useCallback(", "}, []);\n\n  useEffect(");
  // Task B12b (review round 25 #3/#10): rewritten for the evidence object the pass now builds: the restore's own removals
  // count as present, IndexedDB (every tab's) as kept, and the evidence is complete only when every source was read.
  const plans = rec.indexOf("const logPlan = planLogSync("), dec = rec.indexOf("releaseHeldPurges(Date.now(), evidence);");
  assert.ok(plans > 0 && dec > plans && dec < rec.indexOf("setTimeout(() => { flushWsDeletes(); flushFileDeletes(); }, 1500);"));
  // Task B13a (simulator G): rewritten: the restore's own removals are no longer present (a generation the restore removed
  // did not come back); tombstones are still required read for a complete decision.
  // Task B13b (simulator D): rewritten: each part also carries the ids the cloud says were deleted (`deleted`).
  // Task B14 (review round 27 #1): + the tombstones the pass read (rewritten anchor; tested in test-b14-round27.mjs).
  assert.match(rec, /task: \{ present: \[\.\.\.\(ids\.tasks \|\| \[\]\), \.\.\.\(cloudItemIds \|\| \[\]\)\], local: keptTaskIds, deleted: userTaskTombstones, tombstoned: \[\.\.\.tombT\],\s*complete: ids\.tasks instanceof Set && !!cloudItemIds && !!restoreRemoved && !!shared \}/);
  assert.match(rec, /history: \{ present: \[\.\.\.\(ids\.history \|\| \[\]\)\], local: keptLogIds, deleted: [^\n]*,\s*complete: ids\.history instanceof Set && !!shared \}/);
  assert.ok(rec.indexOf("const restoreKnownAt = knownRestoreAt();") < rec.indexOf("await Promise.all([pullAllRemoteData(), pullCloudIds()])"), "known before the reads");
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
