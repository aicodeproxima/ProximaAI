// Structural checks of the delete wiring in src/App.jsx that its unit-tested helpers cannot see (review round 9). The
// handlers need React, IndexedDB and the network, so these read the source: each check names the defect it guards.
// Run: node scripts/test-delete-wiring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

const stage = () => between("const stagePurge = useCallback(", "const purgeEverywhere = useCallback(");
const outputs = () => between('createBackup("pre-clear-outputs"', ">Clear Outputs</button>");
const reset = () => between('createBackup("pre-reset"', ">Reset Everything</button>");
const purge = () => between("const purgeEverywhere = useCallback(", "}, [flushWsDeletes");

test("stagePurge removes every History entry it drops locally from IndexedDB, not only the ones it sends", () => {
  assert.match(stage(), /deleteHistoryEntries\(plan\.remove\)/);
  assert.doesNotMatch(purge(), /deleteHistoryEntries\(/, "the sent subset is no longer the IndexedDB delete");
});
test("stagePurge trims the queued upload of a rewrite it leaves to the server", () => {
  assert.match(stage(), /replaceQueuedUpload\("history", l\.id, l\)/);
});
test("a delete's History rewrites are queued with its queue time and sent restore-checked", () => {
  assert.match(stage(), /queuedAt: historyQueuedAt/);
  assert.match(purge(), /sendHistoryRewrites\(/);
  assert.match(between("const sendHistoryRewrites = useCallback(", "}, []);"), /upsertQueuedHistory\(entries, queuedAt\)/);
  assert.doesNotMatch(purge(), /persistLog\(/, "no plain upsert of a delete's rewrite");
});
test("queued History uploads replay through one helper (restore-checked rewrites, deleting items left out)", () => {
  const helper = between("const replayHistoryUploads = async", "\n  };");
  assert.match(helper, /upsertQueuedHistory\(/);
  assert.match(helper, /withoutDeleting\(/);
  assert.equal(src.match(/await replayHistoryUploads\(/g)?.length, 2, "forceSaveAll and the mount replay");
  assert.doesNotMatch(src, /syncHistoryEntry\(f\.data\)|historyRetries/, "the old direct replays are gone");
});
test("the reconcile pass never uploads a History item this device is deleting", () => {
  assert.match(between("const logUploads =", "setFailedSyncCount"), /withoutDeleting\(/);
});
test("every voided delete puts its claimant records back (bulk delete, Clear Outputs, Reset)", () => {
  assert.equal(src.match(/putBackClaimants\(/g)?.length, 3);
  assert.equal(src.match(/claimantRecords\(/g)?.length, 3);
  assert.doesNotMatch(src, /resolveClaimants\(voided\)/);
});
// Review round 10 (F6): Reset's four restore-checked calls could be half-voided; it is one reset_queued_rows call now.
test("Reset clears History, generations, settings and favorites in ONE restore-checked call at its snapshot time", () => {
  const h = reset();
  assert.match(h, /await resetQueuedRemote\(resetAt, clearedTaskIds, clearedLogIds, snap\)/);
  assert.doesNotMatch(src, /clearQueuedRemote\([^)]*resetAt/, "no separate clears at the reset's time");
  assert.doesNotMatch(src, /clearSettingsRemote|clearFavoritesRemote|deleteTaskRemote\b/);
  assert.match(h, /queueDeleteIntents\("task-delete", clearedTaskIds, resetAt\)/);
  assert.match(h, /queueDeleteIntents\("history-delete", clearedLogIds, resetAt\)/);
});
test("clears name the ids their device knew (Clear Outputs: rows plus this device's History-only ones)", () => {
  assert.match(outputs(), /clearQueuedRemote\("task", queuedAt, namedIds\)/);
  assert.match(src, /clearQueuedRemote\("history", snap, clearedLogIds\)/, "Clear Logs");
  assert.match(outputs(), /settleCloudClear\(\{ tasks: namedIds \}\)/);
  assert.match(outputs(), /const namedIds = \[\.\.\.rowIds, \.\.\.namedHistoryOnly\]/);
  assert.match(outputs(), /namedHistoryOnly = historyOnly\.filter\(g => localLogIds\.has\(g\.batchId\)\)/);
});
// Review round 10 (F5): a bound taken after the purge read deleted rows uploaded during the read without purging them.
// Review round 11 (R6): the snapshot is the server's own time (server_time_ms), less the slack second.
test("Clear Outputs and Reset take their snapshot from the SERVER's time BEFORE their purge read, and skip History created after it", () => {
  for (const [name, h, v] of [["Clear Outputs", outputs(), "clearAt"], ["Reset", reset(), "resetAt"]]) {
    const snap = h.indexOf("const snap = isSupabaseConfigured() ? await serverTimeRemote() : Date.now()");
    const bound = h.indexOf(`const ${v} = snap - SNAPSHOT_SLACK_MS`), read = h.indexOf("await pullAllForPurge()");
    assert.ok(snap >= 0 && bound > snap && read > bound, `${name}: server snapshot before the read`);
    assert.match(h.slice(snap, bound), /if \(snap == null\)[\s\S]*return;/, `${name}: no server time -> nothing done`);
    assert.match(h, new RegExp(`createdAt[^;]*> ${v}`), `${name}: later History skipped`);
  }
  assert.doesNotMatch(src, /CLOCK_MARGIN_MS/);
  assert.match(src, /serverTimeRemote/);
  assert.match(src, /SNAPSHOT_SLACK_MS/);
  assert.match(outputs(), /stagePurge\([^;]*at: clearAt/);
  assert.match(outputs(), /queueDeleteIntents\("task-delete", clearedTaskIds, clearAt\)/);
  assert.match(stage(), /queueDeleteIntents\("history-delete", send\.remove, at\)/);
});
// Review round 11 (R5/R7): the late filter dropped THIS device's own entries from the plan, so they stayed here and
// their History-only items survived. Only cloud entries can be late; the cloud list alone is filtered.
test("Clear Outputs: only cloud-only entries created after the snapshot are late; its own entries stay in the plan", () => {
  const h = outputs();
  const local = h.indexOf("const localLogIds = new Set(localLogs.map(l => l.id))"), snap = h.indexOf("const snap = ");
  assert.ok(local >= 0 && snap > local, "this device's entries are taken right before the snapshot");
  assert.match(h, /const late = new Set\(remote\.history\.filter\(l => !localLogIds\.has\(l\.id\) && Date\.parse\(l\.createdAt\) > clearAt\)/);
  assert.match(h, /mergeLogs\(localLogs, remote\.history\.filter\(l => !late\.has\(l\.id\)\)\)/);
  assert.doesNotMatch(h, /mergeLogs\([^;]*\)\.filter\(l => !late/, "the merged list (local entries included) is not filtered");
  assert.match(h, /settleDeleteIntents\("task-delete", historyOnly\.filter\(g => !localLogIds\.has\(g\.batchId\)\)/);
});
// Review round 12 (F1): Clear Outputs and Reset planned over tasksRef / logsRef read AFTER the snapshot, so an entry or
// task another device synced in during the awaits (created after the snapshot) was planned, named or given an intent.
test("Clear Outputs and Reset plan over this device's state captured BEFORE the snapshot, plus cloud rows existing by it", () => {
  for (const [name, h, v] of [["Clear Outputs", outputs(), "clearAt"], ["Reset", reset(), "resetAt"]]) {
    const snap = h.indexOf("await serverTimeRemote()");
    const lt = h.indexOf("const localTasks = tasksRef.current.slice()"), ll = h.indexOf("const localLogs = logsRef.current.slice()");
    assert.ok(lt >= 0 && ll >= 0 && lt < snap && ll < snap, `${name}: local state captured before the snapshot`);
    // Reset's copy also holds every task stored here beyond the loaded ones (round 14); the loaded version wins.
    assert.match(h, name === "Reset" ? /new Map\(\[\.\.\.storedTasks, \.\.\.localTasks\]\.map\(t => \[t\.id, t\]\)\)/ : /new Map\(localTasks\.map\(t => \[t\.id, t\]\)\)/,
      `${name}: tasks planned from the capture`);
    assert.match(h, new RegExp(`remote\\.tasks[\\s\\S]{0,160}Date\\.parse\\(t\\.createdAt\\) > ${v}`), `${name}: later rows skipped`);
  }
  const h = outputs();
  assert.match(h, /mergeLogs\(localLogs, /);
  const snap = h.indexOf("await serverTimeRemote()"), staged = h.indexOf("stagePurge(");
  assert.ok(staged > snap);
  // Round 13 (A3): a live read after the snapshot only supplies the CURRENT version of an id already planned (or what a
  // voided clear puts back); it never decides what is planned.
  for (const line of h.slice(snap, staged).split("\n").filter(x => /tasksRef\.current|logsRef\.current/.test(x)))
    assert.match(line, /const (currentTasks|logsBefore) = /, `Clear Outputs: no live read plans anything: ${line.trim()}`);
  assert.match(h, /historyOnlyGenerations\(mergedLogs, new Set\(\[\.\.\.all\.keys\(\), \.\.\.remote\.tasks\.map\(t => t\.id\)\]\)\)/,
    "a generation with any row in the read is not History-only");
  assert.doesNotMatch(h, /clearTasksDB\(/, "Clear Outputs removes only the planned ids here");
  assert.match(h, /deleteTasks\(/);
  assert.match(reset(), /new Map\(\[\.\.\.storedLogs, \.\.\.localLogs\]\.map\(l => \[l\.id, l\]\)\)/);
});
// Review round 12 (F5): Clear Logs stamped its clear with the device's estimate of the server time.
test("Clear Logs takes the server's time before anything changes and clears / queues at it", () => {
  const h = between('createBackup("pre-clear-logs"', ">Clear Logs</button>");
  const snap = h.indexOf("const snap = isSupabaseConfigured() ? await serverTimeRemote() : Date.now()"), take = h.indexOf("takeQueuedUploads(");
  assert.ok(snap >= 0 && take > snap, "snapshot before the queue is touched");
  assert.match(h.slice(snap, take), /if \(snap == null\)[\s\S]*return;/, "no server time -> nothing done");
  assert.match(h, /queueDeleteIntents\("history-delete", clearedLogIds, snap\)/);
  assert.match(h, /clearQueuedRemote\("history", snap, clearedLogIds\)/);
});
// Review round 13 (A1, A4): queued ids were read with dropQueuedUploads AFTER the awaits, so an upload queued after the
// snapshot (a generation started meanwhile) was dropped and named without being planned; Clear Logs read logsRef after
// its snapshot. Each clear now copies its state and peeks the queue BEFORE the snapshot and takes only those ids.
test("the three clears copy their state and peek the queue BEFORE the snapshot, then take only those ids from the queue", () => {
  const logs = between('createBackup("pre-clear-logs"', ">Clear Logs</button>");
  for (const [name, h, peek] of [["Clear Logs", logs, 'peekQueuedUploads(["history"])'], ["Clear Outputs", outputs(), 'peekQueuedUploads(["task"])'],
    ["Reset", reset(), 'peekQueuedUploads(["task", "history"])']]) {
    const snap = h.indexOf("await serverTimeRemote()"), p = h.indexOf(peek);
    assert.ok(snap >= 0 && p >= 0 && p < snap, `${name}: queue peeked before the snapshot`);
    assert.doesNotMatch(h, /dropQueuedUploads\(/, `${name}: no wholesale drop of the queue`);
    assert.match(h, /takeQueuedUploads\("(task|history)", /, `${name}: only the planned ids leave the queue`);
  }
  assert.doesNotMatch(src, /dropQueuedUploads/, "nothing drops the whole queue any more");
  const s = logs.indexOf("await serverTimeRemote()");
  const copied = logs.indexOf("const removedLogIds = [...new Set([...logsRef.current.map(l => l.id), ...storedLogs.map(l => l.id)])]");
  assert.ok(copied >= 0 && copied < s, "Clear Logs copies its History ids (loaded and stored) before the snapshot");
  assert.doesNotMatch(logs.slice(s), /removedLogIds = |queuedLogIds/, "nothing read after the snapshot is named");
  assert.match(logs, /takeQueuedUploads\("history", clearedLogIds\)/);
  assert.doesNotMatch(logs, /savedLogIds\.current\.clear\(\)/, "an entry that arrived after the copy stays saved here");
});
// Review round 13 (A2, A3): a row created after the bound for a generation this device already held was skipped (it
// survived while the toast said cleared); planning used the pre-snapshot copies, missing a WaveSpeed id or archive path
// that arrived during the awaits.
test("Clear Outputs / Reset plan rows created by the bound OR held here, each purged from its CURRENT version", () => {
  for (const [name, h, v] of [["Clear Outputs", outputs(), "clearAt"], ["Reset", reset(), "resetAt"]]) {
    assert.match(h, new RegExp(`Date\\.parse\\(t\\.createdAt\\) > ${v}\\) \\|\\| heldIds\\.has\\(t\\.id\\)`), `${name}: held rows planned`);
    assert.match(h, /const heldIds = new Set\(/, `${name}: heldIds`);
    const snap = h.indexOf("await serverTimeRemote()"), cur = h.indexOf("const currentTasks = new Map(tasksRef.current.map(t => [t.id, t]))");
    assert.ok(cur > snap, `${name}: the current version is read after the awaits`);
    assert.match(h, /currentTasks\.get\(id\) \|\| remoteTasks\.get\(id\) \|\| /, `${name}: current, else the row, else the queued data, else the copy`);
  }
  assert.match(outputs(), /takeQueuedUploads\("task", clearedTaskIds\)/);
  assert.doesNotMatch(outputs(), /queuedTaskIds/, "the queue is no longer a separate source of named ids");
  assert.match(outputs(), /const rowIds = realTasks\.map\(t => t\.id\)/);
  assert.match(reset(), /takeQueuedUploads\("task", /);
  assert.match(reset(), /takeQueuedUploads\("history", /);
});
// Review round 13 (A5): a voided Clear Outputs / Reset had already removed local-only generations, History and queued
// uploads and never put them back.
test("a voided clear puts back this device's tasks, History entries and the queue entries it took", () => {
  for (const [name, h, key] of [["Clear Outputs", outputs(), "if (cr.voided) {"], ["Reset", reset(), "if (rr.voided) {"],
    ["Clear Logs", between('createBackup("pre-clear-logs"', ">Clear Logs</button>"), "if (cr.voided) {"]]) {
    const i = h.indexOf(key), v = h.slice(i, h.indexOf("return;", i));
    assert.ok(i >= 0, `${name}: voided branch`);
    assert.match(v, /putBackQueuedUploads\(/, `${name}: queue entries put back`);
    assert.match(v, /setLogs\(/, `${name}: History put back`);
    assert.match(v, /addHistoryEntry\(/, `${name}: History saved here again`);
    if (name !== "Clear Logs") {
      assert.match(v, /setTasks\(/, `${name}: tasks put back`);
      assert.match(v, /saveTasks\(/, `${name}: tasks saved here again`);
    }
  }
});
// Review round 10 (F2): a confirmed delete kept in deletingIds stripped a generation a later restore brought back.
test("History uploads leave out only generations whose delete is still in flight", () => {
  assert.equal(src.match(/withoutDeleting\([^;]*pendingDeleteIds\("task-delete"\)\)/g)?.length, 2);
  assert.doesNotMatch(src, /withoutDeleting\([^;]*deletingIds\.current/);
});

// ─── Review round 14 ───
const logsH = () => between('createBackup("pre-clear-logs"', ">Clear Logs</button>");
const voidedOf = (h, key) => { const i = h.indexOf(key); assert.ok(i >= 0, `voided branch: ${key}`); return h.slice(i, h.indexOf("return;", i)); };
// Reset wiped this device entirely (a generation another device synced in after the snapshot, or one started here
// meanwhile, was lost here) and cleared IndexedDB beyond the planned ids.
test("Reset removes locally ONLY its planned ids, and plans over every task and History entry stored here", () => {
  const h = reset();
  assert.doesNotMatch(h, /setTasks\(\[\]\)|setLogs\(\[\]\)/, "no wholesale state wipe");
  assert.doesNotMatch(h, /clearTasksDB\(|clearHistory\(/, "no wholesale IndexedDB wipe");
  assert.doesNotMatch(h, /savedTaskIds\.current\.clear\(\)|savedLogIds\.current\.clear\(\)/);
  assert.match(h, /setTasks\(prev => prev\.filter\(t => !plannedTaskIds\.has\(t\.id\)\)\)/);
  assert.match(h, /setLogs\(prev => prev\.filter\(l => !plannedLogIds\.has\(l\.id\)\)\)/);
  assert.match(h, /await deleteTasks\(clearedTaskIds\)/);
  assert.match(h, /await deleteHistoryEntries\(clearedLogIds\)/);
  const snap = h.indexOf("await serverTimeRemote()");
  const st = h.indexOf("await allStoredTasks()"), sl = h.indexOf("await allStoredHistory()");
  assert.ok(st >= 0 && sl >= 0 && st < snap && sl < snap, "the stored copies are read before the snapshot");
  assert.doesNotMatch(src, /clearTasksDB|clearHistory\b/, "nothing wipes the local stores wholesale any more");
  assert.doesNotMatch(h, /comes back on the next pass|wiped entirely/, "comments no longer claim a post-snapshot generation is wiped");
});
test("Clear Logs plans over every stored entry and deletes only the planned ids from IndexedDB", () => {
  const h = logsH();
  const snap = h.indexOf("await serverTimeRemote()"), stored = h.indexOf("await allStoredHistory()");
  assert.ok(stored >= 0 && stored < snap, "stored entries read before the snapshot");
  assert.doesNotMatch(h, /clearHistory\(/);
  assert.match(h, /await deleteHistoryEntries\(clearedLogIds\)/);
  assert.doesNotMatch(h, /for \(const l of logsRef\.current\) if \(!clearedLogSet\.has\(l\.id\)\) addHistoryEntry\(l\)/, "no write-back after a wipe");
});
// A late submit whose task was merely missing from a stale tasksRef deleted a paid result on WaveSpeed.
test("keepLateSubmitId deletes the prediction only when the task is being deleted (deletingIds or a queued intent)", () => {
  const h = between("function keepLateSubmitId(", "const submittingIds = useRef(");
  assert.match(h, /const deleting = deletingIds\.current\.has\(id\) \|\| pendingDeleteIds\("task-delete"\)\.has\(id\)/);
  assert.match(h, /if \(!cur\) \{ if \(deleting\) deleteOnWaveSpeed\(/);
  assert.equal(h.match(/deleteOnWaveSpeed\(/g)?.length, 1);
});
// An archive that finished after its task was deleted saved and synced it again (the generation came back).
test("onCloudArchiveTask: a task deleted meanwhile queues its uploaded files for deletion and is not saved", () => {
  const h = between("const onCloudArchiveTask = useCallback(", "const onCopyUrlTask = useCallback(");
  const guard = h.indexOf("if (deletingIds.current.has(task.id) || !tasksRef.current.some(t => t.id === task.id))");
  assert.ok(guard >= 0 && guard > h.indexOf("await archiveUrl(") && guard < h.indexOf("saveTask(updated)"), "checked after the uploads, before any save");
  const g = h.slice(guard, h.indexOf("return;", guard));
  assert.match(g, /writeFileDeletes\(queueFileDeletes\(readFileDeletes\(\), paths, /);
  assert.doesNotMatch(g, /saveTask|addFailedSync|syncTask/);
});
test("voided branches: Reset restores the favorites it reset; Clear Outputs puts back only current History versions", () => {
  const h = reset();
  const fav = h.indexOf("const favoritesBefore = "), resetFav = h.indexOf("favoriteModelsRef.current = emptyFavorites");
  assert.ok(fav >= 0 && fav < resetFav, "favorites state snapshot before the local reset");
  assert.match(h, /favoritesBefore\.setting = await getSetting\(localModelFavoritesKey\(favoriteScope\)\)/);
  assert.match(h, /queued: getFailedSyncs\(\)\.filter\(e => e\.kind === "model-favorites"/);
  const v = voidedOf(h, "if (rr.voided) {");
  assert.match(v, /favoriteModelsRef\.current = favoritesBefore\.byType/);
  assert.match(v, /favoriteModelsUpdatedAtRef\.current = favoritesBefore\.updatedAt/);
  assert.match(v, /setFavoriteModelsByType\(favoritesBefore\.byType\)/);
  assert.match(v, /setSetting\(localModelFavoritesKey\(favoriteScope\), [^;]*favoritesBefore\.updatedAt\)/);
  assert.match(v, /putBackQueuedUploads\(favoritesBefore\.queued\)/);
  const o = outputs();
  const lb = o.indexOf("const logsBefore = new Map(logsRef.current.map(l => [l.id, l]))"), sp = o.indexOf("const plan = stagePurge(");
  assert.ok(lb >= 0 && sp > lb, "logsBefore read from logsRef before stagePurge");
  assert.doesNotMatch(o.slice(lb, sp), /await /, "no await between that read and stagePurge");
  assert.doesNotMatch(o, /new Map\(\[\.\.\.localLogs, \.\.\.logsRef\.current\]/, "never the pre-snapshot copy");
  const ov = voidedOf(o, "if (cr.voided) {");
  assert.match(ov, /putBackQueuedUploads\(logUploadsBefore\.filter\(e => backIds\.has\(e\.id\)\)\)/);
});
// A clear whose call got no answer, voided later at a replay, had lost the uploads it took and its local-only items.
test("each clear stores its stash BEFORE its take and drops it once answered", () => {
  for (const [name, h, at, take] of [["Clear Logs", logsH(), "snap", 'takeQueuedUploads("history"'], ["Clear Outputs", outputs(), "clearAt", 'takeQueuedUploads("task"'],
    ["Reset", reset(), "resetAt", 'takeQueuedUploads("task"']]) {
    // Reset spreads the built stash to add its favorites (round 15 S3): `writeClearStash(resetAt, { ...buildClearStash(`.
    // Clear Logs writes the stash clearLogsStash built (round 16 #6): `writeClearStash(snap, logsStash.full)`.
    const w = h.search(new RegExp(`writeClearStash\\(${at}, ((\\{ \\.\\.\\.)?buildClearStash\\(|logsStash\\.full\\))`)), t = h.indexOf(take);
    assert.ok(w >= 0 && t > w, `${name}: stash written before the take`);
    assert.doesNotMatch(h.slice(w, t), /await /, `${name}: nothing awaited between the stash and the take`);
    // Round 17: dropped once confirmed; a void gives it back (applyClearStashes) instead of dropping it.
    assert.match(h, new RegExp(`if \\((cr|rr)\\.ok\\) dropClearStash\\(${at}\\)`), `${name}: dropped once confirmed`);
    assert.doesNotMatch(h, /\.voided\) dropClearStash\(/, `${name}: never dropped on a void`);
  }
});
test("restoreGuard voids and replay voids give the stashes back; confirmed clears drop them", () => {
  // Round 15 S3: the bootstrap keeps the call's answer (`const stashBack = guard.restoreAt > 0 ? applyClearStashes(...) : null`).
  assert.equal(src.match(/applyClearStashes\(at => at < guard\.restoreAt\)/g)?.length, 3, "forceSaveAll, bootstrap, reconcile pass");
  assert.equal(src.match(/guard\.restoreAt > 0 \? applyClearStashes\(at => at < guard\.restoreAt\)|if \(guard\.restoreAt > 0\) applyClearStashes\(at => at < guard\.restoreAt\)/g)?.length, 3, "each only after a restore");
  for (const site of ["const guard = restoreGuard(await pullSettings());", "const guard = restoreGuard(remote.settings);\n        restoreKnown"]) {
    const i = src.indexOf(site);
    assert.ok(i >= 0, `guard site: ${site}`);
    assert.match(src.slice(i, i + 600), /applyClearStashes\(at => at < guard\.restoreAt\)/, `stash given back right after: ${site}`);
  }
  const replay = between("const replayDeleteIntents = async", "const replayHistoryUploads = async");
  assert.match(replay, /r\.voided\.length[\s\S]*applyClearStashes\(voidedClearStashes\(ts\)\)/, "round 17 #6: its own stash and its followers");
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  assert.match(apply, /const back = stashGiveBack\(s\);\s*\n\s*if \(!back\) continue;/, "round 15 S1: nothing while an intent of the clear is pending");
  assert.match(apply, /putBackQueuedUploads\(back\.uploads\)/);
  assert.match(apply, /saveTasks\(/); assert.match(apply, /addHistoryEntry\(/);
  assert.match(apply, /!haveTasks\.has\(t\.id\)/, "a version held now is not overwritten");
  // Task B5: the given-back stash goes, except the part still pending at a time its ids moved to (dropGivenBackStash).
  assert.match(apply, /dropGivenBackStash\(s\);/);
  assert.doesNotMatch(apply, /dropClearStash\(/);
  assert.match(between("const settleCloudClear = async", "return clean;"), /settleClearStashes\(\)/);
  assert.equal(src.match(/await replayDeleteIntents\("history-delete"\); settleClearStashes\(\);/g)?.length, 2, "after both replays");
});

// Review round 15 S1: the task group's void gave the stash back (and dropped it) while the same clear's History group
// still held its entries back, so local-only History was lost; S2: confirmed ids came back with a later void.
test("round 15 S1/S2: a stash is given back only when its clear has no pending intent; confirmed ids leave it first", () => {
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  assert.doesNotMatch(apply, /pendingDeleteIds\(/, "the per-id filter excludes only OTHER queue times (stashGiveBack)");
  assert.doesNotMatch(apply, /stashedItems\(/);
  const replay = between("const replayDeleteIntents = async", "const replayHistoryUploads = async");
  const c = replay.indexOf("confirmIntents(kind, r.deleted)"), a = replay.indexOf("if (r.voided.length) applyClearStashes(voidedClearStashes(ts));");
  assert.ok(c >= 0 && a > c, "the group's confirmed ids are settled before its stash is considered");
  assert.equal(src.match(/confirmDeleteIntents\(/g)?.length, 1, "only confirmIntents calls it (it queues held archives' files)");
  assert.match(between("function confirmIntents(kind, ids)", "// ─── LOGIN SCREEN ───"), /queueArchivedFileDeletes\(confirmDeleteIntents\(kind, ids\)\)/);
  assert.ok((src.match(/confirmIntents\(/g)?.length || 0) >= 9, "every confirm site");
});
test("round 15 S3: a Reset voided later puts its favorites back, only while they are still the ones it wrote", () => {
  const h = reset();
  const w = h.indexOf("writeClearStash(resetAt, { ...buildClearStash("), fav = h.indexOf("resetAt: resetFavoritesAt", w);
  assert.ok(w >= 0 && fav > w && fav < h.indexOf('takeQueuedUploads("task"'), "favorites in the stash");
  assert.match(h.slice(w, fav), /favorites: \{ scope: favoriteScope, byType: favoritesBefore\.byType, updatedAt: favoritesBefore\.updatedAt,/);
  const r = between("const restoreStashedFavorites = (fav) =>", "// A clear voided LATER");
  assert.match(r, /favoriteModelsUpdatedAtRef\.current !== fav\.resetAt\) return null/, "a newer choice wins");
  for (const re of [/favoriteModelsRef\.current = byType/, /favoriteModelsUpdatedAtRef\.current = fav\.updatedAt/, /setFavoriteModelsByType\(byType\)/,
    /setSetting\(localModelFavoritesKey\(fav\.scope \|\| getDeviceId\(\)\), setting\)/, /putBackQueuedUploads\(fav\.queued \|\| \[\]\)/]) assert.match(r, re);
  assert.match(between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = "), /restoreStashedFavorites\(back\.favorites\)/);
  const b = src.indexOf("const stashBack = guard.restoreAt > 0 ? applyClearStashes(at => at < guard.restoreAt) : null;");
  const set = src.indexOf("if (stashBack?.favorites) { localFavoriteValue = stashBack.favorites; localFavoriteSnapshot = readModelFavoritesSetting(stashBack.favorites); }");
  const choice = src.indexOf('const pendingFavoriteWrite = getFailedSyncs().find(f => f.kind === "model-favorites"');
  assert.ok(b >= 0 && set > b && choice > set, "the bootstrap's favorites choice sees the favorites put back");
  assert.match(src, /let localFavoriteValue = await getSetting\(/);
});
test("round 15 S4: Clear Logs stashes the uploads it takes (fresh peek) and the stored-only entries", () => {
  const h = logsH();
  const w = h.indexOf('const stashUploads = peekQueuedUploads(["history"])'), t = h.indexOf('takeQueuedUploads("history"');
  assert.ok(w >= 0 && t > w, "peeked right before the take");
  assert.doesNotMatch(h.slice(w, t), /await /, "no await between the peek and the take");
  // Round 16 #6 replaced the inline stashLoaded / stashStoredOnly lists with clearLogsStash (loaded + stored, quota fallback).
  assert.match(h.slice(w, t), /clearLogsStash\(\{ loaded: logsRef\.current, stored: storedLogs, uploads: stashUploads, /);
  assert.match(h.slice(w, t), /if \(!writeClearStash\(snap, logsStash\.full\)\) writeClearStash\(snap, logsStash\.loadedOnly\);/, "quota fallback kept");
  assert.doesNotMatch(h, /uploads: queuedLogsAtSnap\.filter/, "never the pre-await peek");
});
// Review round 16 #6: Clear Logs used savedLogIds ("stored here") as "the cloud has it", so a saved entry with no queued
// upload was never stashed and a later void lost it.
test("round 16 #6: Clear Logs reads the cloud's History ids before its snapshot and stashes by them", () => {
  const h = logsH();
  const read = h.indexOf("const cloudLogIds = isSupabaseConfigured() ? ((await pullCloudIds())?.history ?? null) : null;");
  const snap = h.indexOf("const snap = isSupabaseConfigured() ? await serverTimeRemote() : Date.now();");
  assert.ok(read >= 0 && snap > read, "the cloud read comes before the snapshot");
  const w = h.indexOf("const logsStash = clearLogsStash(");
  assert.ok(w > snap && h.slice(w, h.indexOf(";", w)).includes("planned: clearedLogSet, cloudLogIds"), "planned entries, by the cloud read");
  assert.doesNotMatch(h.slice(w, h.indexOf('takeQueuedUploads("history"')), /savedLogIds/, "savedLogIds no longer filters the stash");
});
// Review round 16 #5: two unanswered Resets voided together left the favorites empty (B stashed A's emptied state, and
// A's stash was dropped once its ids moved to B).
test("round 16 #5: a Reset chains its favoritesBefore; a settled stash whose ids moved waits, never dropped while they are pending", () => {
  const h = reset();
  const set = h.indexOf("favoritesBefore.setting = await getSetting(localModelFavoritesKey(favoriteScope));");
  const chain = h.indexOf("Object.assign(favoritesBefore, chainedFavoritesBefore(favoritesBefore, favoriteScope));");
  const empty = h.indexOf("favoriteModelsRef.current = emptyFavorites");
  assert.ok(set >= 0 && chain > set && empty > chain, "chained after the setting is read, before the local reset");
  assert.doesNotMatch(h.slice(chain, empty), /await /, "nothing awaited between the chain and the reset");
  assert.ok(h.indexOf("writeClearStash(resetAt, { ...buildClearStash(") > chain, "the stash carries the chained state");
  // Task B5: the merge (moveClearStash) is gone; the drop happens only on stashDecision's "drop" (nothing pending at its
  // time nor at any time its ids moved to, none of them voided).
  const settle = between("const settleClearStashes = () =>", "// Force-flush all pending");
  const dec = settle.indexOf('for (const s of readClearStashes()) if (stashDecision(s, voided) === "drop") {'), drop = settle.indexOf("dropClearStash(s.at)");
  assert.ok(dec >= 0 && drop > dec, "dropped only when decided");
});
test("task B5: no stash merge remains; settleClearStashes waits on the stash's own time and every movedTo time", () => {
  assert.doesNotMatch(src, /moveClearStash\(/, "App.jsx calls no merge");
  assert.doesNotMatch(src, /import \{[^}]*\bmoveClearStash\b[^}]*\} from "\.\/lib\/storage\.js";/, "nor imports it");
  const st = readFileSync(new URL("../src/lib/storage.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(st, /export function moveClearStash/, "the merge helper is deleted");
  assert.match(src, /import \{[^}]*\bstashDecision\b[^}]*\bdropGivenBackStash\b[^}]*\} from "\.\/lib\/storage\.js";/);
  const settle = between("const settleClearStashes = () =>", "const giveBackVoided = ");
  assert.doesNotMatch(settle, /intentGroups\(|stashTiedToVoided\(/, "one decision per stash, not the own-time-only check");
  assert.equal(settle.match(/stashDecision\(s, voided\)/g)?.length, 2, "the give-back and the drop both ask stashDecision");
  const dec = st.slice(st.indexOf("export function stashDecision("), st.indexOf("export function dropGivenBackStash("));
  assert.match(dec, /const times = \[stash\.at, \.\.\.\(stash\.movedTo \|\| \[\]\)\];/);
  assert.match(dec, /if \(times\.some\(t => intentsPendingAt\(t\)\)\) return "wait";/, "waits on its own time AND every movedTo time");
  assert.match(dec, /return times\.some\(t => voided\.has\(t\)\) \? "give-back" : "drop";/);
  const keep = st.slice(st.indexOf("export function dropGivenBackStash("), st.indexOf("// Review round 17 (#1, #3, #6)"));
  assert.match(keep, /movedTo\.some\(t => intentsPendingAt\(t\)\)/, "keeps the part still pending at a movedTo time");
  assert.match(keep, /dropClearStash\(stash\.at\);\s*\n\}/, "otherwise dropped");
});
test("round 15 S5: an archive a clear held is recorded, re-applied on a void, its files deleted on a confirm", () => {
  const a = between("const onCloudArchiveTask = useCallback(", "const onCopyUrlTask = useCallback(");
  const rec = a.indexOf("const held = recordStashArchive(task.id,"), del = a.indexOf("if (!held && paths.length) writeFileDeletes(");
  assert.ok(rec >= 0 && del > rec, "recorded first; queued for deletion only when no clear holds it");
  assert.match(a.slice(rec, del), /archiving: false \} : null \}\)/);
  for (const [name, h, at, r] of [["Clear Outputs", outputs(), "clearAt", "cr"], ["Reset", reset(), "resetAt", "rr"]]) {
    // Round 17: read only for a confirm; a void re-applies them through applyClearStashes (back.archives), onto the
    // versions the branch put back.
    const read = h.indexOf(`const heldArchives = ${r}.ok ? (readClearStash(${at})?.archives || {}) : {};`);
    const drop = h.indexOf(`if (${r}.ok) dropClearStash(${at})`);
    assert.ok(read >= 0 && drop > read, `${name}: read before the stash is dropped`);
    assert.match(voidedOf(h, `if (${r}.voided) {`), new RegExp(`applyClearStashes\\(voidedClearStashes\\(${at}\\), \\{ tasks: new Map\\(`), `${name}: re-applied on a void`);
    assert.doesNotMatch(voidedOf(h, `if (${r}.voided) {`), /heldArchives/, `${name}: not re-applied twice`);
    assert.ok(h.includes(`if (${r}.ok) queueArchivedFileDeletes(stashArchivePaths({ archives: heldArchives }));`), `${name}: deleted on a confirm`);
  }
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  assert.match(apply, /reapplyArchives\(back\.archives, new Map\(\[\.\.\.heldTasks, /, "onto the versions an inline void put back");
  assert.match(apply, /queueArchivedFileDeletes\(back\.orphanPaths\)/);
  const re = between("const reapplyArchives = (archives, base = new Map()) =>", "const restoreStashedFavorites = ");
  assert.match(re, /isArchived: true, archiving: false/);
  assert.match(re, /saveTask\(updated\);\s*\n\s*addFailedSync\(\{ kind: "task", id, data: updated \}\)/, "saved and its upload queued");
  assert.match(between("const settleClearStashes = () =>", "// Force-flush all pending"), /queueArchivedFileDeletes\(stashArchivePaths\(s\)\); dropClearStash\(s\.at\)/);
});
// Review round 17 #1/#3/#6: a voided clear dropped its stash (with what an earlier stash had merged into it), and a stash
// whose ids moved to it was then dropped as confirmed by the next settle pass.
test("round 17: a voided clear gives back its stash and its followers, after its in-memory put-back", () => {
  assert.match(src, /import \{[^}]*\bvoidedClearStashes\b[^}]*\} from "\.\/lib\/storage\.js";/);
  for (const [name, h, at, key, settle, put] of [
    ["Clear Logs", logsH(), "snap", "if (cr.voided) {", 'voidDeleteIntents("history-delete", clearedLogIds, snap)', "putBackQueuedUploads(takenLogUploads)"],
    ["Clear Outputs", outputs(), "clearAt", "if (cr.voided) {", 'voidDeleteIntents("history-delete", plan.remove || [], clearAt)', "putBackQueuedUploads(logUploadsBefore.filter("],
    ["Reset", reset(), "resetAt", "if (rr.voided) {", 'voidDeleteIntents("history-delete", clearedLogIds, resetAt)', "putBackQueuedUploads(favoritesBefore.queued)"]]) {
    const v = voidedOf(h, key);
    const s = v.indexOf(settle), p = v.indexOf(put), a = v.indexOf(`applyClearStashes(voidedClearStashes(${at}), {`);
    assert.ok(s >= 0 && p > s && a > p, `${name}: intents settled, in-memory put back, then the stashes given back`);
    assert.doesNotMatch(v, /dropClearStash\(/, `${name}: never a plain drop on a void`);
    assert.doesNotMatch(v, /await /, `${name}: no settle pass can run before the give-back`);
    assert.match(v.slice(a), /logs: (new Set\(|backIds \})/, `${name}: the History entries put back win`);
  }
  // The apply loop: versions an inline void put back count as held now.
  const apply = between("const applyClearStashes = (which, held = {}) =>", "const settleClearStashes = ");
  assert.match(apply, /const haveTasks = new Set\(\[\.\.\.tasksRef\.current\.map\(t => t\.id\), \.\.\.heldTasks\.keys\(\)\]\)/);
  assert.match(apply, /haveLogs = new Set\(\[\.\.\.logsRef\.current\.map\(l => l\.id\), \.\.\.heldLogs\]\)/);
  // Replay: the void gives back before the pass's settleClearStashes (after both replays).
  const fs = between("const forceSaveAll = async () =>", "const queue = taskSyncQueueRef.current.splice(0)");
  assert.ok(fs.indexOf('await replayDeleteIntents("task-delete")') < fs.indexOf("settleClearStashes()"), "replay (and its give-back) before the settle pass");
  // storage.js: followers = no pending intent of their own, movedTo includes the voided time; none while it is pending.
  const st = readFileSync(new URL("../src/lib/storage.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const f = st.slice(st.indexOf("export function stashFollowers(ts)"), st.indexOf("export function voidedClearStashes(ts)"));
  assert.match(f, /if \(!Number\.isFinite\(at\) \|\| intentsPendingAt\(at\)\) return out;/);
  assert.match(f, /\(s\.movedTo \|\| \[\]\)\.includes\(at\) && !intentsPendingAt\(s\.at\)/);
});
// Review round 18 #3: inline voids of PLAIN deletes (bulk delete, dropLogItemsFor, purgeEverywhere, History delete) only
// settled their intents, and the next settleClearStashes dropped the stashes whose ids had moved to them as confirmed.
// Every void now goes through voidDeleteIntents (settle + record the queue time), and the settle pass gives back a stash
// tied to a recorded voided time instead of dropping it.
test("round 18 #3: every void answer settles through voidDeleteIntents with its queue time; plain deletes give back", () => {
  // Task B5: settleClearStashes asks stashDecision (which subsumes stashTiedToVoided) instead.
  assert.match(src, /import \{[^}]*\bvoidDeleteIntents\b[^}]*\bvoidedTimes\b[^}]*\bstashDecision\b[^}]*\bpruneVoidedAt\b[^}]*\} from "\.\/lib\/storage\.js";/);
  // The only settleDeleteIntents left is a confirmed clear's (History-only intents the server tombstoned).
  const settles = src.match(/settleDeleteIntents\([^\n]*/g) || [];
  assert.equal(settles.length, 1, `plain settles left: ${settles.join(" | ")}`);
  assert.match(src, /if \(cr\.ok\) settleDeleteIntents\("task-delete", historyOnly\.filter/);
  // Every branch on a voided answer settles through the recording helper.
  // (`else if` ones are the toasts after a settled void; the replay's second branch is its give-back.)
  const branches = [...src.matchAll(/(else )?if \((?:(?:r|hr|cr|rr)\.voided(?:\.length)?|voided\.length)\) (\{|applyClearStashes\(voidedClearStashes\(ts\)\))/g)]
    .filter(b => !b[1] && b[2] === "{");
  assert.equal(branches.length, 8, "replay, dropLogItemsFor, purgeEverywhere, bulk delete, History delete, Clear Logs, Clear Outputs, Reset");
  for (const b of branches) {
    const head = src.slice(b.index, b.index + 400);
    assert.match(head, /^[^\n]*\n(\s*\/\/[^\n]*\n)*\s*voidDeleteIntents\(/, `void branch at line ${src.slice(0, b.index).split("\n").length} settles through voidDeleteIntents first`);
  }
  const plainSites = [
    ["dropLogItemsFor", between("const dropLogItemsFor = useCallback(", "}, [persistLog]);"), 'voidDeleteIntents("history-delete", r.voided, emptiedAt)', "giveBackVoided(emptiedAt)"],
    ["purgeEverywhere", purge(), 'voidDeleteIntents("history-delete", hr.voided, plan.historyQueuedAt)', "giveBackVoided(plan.historyQueuedAt)"],
    ["bulk delete", between("const queuedAt = queueDeleteIntents(\"task-delete\", ids);", "const { note } = r.ok ? await purgeEverywhere(plan)"),
      'voidDeleteIntents("history-delete", plan.remove || [], plan.historyQueuedAt)', "giveBackVoided(queuedAt, plan.historyQueuedAt)"],
    ["History delete", between('const queuedAt = queueDeleteIntents("history-delete", ids);', "// 7. Refresh counters"), 'voidDeleteIntents("history-delete", r.voided, queuedAt)', "giveBackVoided(queuedAt)"]];
  for (const [name, h, settle, give] of plainSites) {
    const s = h.indexOf(settle), g = h.indexOf(give);
    assert.ok(s >= 0 && g > s, `${name}: settled and recorded, then the stashes that moved to it given back`);
    assert.doesNotMatch(h.slice(s, g), /await /, `${name}: nothing awaited between the void and its give-back`);
  }
  assert.ok(between("const queuedAt = queueDeleteIntents(\"task-delete\", ids);", "const { note } = r.ok").includes('voidDeleteIntents("task-delete", voided, queuedAt)'), "bulk delete: task group");
  assert.match(between("const replayDeleteIntents = async", "const replayHistoryUploads = async"), /voidDeleteIntents\(kind, r\.voided, ts\)/);
  for (const [h, re] of [[outputs(), /voidDeleteIntents\("task-delete", clearedTaskIds, clearAt\)/], [reset(), /voidDeleteIntents\("task-delete", clearedTaskIds, resetAt\); voidDeleteIntents\("history-delete", clearedLogIds, resetAt\)/]])
    assert.match(h, re);
  const give = between("const giveBackVoided = (...times) =>", "\n  };");
  assert.match(give, /voidedClearStashes\(t\)/); assert.match(give, /applyClearStashes\(at => which\.some\(w => w\(at\)\)\)/);
});
test("round 18 #3: settleClearStashes gives back a stash tied to a recorded voided time; no path drops one", () => {
  const settle = between("const settleClearStashes = () =>", "const giveBackVoided = ");
  // Task B5: the guard is stashDecision: "give-back" (tied to a recorded voided time) first, a drop only on "drop".
  const pick = settle.indexOf('readClearStashes().filter(s => stashDecision(s, voided) === "give-back")');
  const back = settle.indexOf("if (back.size) applyClearStashes(at => back.has(at));");
  const guard = settle.indexOf('if (stashDecision(s, voided) === "drop") {'), drop = settle.indexOf("dropClearStash(s.at)");
  assert.ok(settle.indexOf("const voided = voidedTimes();") >= 0 && pick > 0 && back > pick, "given back first");
  assert.ok(guard > back && drop > guard, "a tied stash is never dropped");
  assert.equal(settle.match(/dropClearStash\(/g)?.length, 1, "one drop, behind the guard");
  assert.match(settle, /pruneVoidedAt\(\);\s*\n\s*\};/, "the record is pruned after the pass");
  // storage.js: the helper settles and records; the tie needs nothing pending; restoreGuard's drop records too.
  const st = readFileSync(new URL("../src/lib/storage.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const v = st.slice(st.indexOf("export function voidDeleteIntents("), st.indexOf("export function stashTiedToVoided("));
  assert.match(v, /settleDeleteIntents\(kind, ids\);\s*\n\s*if \(\(ids \|\| \[\]\)\.some\(Boolean\)\) recordVoidedAt\(at\);/);
  const tie = st.slice(st.indexOf("export function stashTiedToVoided("), st.indexOf("// Clear Logs' stash (round 16 #6)"));
  // Task B5: the tie needs nothing pending at its own time nor at any movedTo time (stashDecision).
  assert.match(tie, /intentsPendingAt\(stash\.at\)/); assert.match(tie, /stashDecision\(stash, voided\) === "give-back"/);
  assert.match(st.slice(st.indexOf("export function dropDeleteIntentsBefore("), st.indexOf("// The restore check every replay")), /recordVoidedAt\(times\)/);
  assert.equal((st.match(/settleDeleteIntents\(/g) || []).length, 3, "definition, confirmDeleteIntents, voidDeleteIntents");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
