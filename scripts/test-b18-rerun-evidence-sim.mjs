// Task B18 verification (wf_b879515b-719 regression #1): the pass that re-runs a second after one that waited for a restore
// (App.jsx reconcileWithCloud, restoreAfterReads) is the first one allowed to decide the held purges of that restore. Its
// "this browser keeps it" evidence counted the tab's debounced task-upload queue unfiltered, so a generation the pass had
// just removed as user-deleted elsewhere (or one the cloud tombstones) still counted as kept when its finished copy sat in
// that queue: the held files were cancelled and never queued again (the queue's copy never lands: the id is tombstoned).
// The queue is now counted only for ids the pass keeps, as the IndexedDB copies already were. Replays the two shrunk
// operation lists the simulator found once the re-run was mirrored (scripts/fixtures/b18-rerun-ops.json: fifo seed 13 and
// any seed 1020, server rules v4). Written first: before the change both report the I7.
// Run: node scripts/test-b18-rerun-evidence-sim.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runOps, genOps } from "./sim/sim.mjs";
import { setServerRule } from "./sim/server.mjs";

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 4).join(" | ")); }
};
const CASES = JSON.parse(readFileSync(new URL("./fixtures/b18-rerun-ops.json", import.meta.url), "utf8"));
setServerRule("v4");
// B18 verification round 3 (regression #1): any seed 4895 under the v3 rules. The re-run pass also handled the restore and
// released a held WaveSpeed delete of a generation the restore had removed History-only, before another device's queued
// upload of its row landed (I6-end). The pass that handles a restore no longer decides held purges; the next one does.
await test("the fixture holds the three cases", () => assert.deepEqual(CASES.map(c => `${c.net} ${c.seed} ${c.server || "v4"}`).sort(), ["any 1020 v4", "any 4895 v3", "fifo 13 v4"]));
for (const c of CASES) {
  await test(`${c.net} seed ${c.seed} (${c.server || "v4"}): held deletes are decided right after the re-run`, async () => {
    setServerRule(c.server || "v4");
    const r = await runOps(c.ops, { net: c.net, traceOn: true });
    const trace = r.lines.join("\n");
    // the case still reaches the new path (else this would pass for nothing): a pass waited for a restore and ran again
    assert.match(trace, /pass waits: restore \d+ is newer than the \d+ known before its reads/, "positive control: a pass waited");
    assert.match(trace, /re-runs after a wait/, "positive control: and the waiting page ran its pass again (the re-run)");
    assert.deepEqual(r.violations.filter(v => !/info/.test(v.code)).map(v => `${v.code} ${v.msg}`), []);
  });
}

// B18 verification rounds 1 and 2 (regression #1 each): the evidence counts this tab's debounced queue and its History items
// only for generations it keeps. A queued copy of a generation the pass removes or the cloud tombstones never lands, and a
// History item of a generation the restore removed is stripped by the server from any upload (K2): counting them as "alive
// here" cancelled the held files and WaveSpeed results of their user delete (I7-info). Since round 3 the pass that handles
// a restore decides nothing, so these are whole generated runs where a later deciding pass meets them (the info class is
// not shrunk by run.mjs): seed 200 needs the queue filter (11 I7-info without it), seed 296 the History filter (6).
for (const [seed, skip, without] of [[200, /evidence skips queued copies \[[^\]]+\]/, "queue"], [296, /evidence skips restore-removed History items \[[^\]]+\]/, "History"]]) {
  await test(`seed ${seed} (fifo): the ${without} filter keeps the held files of user-deleted generations from being cancelled`, async () => {
    setServerRule("v4");
    const r = await runOps(genOps(seed, 200), { net: "fifo", traceOn: true });
    const trace = r.lines.join("\n");
    // the filter itself left something out (else a changed generator would make this vacuous)
    assert.match(trace, skip, `positive control: the ${without} filter excluded something`);
    assert.deepEqual(r.violations.map(v => `${v.code} ${v.msg}`), []);
  });
}

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
