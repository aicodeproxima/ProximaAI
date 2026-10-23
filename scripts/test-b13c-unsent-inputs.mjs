// Task B13c (simulator class B): a batch input another browser still needs for a row it has not uploaded yet is never
// deleted. A device deletes the files of the generations it removes against what it can see: its own view, the server's
// rows (paths_in_use) and the forms' holds (this browser's tabs, the other browser's cloud publication form-inputs:<id>).
// A sibling row still waiting in the other browser's upload queue (a frozen phone) is in none of them once that
// browser's form let go of the file, so the shared input was deleted and the sibling landed later without it. Every
// browser now publishes, with its forms' holds, the paths its queued (not yet uploaded) task and History rows use: the
// failed-sync queue, shared by its tabs, so a closing tab never withdraws them.
// Runs the real storage.js, purge.js and fileDelete.js; App.jsx wiring is checked from the source. Written first: before
// the change every test below fails (unsentUploadPaths is missing; the publication and the flush do not read it).
// Run: node scripts/test-b13c-unsent-inputs.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
const S = await import("../src/lib/storage.js");
const F = await import("../src/lib/fileDelete.js");
const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `missing after ${from}: ${to}`);
  return src.slice(i, j);
};

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};
const need = (name) => { assert.equal(typeof S[name], "function", `${name} exists`); return S[name]; };
const BASE = "https://x.supabase.co/storage/v1/object/public/generations/";
const url = (p) => BASE + p;

await test("queued task and History uploads: every bucket path they use", () => {
  const unsent = need("unsentUploadPaths");
  S.addFailedSync({ kind: "task", id: "t2", data: { id: "t2", batchId: "L", sourceImageUrl: url("uploads/s/in.png"), endFrameUrl: url("uploads/s/end.png"), outputs: [url("s/t2.png")] } });
  S.addFailedSync({ kind: "history", id: "L", data: { id: "L", sourceImageUrls: [url("uploads/s/in2.png")], tasks: [{ id: "t2", outputs: [url("s/t2b.png")] }] } });
  assert.deepEqual([...unsent()].sort(), ["s/t2.png", "s/t2b.png", "uploads/s/end.png", "uploads/s/in.png", "uploads/s/in2.png"]);
});

await test("delete intents, settings and malformed entries add nothing; a broken queue reads as empty", () => {
  const unsent = need("unsentUploadPaths");
  S.queueDeleteIntents("task-delete", ["x"], 1000);
  S.addFailedSync({ kind: "task", id: "bad", data: "not-an-object" });
  assert.deepEqual([...unsent()], []);
  localStorage.setItem("proximaai-failed-syncs", "{not json");
  assert.deepEqual([...unsent()], []);
});

await test("an upload that was sent leaves the queue, and its paths leave the set", () => {
  const unsent = need("unsentUploadPaths");
  S.addFailedSync({ kind: "task", id: "t2", data: { id: "t2", sourceImageUrl: url("uploads/s/in.png") } });
  assert.ok(unsent().has("uploads/s/in.png"));
  S.removeFailedSync("task", "t2");
  assert.ok(!unsent().has("uploads/s/in.png"));
});

await test("the file flush classifies such a path as held by a form (never deleted, never 'unknown')", () => {
  const unsent = need("unsentUploadPaths");
  S.addFailedSync({ kind: "task", id: "t2", data: { id: "t2", sourceImageUrl: url("uploads/s/in.png") } });
  const forms = new Set([...unsent()]);
  assert.equal(F.classifyPath("uploads/s/in.png", { owned: new Set(), forms, remote: new Set() }), "form");
});

await test("wiring: the cloud publication (heartbeat and pagehide) carries the queued uploads' paths", () => {
  const eff = between("// This tab's Generate form inputs, published for every tab's file flush", "const mediaDuration = url =>");
  const mine = eff.match(/mine = \[\.\.\.new Set\(\[\.\.\.liveFormPaths\(readFormPublications\(\), now\), \.\.\.unsentUploadPaths\(\)\]\)\]/g) || [];
  assert.equal(mine.length, 2, "publish() and bye() both add the queued uploads' paths");
  assert.ok(!/mine = \[\.\.\.liveFormPaths\(readFormPublications\(\), now\)\];/.test(eff), "no publication without them");
});

await test("wiring: this browser's own flush holds them too", () => {
  const fl = between("const cloudHolds = isSupabaseConfigured() ? await pullFormHolds() : [];", "const candidates = due.filter(");
  assert.match(fl, /const forms = new Set\(\[\.\.\.pathsInUse\(\[draftFormRef\.current\]\), \.\.\.liveFormPaths\(readFormPublications\(\), Date\.now\(\)\),\s*\.\.\.liveFormPaths\(cloudHolds \|\| \[\], Date\.now\(\)\), \.\.\.unsentUploadPaths\(\)\]\);/);
});

// Reset Everything (simulator I6-end): the History-only generations of the entries it deletes go with it, named. The server
// tombstones a rowless item only of entries created by the reset's bound, or a named one; an entry this device holds is
// deleted whatever its age, so its item from another device whose row is still to come was left alive while the reset
// planned the item's files: the row landed later without them.
await test("wiring: Reset names the History-only items of the entries it deletes and plans them from the item", () => {
  const r = between("const plannedLogIds = new Set([...copyLogs.keys(), ...queuedLogs.keys()]);", "const removedTasks = [...allTasks.values()]");
  assert.match(r, /const resetHistoryOnly = new Map\(historyOnlyGenerations\(\[\.\.\.plannedLogIds\]\.map\(id => copyLogs\.get\(id\) \|\| queuedLogs\.get\(id\) \|\| remote\.history\.find\(l => l\.id === id\)\)\.filter\(Boolean\),\s*new Set\(\[\.\.\.plannedTaskIds, \.\.\.remoteTasks\.keys\(\)\]\)\)\.map\(g => \[g\.id, g\]\)\);\s*for \(const id of resetHistoryOnly\.keys\(\)\) plannedTaskIds\.add\(id\);/);
  assert.match(r, /copyTasks\.get\(id\) \|\| resetHistoryOnly\.get\(id\) \|\| \{ id \}\);/);
  assert.ok(r.indexOf("const resetHistoryOnly") < r.indexOf("const queuedPlanned"), "planned before the queues are read");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
