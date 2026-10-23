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
    assert.match(h, /new Map\(localTasks\.map\(t => \[t\.id, t\]\)\)/, `${name}: tasks planned from the capture`);
    assert.match(h, new RegExp(`remote\\.tasks[\\s\\S]{0,160}Date\\.parse\\(t\\.createdAt\\) > ${v}`), `${name}: later rows skipped`);
  }
  const h = outputs();
  assert.match(h, /mergeLogs\(localLogs, /);
  const snap = h.indexOf("await serverTimeRemote()"), staged = h.indexOf("stagePurge(");
  assert.ok(staged > snap);
  assert.doesNotMatch(h.slice(snap, staged), /tasksRef\.current|logsRef\.current/, "Clear Outputs: no live read after the snapshot");
  assert.match(h, /historyOnlyGenerations\(mergedLogs, new Set\(\[\.\.\.all\.keys\(\), \.\.\.remote\.tasks\.map\(t => t\.id\)\]\)\)/,
    "a generation with any row in the read is not History-only");
  assert.doesNotMatch(h, /clearTasksDB\(/, "Clear Outputs removes only the planned ids here");
  assert.match(h, /deleteTasks\(/);
  assert.match(reset(), /new Map\(localLogs\.map\(l => \[l\.id, l\]\)\)/);
});
// Review round 12 (F5): Clear Logs stamped its clear with the device's estimate of the server time.
test("Clear Logs takes the server's time before anything changes and clears / queues at it", () => {
  const h = between('createBackup("pre-clear-logs"', ">Clear Logs</button>");
  const snap = h.indexOf("const snap = isSupabaseConfigured() ? await serverTimeRemote() : Date.now()"), drop = h.indexOf("dropQueuedUploads(");
  assert.ok(snap >= 0 && drop > snap, "snapshot before dropQueuedUploads");
  assert.match(h.slice(snap, drop), /if \(snap == null\)[\s\S]*return;/, "no server time -> nothing done");
  assert.match(h, /queueDeleteIntents\("history-delete", clearedLogIds, snap\)/);
  assert.match(h, /clearQueuedRemote\("history", snap, clearedLogIds\)/);
});
// Review round 10 (F2): a confirmed delete kept in deletingIds stripped a generation a later restore brought back.
test("History uploads leave out only generations whose delete is still in flight", () => {
  assert.equal(src.match(/withoutDeleting\([^;]*pendingDeleteIds\("task-delete"\)\)/g)?.length, 2);
  assert.doesNotMatch(src, /withoutDeleting\([^;]*deletingIds\.current/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
