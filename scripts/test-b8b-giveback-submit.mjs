// Task B8b (review round 21 #3 and #4). Runs the real storage.js; the App.jsx parts (the tab's deleting set and holds,
// pruneDeleting, keepLateSubmitId's decision) are mirrored as they now read, and their wiring is checked from the source.
// #3 (r21 p3-inline-vs-stash): inlineVoidPutBack and stashGiveBack answered differently for an id confirmed between a
//   Clear Outputs snapshot and its stash write (the stash gave it back). Both now ask ONE rule (storage.js giveBackRule).
// #4 (r21 late-submit): pruneDeleting released a task cleared while its submit was in flight, so keepLateSubmitId no
//   longer deleted its late prediction on WaveSpeed. The submit now holds its id until it settles.
// Run: node scripts/test-b8b-giveback-submit.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null };
const C = await import("../src/lib/serverClock.js");
const S = await import("../src/lib/storage.js");

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
  try { mem.clear(); fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const ids = (list) => (list || []).map(x => x.id).sort();
const task = (id) => ({ id, status: "completed", startTime: 1, outputs: [`https://ws/${id}.png`] });

// ─── #3: one give-back rule ───
test("#3 (r21 probe): an id confirmed between the clear's snapshot and its stash write is left out by BOTH paths", () => {
  const X = task("x"), Y = task("y");
  const clearAt = C.serverNow() - 1000;                               // snap - SNAPSHOT_SLACK_MS
  // Tab B: its delete of local-only x is queued and confirmed while tab A's Clear Outputs reads the cloud.
  const qB = S.queueDeleteIntents("task-delete", ["x"]);
  S.confirmDeleteIntents("task-delete", ["x"], qB);
  assert.ok(S.confirmedDeletes("task-delete").get("x") > clearAt, "confirmed after the clear's queue time");
  // Tab A goes on: its stash (x still in its stale state, not in the cloud read), an archive x finished meanwhile, its
  // intents at clearAt, then the clear is voided by a restore.
  S.writeClearStash(clearAt, { ...S.buildClearStash({ tasks: [X, Y], cloudTaskIds: new Set() }), archives: { x: { task: null, paths: ["archive/x.png"] } } });
  S.queueDeleteIntents("task-delete", ["x", "y"], clearAt);
  S.voidDeleteIntents("task-delete", ["x", "y"], clearAt);
  const inline = S.inlineVoidPutBack(clearAt, { tasks: [X, Y] });
  const give = S.stashGiveBack(S.readClearStash(clearAt));
  assert.deepEqual(ids(inline.tasks), ["y"], "inline: x left out");
  assert.deepEqual(ids(give.tasks), ["y"], "stash: x left out too (was given back)");
  assert.deepEqual(Object.keys(give.archives), [], "x's archive record is not re-applied");
  assert.deepEqual(give.goneArchivePaths, ["archive/x.png"], "its files go to the file-delete queue");
  S.dropGivenBackStash(S.readClearStash(clearAt));
  assert.equal(S.readClearStash(clearAt), null, "nothing of x is kept in the stash");
});
test("#3: the rule's three answers agree between inlineVoidPutBack and stashGiveBack for the same ids", () => {
  const now = C.serverNow(), at = now - 4000, later = now - 1000;
  const all = ["back", "keep", "gone", "old"].map(task);
  S.confirmDeleteIntents("task-delete", ["old"]);                      // confirmed (now) ...
  mem.set("proximaai-confirmed-deletes", JSON.stringify({ "task-delete": { old: at - 10_000, gone: now } }));   // ... before the clear: back
  S.writeClearStash(at, S.buildClearStash({ tasks: all, uploads: all.map(t => ({ kind: "task", id: t.id, data: t, ts: at - 1 })), cloudTaskIds: new Set() }));
  S.queueDeleteIntents("task-delete", ["back", "keep", "gone", "old"], at);
  S.queueDeleteIntents("task-delete", ["keep"], later);                // keep: pending at another time
  S.voidDeleteIntents("task-delete", ["back", "gone", "old"], at);
  const rule = S.giveBackRule(at);
  assert.deepEqual(["back", "keep", "gone", "old"].map(id => rule("task", id)), ["back", "keep", "gone", "back"]);
  const give = S.stashGiveBack(S.readClearStash(at));
  const inline = S.inlineVoidPutBack(at, { tasks: all, uploads: all.map(t => ({ kind: "task", id: t.id, data: t, ts: at - 1 })) });
  assert.deepEqual(ids(give.tasks), ["back", "old"]);
  assert.deepEqual(ids(inline.tasks), ids(give.tasks), "same tasks");
  assert.deepEqual(ids(give.uploads), ["back", "old"], "the rule gives back the same ids' uploads");
  // The inline path also passes them through the shared upload filter (uploadable: any confirmed record blocks an upload
  // until a pass releases it); the stash path's put-back meets the same filter at the replay.
  assert.deepEqual(ids(inline.uploads), ids(S.uploadable("task", give.uploads)), "same uploads after the shared upload filter");
  // The kept part (keep) stays in the stash for its later time; gone leaves.
  S.dropGivenBackStash(S.readClearStash(at));
  const s = S.readClearStash(at);
  assert.deepEqual([ids(s.tasks), ids(s.uploads), s.movedTo], [["keep"], ["keep"], [later]]);
});
// Task B8c (round 21 #3 follow-up): a LATE confirm of an older group T1, handled after the same id was re-queued at a later
// time T2 (a restore brought it back and it was cleared again), is skipped for that id entirely: no confirm record, no
// sequence, no stash strip, no queued-upload drop. Only T2's own answer decides it. (Replaces the stash `spared` field.)
// One scenario: x deleted at T1, a restore brings it back, x's new version is queued for upload, Clear Outputs at T2 takes
// it (stash + held upload) and queues x again, and only then is T1's "deleted" answer handled.
const lateT1 = () => {
  const now = C.serverNow(), T1 = now - 5000, T2 = now - 3000;
  const X = task("x"), up = { kind: "task", id: "x", data: X, ts: T1 + 1000, attempts: 1 };
  S.queueDeleteIntents("task-delete", ["x"], T1);
  S.putBackQueuedUploads([up]);                                       // the restored x, queued after T1
  S.writeClearStash(T2, S.buildClearStash({ tasks: [X], uploads: S.peekQueuedUploads(["task"]), cloudTaskIds: new Set() }));
  const taken = S.takeQueuedUploads("task", ["x"]);
  S.queueDeleteIntents("task-delete", ["x"], T2);                      // cleared again at T2
  S.confirmDeleteIntents("task-delete", ["x"], T1);                    // T1's answer handled only now
  return { T1, T2, X, taken };
};
test("B8c: a late T1 confirm of an id pending again at T2 leaves no record, no sequence, and touches neither stash nor queue", () => {
  const { T2 } = lateT1();
  assert.equal(S.confirmedDeletes("task-delete").has("x"), false, "no confirm record");
  assert.equal(S.confirmSeqs("task-delete").has("x"), false, "no confirm sequence");
  assert.deepEqual(S.intentGroups("task-delete"), [[T2, ["x"]]], "T2's intent still pending");
  const s = S.readClearStash(T2);
  // x is held through its taken upload (buildClearStash leaves out a local item whose upload it holds).
  assert.deepEqual([ids(s.tasks), ids(s.uploads)], [[], ["x"]], "T2's stash keeps x's taken upload");
  assert.equal(Object.prototype.hasOwnProperty.call(s, "spared"), false, "no spared field");
});
test("B8c (a): the inline voided path gives back x's taken upload after a late T1 confirm (uploadable no longer drops it)", () => {
  const { T2, X, taken } = lateT1();
  S.voidDeleteIntents("task-delete", ["x"], T2);
  assert.equal(S.giveBackRule(T2)("task", "x"), "back");
  const back = S.inlineVoidPutBack(T2, { tasks: [X], uploads: taken });
  assert.deepEqual(ids(back.tasks), ["x"], "inline gives x back");
  assert.deepEqual(ids(back.uploads), ["x"], "and its taken upload");
  assert.deepEqual(ids(S.uploadable("task", [X])), ["x"], "x may upload again");
});
test("B8c (b): the stash path agrees for the same scenario, through the shared upload filter", () => {
  const { T2 } = lateT1();
  S.voidDeleteIntents("task-delete", ["x"], T2);
  const give = S.stashGiveBack(S.readClearStash(T2));
  assert.deepEqual(ids(give.tasks), ["x"], "the stash gives x back");
  assert.deepEqual(ids(S.uploadable("task", give.uploads)), ["x"], "and its upload passes the shared filter");
  S.dropGivenBackStash(S.readClearStash(T2));
  assert.equal(S.readClearStash(T2), null, "nothing left behind");
});
test("B8c: T2's own confirm then records x and cleans its stash and its queued upload", () => {
  const { T2 } = lateT1();
  S.putBackQueuedUploads([{ kind: "task", id: "x", data: task("x"), ts: T2 - 500, attempts: 1 }]);
  S.confirmDeleteIntents("task-delete", ["x"], T2);
  assert.ok(S.confirmedDeletes("task-delete").get("x") > T2, "recorded by T2's confirm");
  assert.ok(S.confirmSeqs("task-delete").get("x") > 0);
  assert.deepEqual(S.intentGroups("task-delete"), []);
  assert.equal(S.readClearStash(T2).tasks.some(t => t.id === "x"), false, "stripped from T2's stash");
  assert.deepEqual(S.getFailedSyncs().filter(e => e.kind === "task"), [], "its queued upload dropped");
});
test("B8c: History ids follow the same rule; ids of the group not pending later are confirmed exactly as before", () => {
  const T1 = 1000, T2 = 3000;
  S.writeClearStash(T2, { uploads: [], tasks: [{ id: "k" }], logs: [{ id: "L" }] });
  S.queueDeleteIntents("history-delete", ["L", "M"], T1);
  S.writeClearStash(T1, { uploads: [], tasks: [], logs: [{ id: "M" }] });
  S.queueDeleteIntents("history-delete", ["L"], T2);
  S.confirmDeleteIntents("history-delete", ["L", "M"], T1);
  const rec = S.confirmedDeletes("history-delete");
  assert.deepEqual([rec.has("L"), rec.has("M")], [false, true], "only M (not pending later) is recorded");
  assert.deepEqual(S.readClearStash(T1).logs, [], "M leaves T1's stash");
  assert.deepEqual(ids(S.readClearStash(T2).logs), ["L"], "L stays in T2's stash");
  S.queueDeleteIntents("task-delete", ["k"], 9000);
  S.voidDeleteIntents("history-delete", ["L"], T2);
  assert.deepEqual(ids(S.stashGiveBack(S.readClearStash(T2)).logs), ["L"], "T2's void gives L back");
  S.dropGivenBackStash(S.readClearStash(T2));
  const s = S.readClearStash(T2);
  assert.deepEqual([ids(s.tasks), ids(s.logs), s.movedTo], [["k"], [], [9000]], "the part pending elsewhere is kept");
});
test("B8c: the spared mechanism is gone from storage.js", () => {
  assert.doesNotMatch(st, /spared|cleanSpared/i);
});
test("#3 wiring: every give-back path asks giveBackRule; App.jsx deletes the files of a gone archive record", () => {
  const sec = (from, to) => st.slice(st.indexOf(from), st.indexOf(to, st.indexOf(from) + from.length));
  assert.match(sec("export function stashGiveBack(", "export function giveBackRule("), /const decide = giveBackRule\(stash\.at\);/);
  assert.match(sec("export function inlineVoidPutBack(", "export function stashFollowers("), /const decide = giveBackRule\(ts\);/);
  assert.match(sec("export function dropGivenBackStash(", "export function inlineVoidPutBack("), /const decide = giveBackRule\(stash\.at\);/);
  // Task B8c: the late-confirm skip lives in confirmDeleteIntents, before the record, the stash strip and the upload drop.
  const c = sec("export function confirmDeleteIntents(", "export function forgetConfirmed(");
  const skip = c.indexOf("if (later.size) ids = (ids || []).filter(id => !later.has(id));");
  assert.ok(skip > 0 && skip < c.indexOf("readConfirmed()") && skip < c.indexOf("forgetStashedIds(") && skip < c.indexOf("dropQueuedUploadsOf("), "skip first");
  assert.match(c, /\(e\.ts \|\| 0\) > bound\) later\.add\(e\.id\)/);
  assert.equal(st.match(/confirmedDeletes\("task-delete"\)/g)?.length >= 1, true);
  const apply = between("const applyClearStashes = (which, held = {}) => {", "const settleClearStashes = () =>");
  assert.ok(apply.indexOf("queueArchivedFileDeletes(back.goneArchivePaths);") > apply.indexOf("reapplyArchives(back.archives"));
});

// ─── #4: a mid-submit task stays "being deleted" until its submit settles ───
// One tab, as App.jsx keeps it: deletingIds and deleteHoldsRef["task-delete"], pruneDeleting, keepLateSubmitId's test.
const tabOf = () => ({ deleting: new Set(), holds: new Map() });
const hold = (t, ids, h) => { for (const id of ids) { if (!t.holds.has(id)) t.holds.set(id, new Set()); t.holds.get(id).add(h); } };
const unhold = (t, ids, h) => { for (const id of ids) { const s = t.holds.get(id); if (!s) continue; s.delete(h); if (!s.size) t.holds.delete(id); } };
const prune = (t) => { for (const id of S.settledDeletingIds(t.deleting, "task-delete", t.holds)) { t.deleting.delete(id); t.holds.delete(id); } };
const lateDecision = (t, id, { belt = true } = {}) => t.deleting.has(id) || S.pendingDeleteIds("task-delete").has(id) || (belt && S.uploadBlockedIds("task").has(id));
const clearMidSubmit = (t, { submitHold }) => {
  if (submitHold) hold(t, ["g"], submitHold);                         // handleGenerate: before the submit fires
  const clearAt = C.serverNow();
  t.deleting.add("g");                                                // Clear Outputs removes the in-flight task
  S.recordClaimants([{ id: "g", modelId: "m", startTime: Date.now() - 1000, status: "processing" }], { deleted: true });
  S.queueDeleteIntents("task-delete", ["g"], clearAt);
  S.confirmDeleteIntents("task-delete", ["g"], clearAt);             // settleCloudClear: the cloud lacks g
  prune(t);                                                           // the next reconcile / Save
  S.resolveClaimants(["g"]);                                          // the submit answers: keepLateSubmitId
};
test("#4 (r21 probe): without the submit hold the id is released (the gap); deletingIds alone said 'not deleting'", () => {
  const t = tabOf();
  clearMidSubmit(t, { submitHold: null });
  assert.equal(t.deleting.has("g"), false, "pruneDeleting released it");
  assert.equal(lateDecision(t, "g", { belt: false }), false, "the old test: no WaveSpeed delete");
  assert.equal(lateDecision(t, "g"), true, "the belt (the shared confirmed record) still says deleting");
});
test("#4: with the submit hold the id stays in deletingIds through pruneDeleting until the submit settles", () => {
  const t = tabOf(), submitHold = {};
  clearMidSubmit(t, { submitHold });
  assert.equal(t.deleting.has("g"), true, "held: pruneDeleting skips it");
  assert.equal(S.storedClaimants().length, 0, "the claimant record is gone (orphan recovery cannot reach it)");
  assert.equal(lateDecision(t, "g", { belt: false }), true, "keepLateSubmitId deletes the prediction on WaveSpeed");
  unhold(t, ["g"], submitHold);                                       // the submit's finally
  prune(t);
  assert.equal(t.deleting.has("g"), false, "released once the submit settled");
  assert.equal(t.holds.size, 0);
});
test("#4: a submit hold on a task nobody deletes changes nothing and leaves no hold behind", () => {
  const t = tabOf(), h = {};
  hold(t, ["g"], h);
  prune(t);
  assert.equal(t.deleting.has("g"), false);
  unhold(t, ["g"], h);
  assert.equal(t.holds.size, 0);
});
test("#4 wiring: both submit paths hold their task id before the submit and release it in finally, after keepLateSubmitId", () => {
  for (const [name, id] of [["Generate", "task.id"], ["regenerateTask", "newTask.id"]]) {
    const i = src.indexOf(`holdDeleting("task-delete", [${id}], submitHold);`);
    assert.ok(i >= 0, `${name}: hold`);
    const body = src.slice(i, src.indexOf("})();", i));
    const sub = body.indexOf("await submitTask("), late = body.indexOf(`keepLateSubmitId(${id}, taskId)`), fin = body.indexOf("} finally {");
    assert.ok(sub > 0 && late > sub && fin > late, `${name}: submit, then the late decision, then finally`);
    assert.match(body.slice(fin), new RegExp(`^\\} finally \\{\\s*unholdDeleting\\("task-delete", \\[${id.replace(".", "\\.")}\\], submitHold\\);`));
  }
  assert.match(between("function keepLateSubmitId(", "const submittingIds = useRef("), /\|\| uploadBlockedIds\("task"\)\.has\(id\);/);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
