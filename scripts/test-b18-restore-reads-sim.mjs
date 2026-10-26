// Task B18 review (wf_9c77adf7-aef b18 #1): a restore that commits while a pass's reads are running, after its History
// read and before its settings read. The pass then sees the new marker (a restore it has not handled) with History from
// before that restore. Before the fix it took that History as the restored copy (batchLog.js restoredVersions) and
// marked the restore handled, or, with the entry's upload queued here, stripped the restore's History-only comeback
// (restoreStrippedLogs). Either way this device's entry lost the item for good while the cloud kept it. Now a pass, or
// the startup load, whose reads may predate the restore (its marker is newer than what this browser knew before the
// reads) handles nothing and waits for the next pass. Driven through the simulator (scripts/sim, the App.jsx flows
// mirrored over the real src/lib modules) with the interleaving placed by hand. Written first: before the change the
// three scenarios fail.
// Run: node scripts/test-b18-restore-reads-sim.mjs
import assert from "node:assert/strict";
import { Sim, rng } from "./sim/sim.mjs";

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 4).join(" | ")); }
};
const itemIds = (e) => (e?.tasks || []).map(i => i.id);

// Phone D (page A1) holds entry E = [X, Y, Z]. The PC (B1) takes a backup that lacks X's own row (the 500-row cap), then
// deletes X: the cloud holds E = [Y, Z] and a user tombstone for X, and D has not synced since. Automatic backups are on,
// so the backup keeps its copy of E (no scrub). Restoring it brings X back History-only.
async function setup() {
  const sim = new Sim({ net: "any", traceOn: true });   // traced: some positive controls read sim.lines
  Date.now = () => sim.clock.now;
  Math.random = rng(1);
  await sim.init();
  sim.server.autoBackups = true;
  const D = sim.pages.A1;
  let made = null;
  await sim.run(D, () => D.generate(3, (list) => { made = list; }));
  await sim.run(D, () => D.finish());
  await sim.deliverAll();
  const [E, X] = made;
  await sim.run(sim.pages.B1, () => sim.pages.B1.reconcile());
  await sim.deliverAll();
  await sim.run(sim.pages.B1, () => sim.pages.B1.manualBackup());
  await sim.deliverAll();
  const bk = sim.server.backups.at(-1);
  bk.tasks = bk.tasks.filter(t => t.id !== X);
  assert.deepEqual(itemIds(bk.history.find(e => e.id === E)).includes(X), true, "the backup's E holds X");
  await sim.run(sim.pages.B1, () => sim.pages.B1.deleteSelectedTasks([X]));
  await sim.deliverAll();
  assert.deepEqual(itemIds(sim.server.history.get(E)).includes(X), false, "the cloud's E lost X to the delete");
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X), "D still holds X");
  return { sim, D, E, X, bk };
}
// Delivers D's requests (and only D's) until `name` is pending, then runs it at the server with its answer held.
async function runAtServer(sim, page, name) {
  for (let i = 0; i < 200; i++) {
    const m = sim.net.pending.find(x => x.page === page && x.state === "sent" && x.name === name);
    if (m) { sim.net.execute(m); return m; }
    const other = sim.net.pending.find(x => x.page === page && x.state === "sent");
    assert.ok(other, `${page.label} never sent ${name}`);
    await sim.deliverOne(other);
  }
  assert.fail(`${name} not reached`);
}
// The PC restores the backup while D's History answer is held; then everything is delivered (D's settings, ids and
// tombstone reads run after the restore).
async function restoreNow(sim, bk) {
  const pc = sim.pages.B1;
  await sim.run(pc, () => pc.restoreFrom(bk.id));
  for (let i = 0; i < 200 && sim.net.pending.some(m => m.page === pc && m.state === "sent"); i++) {
    await sim.deliverOne(sim.net.pending.find(m => m.page === pc && m.state === "sent"));
  }
  assert.ok(sim.server.restores.length > 0, "the restore committed");
  while (sim.reloads.length) await sim.newPage(sim.reloads.shift());
}
const realNow = Date.now, realRandom = Math.random;

await test("(a) a pass whose History read ran before the restore takes nothing from it; the next pass keeps X", async () => {
  const { sim, D, E, X, bk } = await setup();
  await sim.run(D, () => D.reconcile());
  await runAtServer(sim, D, "pullHistory");
  await restoreNow(sim, bk);
  await sim.deliverAll();
  assert.ok(itemIds(sim.server.history.get(E)).includes(X), "the restore brought X back in the cloud's E");
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X), "after the pass that read History before the restore, D's E still holds X");
  await sim.run(D, () => D.reconcile());
  await sim.deliverAll();
  assert.deepEqual(itemIds(D.st.logs.find(l => l.id === E)).sort(), itemIds(sim.server.history.get(E)).sort(), "the next pass: D's E equals the cloud's");
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X));
});

await test("(b) the same with E's upload queued on D after the restore: no strip of X", async () => {
  const { sim, D, E, X, bk } = await setup();
  await sim.run(D, () => D.reconcile());
  await runAtServer(sim, D, "pullHistory");
  await restoreNow(sim, bk);
  const mine = D.st.logs.find(l => l.id === E);
  // queued now (after the restore's marker), in D's browser: storage.js reads the browser the code runs in (sim.run)
  let queued = false;
  await sim.run(D, () => {
    D.S.addFailedSync({ kind: "history", id: E, data: mine });
    queued = D.S.getFailedSyncs().some(f => f.kind === "history" && f.id === E);
  });
  assert.ok(queued, "positive control: E's upload is queued in D's browser");
  await sim.deliverAll();
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X), "D's E still holds X after that pass");
  await sim.run(D, () => D.reconcile());
  await sim.deliverAll();
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X), "and after the next one");
  assert.ok(itemIds(sim.server.history.get(E)).includes(X), "the cloud's E holds X");
});

await test("(c) a startup load whose History read ran before the restore takes nothing from it; its first pass keeps X", async () => {
  const { sim, D, E, X, bk } = await setup();
  const page = await sim.newPage("A1");   // D reloads: its bootstrap's reads are sent
  await runAtServer(sim, page, "pullHistory");
  await restoreNow(sim, bk);
  await sim.deliverAll();   // the bootstrap ends and starts its first reconcile pass
  await sim.deliverAll();
  const mineNow = sim.pages.A1.st.logs.find(l => l.id === E);
  assert.ok(itemIds(mineNow).includes(X), `D's E after the load and its first pass: [${itemIds(mineNow)}]`);
  assert.deepEqual(itemIds(mineNow).sort(), itemIds(sim.server.history.get(E)).sort());
});

// B18 verification (tests #2): the strip compare (guard.restoreAt <= restoreKnownAt) on its own. Another start-up load in
// this tab (a sign-out and sign-in) marks the restore handled while this pass's reads are out: the pass is then not fresh,
// so it does not wait, and its History is still from before the restore. Only the compare keeps the strip from removing
// the History-only comeback X.
await test("(d) a pass whose restore was marked handled during its reads does not strip with pre-restore History", async () => {
  const { sim, D, E, X, bk } = await setup();
  await sim.run(D, () => D.reconcile());
  const held = await runAtServer(sim, D, "pullHistory");
  await restoreNow(sim, bk);
  assert.ok(!itemIds((held.result || []).find(e => e.id === E)).includes(X), "positive control: the held History predates the restore");
  assert.ok(sim.server.tomb.get(X)?.byRestore, "positive control: X is the restore's History-only comeback");
  await sim.run(D, () => D.S.markRestoreSeen(sim.server.marker));
  const before = sim.lines.length;
  await sim.deliverAll();
  assert.ok(sim.traceOn && sim.lines.length > 0, "positive control: the run is traced (reads themselves are not)");
  assert.ok(!sim.lines.slice(before).some(l => /A1#0 pass waits/.test(l)), "positive control: the pass did not wait (not fresh)");
  assert.equal(D.restorePending, false, "positive control: nothing left pending (the pass went on)");
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X), "D's E still holds X");
  await sim.run(D, () => D.reconcile());
  await sim.deliverAll();
  assert.deepEqual(itemIds(D.st.logs.find(l => l.id === E)).sort(), itemIds(sim.server.history.get(E)).sort());
});

// B18 verification (tests #3): "known before the reads" means before them. A sibling tab of the same browser (A2) notes the
// restore while A1's reads are out; a value taken after the reads would include it and let A1 take pre-restore History.
async function siblingNotes(sim, bk) {
  await restoreNow(sim, bk);
  const A2 = sim.pages.A2;
  await sim.run(A2, () => A2.reconcile());
  for (let i = 0; i < 400 && sim.net.pending.some(m => m.page === A2); i++) {
    const m = sim.net.pending.find(x => x.page === A2);
    if (m.state === "sent") await sim.deliverOne(m); else await sim.answer(m);
  }
  let known = 0;
  await sim.run(A2, () => { known = A2.S.knownRestoreAt(); });
  assert.ok(known >= sim.server.marker, "positive control: the browser knows the restore before A1's reads end");
}
await test("(e) a start-up load: the restore a sibling tab notes during its reads does not count as known before them", async () => {
  const { sim, E, X, bk } = await setup();
  const page = await sim.newPage("A1");
  await runAtServer(sim, page, "pullHistory");
  await siblingNotes(sim, bk);
  await sim.deliverAll();
  await sim.deliverAll();
  const mine = sim.pages.A1.st.logs.find(l => l.id === E);
  assert.ok(itemIds(mine).includes(X), `D's E: [${itemIds(mine)}]`);
  assert.deepEqual(itemIds(mine).sort(), itemIds(sim.server.history.get(E)).sort());
});
await test("(f) a reconcile pass: the same", async () => {
  const { sim, D, E, X, bk } = await setup();
  await sim.run(D, () => D.reconcile());
  await runAtServer(sim, D, "pullHistory");
  await siblingNotes(sim, bk);
  await sim.deliverAll();
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X), "after the pass that read History before the restore");
  await sim.run(D, () => D.reconcile());
  await sim.deliverAll();
  assert.deepEqual(itemIds(D.st.logs.find(l => l.id === E)).sort(), itemIds(sim.server.history.get(E)).sort());
});

// B18 verification round 2 (tests #3): the waiting pass's own re-run (App.jsx: a second later) heals the device with no
// other pass: the second pass of (a) is the re-run alone here.
await test("(g) the re-run alone: after the pass that waited, its re-run takes the restored History", async () => {
  const { sim, D, E, X, bk } = await setup();
  // round 3 (tests #3): D's copy of E differs from the backup's in a field the restore's copy replaces (batchLog.js
  // restoredVersions takes the items and the total; local-only fields stay), so only a pass that really takes the
  // restored entry makes them equal (the items alone already match)
  await sim.run(D, () => D.setLogs(prev => prev.map(l => (l.id === E ? { ...l, totalCost: 999 } : l))));
  assert.equal(D.st.logs.find(l => l.id === E).totalCost, 999, "positive control: D's copy differs");
  await sim.run(D, () => D.reconcile());
  await runAtServer(sim, D, "pullHistory");
  await restoreNow(sim, bk);
  const before = sim.lines.length;
  await sim.deliverAll();
  const after = sim.lines.slice(before);
  assert.ok(after.some(l => /A1#0 pass waits/.test(l)), "positive control: D's pass waited");
  assert.ok(after.some(l => /A1#0 re-runs after a wait/.test(l)), "positive control: and ran again by itself");
  assert.equal(D.restorePending, false, "the re-run handled the restore");
  let known = 0;
  await sim.run(D, () => { known = D.S.knownRestoreAt(); });
  assert.ok(known >= sim.server.marker, "this browser knows the restore");
  assert.equal(D.st.logs.find(l => l.id === E).totalCost, sim.server.history.get(E).totalCost, "D took the restored entry");
  assert.notEqual(sim.server.history.get(E).totalCost, 999);
  assert.deepEqual(itemIds(D.st.logs.find(l => l.id === E)).sort(), itemIds(sim.server.history.get(E)).sort());
  assert.ok(itemIds(D.st.logs.find(l => l.id === E)).includes(X));
});

Date.now = realNow; Math.random = realRandom;
console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
