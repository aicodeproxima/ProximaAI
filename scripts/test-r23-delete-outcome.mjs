// Review round 23 (all 5 findings). Runs the real storage.js, purge.js, fileDelete.js and wsDelete.js; App.jsx's
// stagePurge, persistLog and the flushes' first step are mirrored as they now read (their wiring is checked from the
// source). Written first and run against the previous build (R23_ROOT=<a copy of it>), where every test below fails on
// the defect: stand-ins keep that build's OUTCOMES measurable where a helper did not exist yet.
// Run: node scripts/test-r23-delete-outcome.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.env.R23_ROOT ? pathToFileURL(process.env.R23_ROOT.replace(/\/?$/, "/")).href : new URL("../", import.meta.url).href;
const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
sess.set("proximaai-flight-tab", "tab-main");
const S = await import(ROOT + "src/lib/storage.js");
const P = await import(ROOT + "src/lib/purge.js");
const F = await import(ROOT + "src/lib/fileDelete.js");
const W = await import(ROOT + "src/lib/wsDelete.js");
const src = readFileSync(new URL("src/App.jsx", ROOT), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const OLD = Date.now() - 10 * 60 * 1000;
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const item = (id) => ({ id, status: "completed", outputs: [`https://ws/${id}.png`] });
const entry = (id, ids) => ({ id, timestamp: OLD, prompt: "p", tasks: ids.map(item) });
const itemsOf = (logs) => logs.map(l => ({ id: l.id, items: (l.tasks || []).map(i => i.id) }));
const gen = (id, extra = {}) => ({ id, taskId: `pred-${id}`, status: "completed", startTime: OLD, outputs: [`${BASE}scope/${id}-out.png`],
  sourceImageUrl: `${BASE}uploads/scope/${id}-src.png`, ...extra });

// Stand-ins for helpers the previous build lacked (never used on this build).
const releaseHeld = () => (S.releaseHeldPurges ? S.releaseHeldPurges() : null);
const historyUploadPlan = (entries, opts) => S.historyUploadPlan(entries, opts);
const confirmStates = (kind) => S.confirmStates(kind);
// App.jsx stagePurge's queueing, as it now reads: held for the delete's queue time `holdAt` (the previous build queued
// both straight into the shared queues).
function stage(removed, holdAt, { logs = [], logOwners = new Set(), historyAt = null } = {}) {
  const plan = P.planPurge(logs, removed, [], { history: false, alsoLogs: logs });
  const now = Date.now();
  const held = S.holdPurgeDeletes && holdAt != null && S.holdPurgeDeletes(holdAt, {
    files: P.pathOwners(removed, plan.goneLogs, plan.paths, { logOwners }), ws: W.queueDeletes({}, removed, now), historyAt });
  if (!held && !S.holdPurgeDeletes) {   // the build before a79a43c (round 24 #2: the current one never queues directly)
    S.writeWsDeletes(W.queueDeletes(S.readWsDeletes(), removed, now));
    S.writeFileDeletes(F.queueFileDeletes(S.readFileDeletes(), plan.paths, now));
  }
  return plan;
}
// What a flush (App.jsx flushWsDeletes / flushFileDeletes) would send now: it first releases the decided holds.
function dueNow() {
  releaseHeld();
  return { files: F.dueFileDeletes(S.readFileDeletes(), Date.now()).sort(), ws: W.dueDeletes(S.readWsDeletes(), Date.now()).flat().sort() };
}

// ─── #2 / #5: a void proves R >= floor(T) + 1 ───
await test("#2/#5: confirm ids at T, void others at T -> the confirmed ids are superseded and their History deferred before any restoreGuard", () => {
  const T = 1_700_000_000_000;
  S.queueDeleteIntents("task-delete", ["a0", "b0"], T);
  S.confirmDeleteIntents("task-delete", ["a0"], T);              // chunk 1: "deleted" (the server ran it before R)
  S.voidDeleteIntents("task-delete", ["b0"], T);                 // chunk 2: "voided" (R landed in between)
  assert.equal(S.knownRestoreAt(), T + 1, "the bound the void proves");
  assert.ok(confirmStates("task-delete").superseded.has("a0"), "a0 superseded at once");
  assert.equal(confirmStates("task-delete").final.has("a0"), false);
  const plan = historyUploadPlan([entry("L", ["a0", "z"])]);
  assert.deepEqual([plan.upload, plan.defer], [[], ["L"]], "L is held back, not sent stripped");
  assert.equal(S.giveBackRule(T)("task", "a0"), "keep");
});
await test("#2/#5: a fractional queue time is floored first (the server compares floor(q))", () => {
  S.queueDeleteIntents("task-delete", ["c"], 5000.7);
  S.voidDeleteIntents("task-delete", ["c"], 5000.7);
  assert.equal(S.knownRestoreAt(), 5001);
});

// ─── #4: immediate senders never strip FINAL items on their own ───
// persistLog as App.jsx now reads (the previous build sent withoutBlockedItems([entry])[0]: x stripped).
function persistLog(e) {
  const isNew = src.includes("historyUploadPlan([entry], { strip: false })");
  const held = isNew ? historyUploadPlan([e], { strip: false }).defer.length > 0 : historyUploadPlan([e]).defer.length > 0;
  const send = isNew ? e : (held ? e : S.withoutBlockedItems([e])[0]);
  if (!send) return { queued: null, sent: [] };
  S.addFailedSync({ kind: "history", id: send.id, data: send });
  const sent = held ? [] : S.uploadable("history", S.withoutBlockedItems([send], isNew ? { strip: false } : undefined));
  if (sent.length) S.removeFailedSync("history", send.id);
  return { queued: send, sent };
}
await test("#4: final x, an unseen restore R > T, persistLog(L=[x,z]): nothing without x is sent before restoreGuard(R); after the pass L keeps x", () => {
  const T = S.queueDeleteIntents("task-delete", ["x"], Date.now() - 60_000);
  S.confirmDeleteIntents("task-delete", ["x"], T);               // tab A's delete: final here
  const R = T + 1000;                                             // the PC's restore brought L = [x, z] back; unread here (B queues after it)
  assert.ok(confirmStates("task-delete").final.has("x"), "premise: x final");
  const L = entry("L", ["x", "z"]);
  assert.deepEqual(S.withoutBlockedItems([L], { strip: false }), [], "an immediate sender sends nothing");
  const r = persistLog(L);
  assert.deepEqual(r.sent, [], "nothing sent");
  assert.deepEqual(itemsOf([r.queued]), [{ id: "L", items: ["x", "z"] }], "queued as given");
  // B's pass: the restore read first, then the cloud decides x (L holds it again)
  const restoreKnownAt = S.knownRestoreAt();
  S.restoreGuard({ last_restore_at: R });
  S.sharedDeleteState("task", { cloudIds: new Set(["x", "z"]), sinceSeq: S.confirmSeqNow(), restoreKnownAt: R,
    evidence: { present: ["x", "z"], complete: true } });
  assert.ok(restoreKnownAt < R);
  assert.equal(S.confirmedDeletes("task-delete").has("x"), false, "released: the restore brought x back");
  const queued = S.getFailedSyncs().filter(e => e.kind === "history").map(e => e.data);
  assert.deepEqual(itemsOf(historyUploadPlan(queued).upload), [{ id: "L", items: ["x", "z"] }], "the replay sends L with x");
});
await test("#4: the reconcile and the replays still strip a final item (strip on by default)", () => {
  const T = S.queueDeleteIntents("task-delete", ["x"]);
  S.confirmDeleteIntents("task-delete", ["x"], T);
  assert.deepEqual(itemsOf(historyUploadPlan([entry("L", ["x", "z"])]).upload), [{ id: "L", items: ["z"] }]);
});
await test("#4 wiring: persistLog queues as given and sends through sendHistoryEntry with strip off", () => {
  const pl = between("const persistLog = useCallback(", "}, [trackedSync]);");
  assert.match(pl, /const held = historyUploadPlan\(\[entry\], \{ strip: false \}\)\.defer\.length > 0;\s*const send = entry;/);
  assert.match(pl, /if \(held\) return Promise\.resolve\(\);[\s\S]*sendHistoryEntry\(send, \{ strip: false \}\)/);
  assert.match(between("async function sendHistoryEntry(", "\n}\n"), /withoutBlockedItems\(\[entry\], opts\)/);
});

// ─── #1: the shared in-flight record ───
await test("#1: each entry carries the tab's sessionStorage id; a reload of that tab removes its own leftovers at load", async () => {
  sess.set("proximaai-flight-tab", "tab-P");
  const A = await import(ROOT + "src/lib/storage.js?page=1");
  const call = A.beginDeleteFlight({ "task-delete": ["x"] }, 1000);
  const f = JSON.parse(mem.get("proximaai-deletes-in-flight"))[call];
  assert.equal(f.tab, "tab-P", "the writing tab's id");
  assert.ok(Number(f.until) > Date.now() && f.at === 1000 && Array.isArray(f.ids["task-delete"]), "the layout a previous build reads");
  assert.ok(A.inFlightIds("task-delete").has("x"));
  await sleep(5);
  const B = await import(ROOT + "src/lib/storage.js?page=2");          // the same tab reloaded: same sessionStorage
  assert.equal(B.inFlightIds("task-delete").has("x"), false, "its call died with the page: gone at load");
  sess.set("proximaai-flight-tab", "tab-main");
});
await test("#1: another tab's entry lapses after the longest call (not 30 min); this tab's own stays until its finally", () => {
  const now = Date.now(), max = S.FLIGHT_CALL_MS ?? 60_000;
  assert.ok(max <= 2 * 60 * 1000, "a call's bound, not 30 min");
  const flights = {
    fresh: { tab: "tab-A", at: 1, until: now + 30 * 60_000, t: now - 1000, max, ids: { "task-delete": ["a"] } },
    dead: { tab: "tab-A", at: 1, until: now + 30 * 60_000, t: now - max - 1, max, ids: { "task-delete": ["d"] } },
    oldFresh: { tab: "tab-old", at: 1, until: now + 30 * 60_000 - 1000, ids: { "task-delete": ["o"] } },          // previous build
    oldDead: { tab: "tab-old", at: 1, until: now + 30 * 60_000 - max - 1000, ids: { "task-delete": ["k"] } },
    bigCall: { tab: "tab-A", at: 1, until: now + 30 * 60_000, t: now - max - 1, max: 3 * max, ids: { "task-delete": ["b"] } },
  };
  mem.set("proximaai-deletes-in-flight", JSON.stringify(flights));
  assert.deepEqual([...S.inFlightIds("task-delete")].sort(), ["a", "b", "o"]);
  const own = S.beginDeleteFlight({ "task-delete": ["m"] }, 2);
  const m = JSON.parse(mem.get("proximaai-deletes-in-flight"));
  m[own].t = now - 10 * 60_000;                                         // this tab's own call, still running
  mem.set("proximaai-deletes-in-flight", JSON.stringify(m));
  assert.ok(S.inFlightIds("task-delete").has("m"), "own entry stays while its call runs");
  S.endDeleteFlight(own);
  assert.equal(S.inFlightIds("task-delete").has("m"), false);
});
await test("#1: a bulk call's bound grows with its requests (chunks of 100)", () => {
  const call = S.beginDeleteFlight({ "task-delete": Array.from({ length: 250 }, (_, i) => `t${i}`) }, 3);
  const f = JSON.parse(mem.get("proximaai-deletes-in-flight"))[call];
  assert.equal(f.max, 3 * (S.FLIGHT_CALL_MS ?? NaN));
});
await test("#1: load-time presence: an answer means this page is a duplicate (new id, nothing removed); no answer removes the leftovers", async () => {
  assert.equal(typeof S.flightPresence, "function");
  const hub = new Set();
  const open = () => { const ch = { onmessage: null, postMessage: (d) => { for (const o of hub) if (o !== ch) o.onmessage?.({ data: d }); } }; hub.add(ch); return ch; };
  let taken = 0, free = 0;
  S.flightPresence({ id: "orig", open, waitMs: 5, onFree: () => {} });   // the original page, settled
  await sleep(15);
  S.flightPresence({ id: "orig", open, waitMs: 5, onTaken: () => taken++, onFree: () => free++ });
  await sleep(15);
  assert.deepEqual([taken, free], [1, 0], "the original answered: a duplicate");
  S.flightPresence({ id: "gone", open, waitMs: 5, onTaken: () => taken++, onFree: () => free++ });
  await sleep(15);
  assert.deepEqual([taken, free], [1, 1], "nobody holds it: its leftovers go");
  const call = S.beginDeleteFlight({ "task-delete": ["q"] }, 4);
  S.dropFlightsOfTab("tab-main", 0);                                     // only entries begun before the page loaded go
  assert.ok(S.inFlightIds("task-delete").has("q"));
  S.endDeleteFlight(call);
});

// ─── #3: a delete's file and WaveSpeed deletes follow its outcome ───
await test("#3 (p2): a local-only x in an unanswered clear: nothing is sent; a restore voids the clear -> its files and prediction are never queued", () => {
  const T = Date.now() + 5000;
  const x = gen("x");
  S.writeClearStash(T, S.buildClearStash({ tasks: [x], cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.queueDeleteIntents("task-delete", ["x"], T);
  stage([x], T);
  for (let i = 0; i < 3; i++) assert.deepEqual(dueNow(), { files: [], ws: [] }, "no answer: held (reconcile / interval flushes)");
  const g = S.restoreGuard({ last_restore_at: T + 10 });                // the owner restores the safety backup on the PC
  assert.deepEqual(g.voided.task, ["x"]);
  assert.deepEqual(dueNow(), { files: [], ws: [] }, "the void sends nothing");
  const back = S.stashGiveBack(S.readClearStash(T));
  assert.deepEqual(back.tasks.map(t => t.id), ["x"], "x comes back");
  // Review round 24 #1: the void leaves x undecided (still held); the next pass, which read the cloud after the restore,
  // finds x kept here (the give-back) and cancels its held deletes.
  S.releaseHeldPurges(Date.now(), { restoreKnownAt: S.knownRestoreAt(), task: { present: [], local: ["x"], complete: true }, history: { present: [], local: [], complete: true } });
  assert.equal(mem.has("proximaai-held-purges"), false, "nothing left held");
  assert.deepEqual([F.dueFileDeletes(S.readFileDeletes(), Date.now() + 1e9), W.dueDeletes(S.readWsDeletes(), Date.now() + 1e9)], [[], []], "with its files and result");
});
await test("#3: confirmed -> released into both queues, due now (the previous layout)", () => {
  const T = 10_000, x = gen("x");
  S.queueDeleteIntents("task-delete", ["x"], T);
  stage([x], T);
  assert.deepEqual(dueNow(), { files: [], ws: [] });
  S.confirmDeleteIntents("task-delete", ["x"], T);
  assert.deepEqual(F.dueFileDeletes(S.readFileDeletes(), Date.now()).sort(), ["scope/x-out.png", "uploads/scope/x-src.png"]);
  assert.deepEqual(W.dueDeletes(S.readWsDeletes(), Date.now()).flat(), ["pred-x"]);
  const e = S.readWsDeletes()["pred-x"];
  assert.deepEqual([e.tid, e.attempts, e.running, typeof e.next], ["x", 0, false, "number"]);
  assert.equal(mem.has("proximaai-held-purges"), false);
});
await test("#3: one group, x confirmed and y voided: a shared file stays, y's files stay, x's go once its superseded confirm is decided", () => {
  const T = 20_000;
  const shared = `${BASE}uploads/scope/shared.png`;
  const x = gen("x", { sourceImageUrl: shared }), y = gen("y", { sourceImageUrl: shared });
  S.queueDeleteIntents("task-delete", ["x", "y"], T);
  stage([x, y], T);
  S.voidDeleteIntents("task-delete", ["y"], T);                          // one call of the group voided (R landed)
  S.confirmDeleteIntents("task-delete", ["x"], T);                       // another call of it answers "deleted": superseded (#2)
  assert.deepEqual(dueNow(), { files: [], ws: [] }, "y's files and the shared one cancelled; x's wait for the pass");
  S.resolveSuperseded("task-delete", new Set(), { restoreKnownAt: S.knownRestoreAt(), complete: true });   // the cloud lacks x
  assert.deepEqual(dueNow(), { files: ["scope/x-out.png"], ws: ["pred-x"] }, "only x's own");
});
await test("#3: a confirm answered before its group's void is final then: its own files go; the shared one waits for the voided owner, then stays", () => {
  const T = 25_000, shared = `${BASE}uploads/scope/shared.png`;
  const x = gen("x", { sourceImageUrl: shared }), y = gen("y", { sourceImageUrl: shared });
  S.queueDeleteIntents("task-delete", ["x", "y"], T);
  stage([x, y], T);
  S.confirmDeleteIntents("task-delete", ["x"], T);
  assert.deepEqual(dueNow(), { files: ["scope/x-out.png"], ws: ["pred-x"] }, "y still pending: the shared file waits");
  S.voidDeleteIntents("task-delete", ["y"], T);
  assert.deepEqual(dueNow(), { files: ["scope/x-out.png"], ws: ["pred-x"] }, "y voided: its files and the shared one wait");
  // Review round 24 #1/#5: y is undecided until a pass after the restore: the cloud holds y (the restore kept it).
  S.releaseHeldPurges(Date.now(), { restoreKnownAt: S.knownRestoreAt(), task: { present: ["y"], local: [], complete: true }, history: { present: [], local: [], complete: true } });
  assert.deepEqual(dueNow(), { files: ["scope/x-out.png"], ws: ["pred-x"] }, "y alive: its files and the shared one stay");
  assert.equal(mem.has("proximaai-held-purges"), false);
});
await test("#3 (p1): another tab's call in flight for x keeps the held items; its 'deleted' at T1 releases its own group only", () => {
  const T1 = 30_000, T2 = 40_000, x = gen("x");
  S.queueDeleteIntents("task-delete", ["x"], T1);
  stage([x], T1);                                                        // tab A's bulk delete
  const fa = S.beginDeleteFlight({ "task-delete": ["x"] }, T1);
  const fl = JSON.parse(mem.get("proximaai-deletes-in-flight")); fl[fa].tab = "tab-A"; mem.set("proximaai-deletes-in-flight", JSON.stringify(fl));
  S.queueDeleteIntents("task-delete", ["x"], T2);                        // tab B's stale Clear Outputs
  stage([x], T2);
  S.voidDeleteIntents("task-delete", ["x"], T2);                         // a restore voids B's clear
  assert.deepEqual(dueNow(), { files: [], ws: [] }, "A's call may still delete x: held");
  S.confirmDeleteIntents("task-delete", ["x"], T1);                      // A thaws: deleted at T1 (superseded by R)
  S.endDeleteFlight(fa);
  assert.deepEqual(dueNow(), { files: [], ws: [] }, "superseded: the pass decides");
  S.resolveSuperseded("task-delete", new Set(), { restoreKnownAt: S.knownRestoreAt(), complete: true });
  assert.deepEqual(dueNow(), { files: ["scope/x-out.png", "uploads/scope/x-src.png"], ws: ["pred-x"] }, "x's delete stands: its files go");
});
await test("#3: the restore brought x back (pass releases it): its files and result stay", () => {
  const T = 50_000, x = gen("x");
  S.queueDeleteIntents("task-delete", ["x", "w"], T);
  stage([x], T);
  S.voidDeleteIntents("task-delete", ["w"], T);
  S.confirmDeleteIntents("task-delete", ["x"], T);
  // Review round 24 #1: the pass that releases the record (the cloud holds x again) decides the held items in the same
  // step: x is alive, so they are cancelled.
  const rk = S.knownRestoreAt();
  S.sharedDeleteState("task", { cloudIds: new Set(["x"]), sinceSeq: S.confirmSeqNow(), restoreKnownAt: rk, evidence: { present: [], complete: true } });
  S.releaseHeldPurges(Date.now(), { restoreKnownAt: rk, task: { present: ["x"], local: [], complete: true }, history: { present: [], local: [], complete: true } });
  assert.deepEqual(dueNow(), { files: [], ws: [] });
  assert.equal(mem.has("proximaai-held-purges"), false);
});
await test("#3: History-owned paths follow the entry's own History delete (its queue time)", () => {
  const T = 60_000, H = 60_500;
  const L = { id: "L", sourceImageUrl: `${BASE}uploads/scope/L.png`, tasks: [{ status: "completed", outputs: [] }] };   // an item without id
  S.queueDeleteIntents("history-delete", ["L"], H);
  stage([], T, { logs: [L], logOwners: new Set(["L"]), historyAt: H });
  assert.deepEqual(dueNow().files, []);
  S.confirmDeleteIntents("history-delete", ["L"], H);
  assert.deepEqual(dueNow().files, ["uploads/scope/L.png"]);
});
await test("#3 guard: a clear stash's content and held items count as kept for both flushes", () => {
  assert.equal(typeof S.heldDeleteRefs, "function");
  const x = gen("x");
  S.writeClearStash(70_000, S.buildClearStash({ tasks: [x], cloudTaskIds: new Set(), cloudLogIds: new Set() }));
  S.queueDeleteIntents("task-delete", ["y"], 80_000);
  stage([gen("y")], 80_000);
  const r = S.heldDeleteRefs();
  assert.deepEqual([...r.paths].sort(), ["scope/x-out.png", "scope/y-out.png", "uploads/scope/x-src.png", "uploads/scope/y-src.png"]);
  assert.deepEqual([...r.predictions].sort(), ["pred-x", "pred-y"]);
});
await test("#3 wiring: stagePurge holds for its delete's queue time; every caller passes it after its intents; flushes release first", () => {
  const stageSrc = between("const stagePurge = useCallback(", "const purgeEverywhere = useCallback(");
  assert.match(stageSrc, /const held = holdAt != null && holdPurgeDeletes\(holdAt, \{ files: pathOwners\(removed, plan\.goneLogs, plan\.paths, \{ logOwners \}\),/);
  // Review round 24 #2/#4/#7: no direct fallback: a hold that cannot be stored stops the delete (the callers check).
  assert.match(stageSrc, /if \(!held\) return \{ \.\.\.plan, held: false,/);
  assert.equal((stageSrc.match(/writeWsDeletes\(|writeFileDeletes\(/g) || []).length, 0, "nothing queues directly");
  const calls = src.split("\n").filter(l => /= stagePurge\(/.test(l));
  assert.equal(calls.length, 3);
  for (const c of calls) assert.match(c, /holdAt: (queuedAt|clearAt|resetAt)/, c);
  const bulk = between("const deleteSelectedTasks = async", "deleteTasksRemote(");
  assert.ok(bulk.indexOf('queueDeleteIntents("task-delete", ids)') < bulk.indexOf("stagePurge("), "bulk: intents first");
  const outputs = between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>");
  assert.ok(outputs.indexOf('queueDeleteIntents("task-delete", clearedTaskIds, clearAt)') < outputs.indexOf("const plan = stagePurge("), "Clear Outputs: intents first");
  const reset = between('createBackup("pre-reset"', ">Reset Everything</button>");
  assert.ok(reset.indexOf('queueDeleteIntents("task-delete", clearedTaskIds, resetAt)') < reset.indexOf("const plan = stagePurge("), "Reset: intents first");
  for (const [h, gone] of [[outputs, "outputsGone"], [reset, "resetGone"]])
    assert.match(h, new RegExp(`const note = ${gone} \\? await finishPurge\\(plan\\) : purgedNote;`));
  for (const fn of ["flushWsDeletes", "flushFileDeletes"]) {
    const body = between(`const ${fn} = useCallback(`, "}, []);");
    assert.ok(body.indexOf("releaseHeldPurges();") > 0 && body.indexOf("heldDeleteRefs()") > body.indexOf("releaseHeldPurges();"), fn);
  }
  assert.match(between("const purgeLeftNote = (plan) =>", "};"), /heldPurgeLeft\(plan\.paths, plan\.predictionIds\)/);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
