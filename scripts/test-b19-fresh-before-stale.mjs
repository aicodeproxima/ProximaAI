// Task B19 (B18 verification round 3, correctness #1; already on HEAD): a pass that handles a restore took the cloud's
// copies of the restored History entries (batchLog.js restoredVersions) only AFTER its stale-drop step. That step
// (dropLogItemsFor) rewrites this tab's entry from its PRE-restore copy and uploads it (persistLog, a plain upsert), so the
// upload overwrote the restored entry, and restoredVersions then skipped the entry as queued: an item the restore brought
// back was gone from the cloud and every device for good. The pass now takes the restored copies first, so the stale step
// rewrites the restored copy. Driven through the simulator (scripts/sim, the App.jsx flows over the real src/lib).
// Written first: before the change both cases fail.
// Run: node scripts/test-b19-fresh-before-stale.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Sim, rng } from "./sim/sim.mjs";
import { setServerRule } from "./sim/server.mjs";

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 4).join(" | ")); }
};
const itemIds = (e) => (e?.tasks || []).map(i => i.id).sort();
const realNow = Date.now, realRandom = Math.random;

// Tabs A1 and A2 of one browser and device B1. Batch E = [X, Y, Z]. B1 backs up (Y History-only in the backup, or with
// its row); A1 deletes Y and then sits in the background (no passes); B1 restores (Y comes back); A2 handles the restore
// and deletes X. A1 comes back: its pass handles the restore AND drops X (a confirmed delete the cloud lacks).
async function run(historyOnly) {
  setServerRule("v4");
  const sim = new Sim({ net: "any", traceOn: true });
  Date.now = () => sim.clock.now; Math.random = rng(1);
  await sim.init();
  sim.server.autoBackups = true;
  const { A1, A2, B1 } = sim.pages;
  let made = null;
  await sim.run(A1, () => A1.generate(3, (l) => { made = l; }));
  await sim.run(A1, () => A1.finish());
  await sim.deliverAll();
  const [E, X, Y, Z] = made;
  for (const p of [A2, B1]) { await sim.run(p, () => p.reconcile()); await sim.deliverAll(); }
  await sim.run(B1, () => B1.manualBackup()); await sim.deliverAll();
  const bk = sim.server.backups.at(-1);
  if (historyOnly) bk.tasks = bk.tasks.filter(t => t.id !== Y);
  await sim.run(A1, () => A1.deleteSelectedTasks([Y])); await sim.deliverAll();
  await sim.run(B1, () => B1.restoreFrom(bk.id)); await sim.deliverAll();
  while (sim.reloads.length) await sim.newPage(sim.reloads.shift());
  await sim.deliverAll();
  const a2 = sim.pages.A2;
  await sim.run(a2, () => a2.reconcile()); await sim.deliverAll();
  await sim.run(a2, () => a2.deleteSelectedTasks([X])); await sim.deliverAll();
  const a1 = sim.pages.A1;
  // positive controls: the restore brought Y back and X is gone in the cloud; A1 still shows its pre-restore E (with X,
  // without Y), so its next pass both handles the restore and drops X
  assert.deepEqual(itemIds(sim.server.history.get(E)), [Y, Z].sort(), "the cloud's E before A1's pass");
  assert.deepEqual(itemIds(a1.st.logs.find(l => l.id === E)), [X, Z].sort(), "A1's stale E before its pass");
  await sim.run(a1, () => a1.reconcile()); await sim.deliverAll();
  const afterPass = { cloud: itemIds(sim.server.history.get(E)), a1: itemIds(a1.st.logs.find(l => l.id === E)) };
  for (let i = 0; i < 3; i++) for (const p of [sim.pages.A1, sim.pages.A2, sim.pages.B1]) { await sim.run(p, () => p.reconcile()); await sim.deliverAll(); }
  const end = { cloud: itemIds(sim.server.history.get(E)), pages: ["A1", "A2", "B1"].map(s => itemIds(sim.pages[s].st.logs.find(l => l.id === E))) };
  Date.now = realNow; Math.random = realRandom;
  return { E, X, Y, Z, afterPass, end };
}

for (const historyOnly of [true, false]) {
  await test(`Y restored ${historyOnly ? "History-only" : "with its row"}: A1's pass keeps it in E (cloud and every page)`, async () => {
    const { Y, Z, afterPass, end } = await run(historyOnly);
    assert.deepEqual(afterPass.cloud, [Y, Z].sort(), "the cloud's E right after A1's pass");
    assert.deepEqual(afterPass.a1, [Y, Z].sort(), "A1's E right after its pass");
    assert.deepEqual(end.cloud, [Y, Z].sort(), "the cloud's E at the end");
    for (const p of end.pages) assert.deepEqual(p, [Y, Z].sort(), "every page's E at the end");
  });
}

// The App.jsx half (the simulator above mirrors it): in reconcileWithCloud, comments stripped, the restore step comes before
// the stale step and its first rewrite, and it reads its own queued-upload set.
await test("wiring: App.jsx takes the restored copies before the stale step", () => {
  const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/gm, "$1");
  const i = code.indexOf("const reconcileWithCloud = useCallback("), rec = code.slice(i, code.indexOf("}, []);\n", i));
  const fresh = rec.indexOf("if (guard.fresh) {"), stale = rec.indexOf("const logsBeforeDrops = logsRef.current;"), drop = rec.indexOf("dropLogItemsFor(staleGone)");
  assert.ok(i >= 0 && fresh > 0 && stale > fresh && drop > stale, `order: fresh ${fresh} < stale ${stale} < drop ${drop}`);
  assert.match(rec.slice(fresh, stale), /const queuedLogs = new Set\(getFailedSyncs\(\)\.filter\(f => f\.kind === "history"\)\.map\(f => f\.id\)\);\s*const take = new Map\(restoredVersions\(logsRef\.current, remote\.history, queuedLogs\)/);
  assert.equal(rec.split("restoredVersions(logsRef.current, remote.history,").length - 1, 1, "one restore step");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
