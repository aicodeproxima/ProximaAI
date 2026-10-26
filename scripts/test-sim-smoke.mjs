// Smoke run of the delete/restore/sync simulator (scripts/sim): 200 seeds x 60 operations over two tabs of one browser
// and a second device, against the fake server, with the REAL src/lib modules and the App.jsx flows mirrored. It
// asserts only that the simulator runs and exercises what it is for (deletes, clears, restores, voided calls, uploads, and
// since task B12c the file and WaveSpeed deletes its held purges release, checked by invariants I6 / I7);
// the invariant violations it finds are REPORTED, not asserted (known findings: scripts/sim/run.mjs shrinks and explains
// them). It also FAILS when an App.jsx region's mirror may be stale (scripts/sim/drift.mjs; since the B18 verification
// round 2: an App.jsx edit there without the matching scripts/sim/app.mjs change passed every test). After updating the
// mirror, refresh the fingerprints (drift.mjs EXPECTED).
// Long mode: node scripts/sim/run.mjs --minutes 10 --steps 200 --net all
// Run: node scripts/test-sim-smoke.mjs
import assert from "node:assert/strict";
import { runOps, genOps, signature } from "./sim/sim.mjs";
import { mirrorDrift } from "./sim/drift.mjs";

const SEEDS = 200, STEPS = 60;
const t0 = Date.now();
const totals = {}, sigs = new Map();
let runs = 0;
for (let s = 1; s <= SEEDS; s++) {
  const r = await runOps(genOps(s, STEPS), { net: "fifo" });
  runs++;
  for (const [k, v] of Object.entries(r.stats)) totals[k] = (totals[k] || 0) + v;
  for (const v of r.violations) { const k = signature(v); if (!sigs.has(k)) sigs.set(k, { n: 0, seed: s }); sigs.get(k).n++; }
}
const ms = Date.now() - t0;
assert.equal(runs, SEEDS, "every seed ran");
for (const k of ["deletes", "clears", "restores", "voided", "uploads", "reloads", "fileDeletes", "wsDeletes"]) assert.ok(totals[k] > 0, `the runs exercised ${k} (${totals[k]})`);
const drift = mirrorDrift();
for (const [k, { n, seed }] of sigs) console.log(`finding (${n}x, first seed ${seed}): ${k}`);
if (drift.length) console.log(`WARNING mirror drift, re-read App.jsx and update scripts/sim/app.mjs: ${drift.join("; ")}`);
const found = [...sigs.values()].reduce((a, b) => a + b.n, 0);
console.log(`sim smoke: ${runs} runs x ${STEPS} ops in ${ms} ms (deletes ${totals.deletes}, clears ${totals.clears}, restores ${totals.restores}, voided ${totals.voided}, file deletes ${totals.fileDeletes}, WaveSpeed deletes ${totals.wsDeletes}); ${found} finding(s) in ${sigs.size} signature(s) reported, not asserted${drift.length ? "; MIRROR DRIFT" : ""}`);
assert.deepEqual(drift, [], "App.jsx regions whose simulator mirror (scripts/sim/app.mjs) was not updated");
