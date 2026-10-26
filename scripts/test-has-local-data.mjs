// Second account S5: storage.js hasLocalData, the input that says whether this browser holds an account's data (review r6
// security #2, tests #4). Every place that data lives counts: the three IndexedDB stores, the failed-sync queue read raw (an
// unreadable queue is data), the delete and hold queues, the clear stashes and a form's held paths; any error counts as
// data (the guard then refuses rather than let another account in). Per-browser settings do not count.
// Written first: before the change these tests fail. Run: node scripts/test-has-local-data.mjs
import assert from "node:assert/strict";

const mem = new Map();
let broken = false;
globalThis.localStorage = {
  getItem: k => { if (broken) throw new Error("SecurityError"); return mem.has(k) ? mem.get(k) : null; },
  setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
  get length() { if (broken) throw new Error("SecurityError"); return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };
const S = await import("../src/lib/storage.js");

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); broken = false; await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};
const none = async () => 0;
const has = (opts) => S.hasLocalData(opts);

await test("an empty browser (settings only) holds no account data", async () => {
  for (const k of ["proximaai-theme", "proximaai-background", "proximaai-device-id", "proximaai-browser-id", "proximaai-tab-id",
    "proximaai-tabs", "proximaai-clock-offset", "proximaai-form-stamp", "proximaai-seen-restore", "proximaai-restore-known"]) mem.set(k, "x");
  mem.set("proximaai-failed-syncs", "[]");
  mem.set("proximaai-form-inputs:tab1", JSON.stringify({ at: 1, paths: [] }));
  assert.equal(await has({ storeCount: none }), false);
});

await test("each IndexedDB store with rows counts; a store that cannot be read counts", async () => {
  for (const store of ["tasks", "history", "favorites"]) {
    assert.equal(await has({ storeCount: async (s) => (s === store ? 1 : 0) }), true, store);
  }
  assert.equal(await has({ storeCount: async () => { throw new Error("idb blocked"); } }), true);
});

await test("each queue or record kept in localStorage counts when it holds anything", async () => {
  const keys = ["proximaai-failed-syncs", "proximaai-ws-deletes", "proximaai-file-deletes", "proximaai-held-purges-v3", "proximaai-held-purges-v2",
    "proximaai-held-purges", "proximaai-relinks", "proximaai-orphan-claimants", "proximaai-history-resync", "proximaai-released-predictions",
    "proximaai-final-confirms", "proximaai-confirmed-deletes", "proximaai-confirmed-queued", "proximaai-confirmed-seqs", "proximaai-assumed-confirms",
    "proximaai-flights", "proximaai-deletes-in-flight", "proximaai-voided-at", "proximaai-logs"];
  for (const k of keys) {
    mem.clear();
    mem.set(k, JSON.stringify([{ id: "x" }]));
    assert.equal(await has({ storeCount: none }), true, k);
  }
  mem.clear(); mem.set("proximaai-clear-stash:123", JSON.stringify({ tasks: [] }));
  assert.equal(await has({ storeCount: none }), true, "a clear stash");
  mem.clear(); mem.set("proximaai-form-inputs:tab9", JSON.stringify({ at: 1, paths: ["uploads/x/a.png"] }));
  assert.equal(await has({ storeCount: none }), true, "a form's held paths");
  mem.clear(); mem.set("proximaai-provider-keys:user:x", JSON.stringify({ kie: "••••abcd" }));
  assert.equal(await has({ storeCount: none }), true, "an account's cached key fingerprints");
});

await test("an unreadable queue counts (the failed-sync queue is read raw, not through its forgiving reader)", async () => {
  mem.set("proximaai-failed-syncs", "{not json");
  assert.equal(await has({ storeCount: none }), true);
  mem.clear(); mem.set("proximaai-form-inputs:tab1", "{not json");
  assert.equal(await has({ storeCount: none }), true);
});

await test("localStorage that cannot be read counts", async () => {
  broken = true;
  assert.equal(await has({ storeCount: none }), true);
});

// Review r7 (security #4): data of the pre-rename 'prism' database is imported at the first load after sign-in
// (migrateFromLocalStorage); it is imported first here, so it counts like any other. An import that fails counts as data.
await test("the old 'prism' data is imported first, so it counts; a failing import counts as data", async () => {
  const order = [];
  const r = await has({ migrate: async () => { order.push("migrate"); }, storeCount: async (s) => { order.push(s); return s === "history" ? 2 : 0; } });
  assert.equal(r, true);
  assert.deepEqual(order.slice(0, 2), ["migrate", "tasks"], "imported before the stores are counted");
  assert.equal(await has({ migrate: async () => { throw new Error("prism blocked"); }, storeCount: none }), true);
});

// Review r7 (tests #1): the default store count (Node has no IndexedDB, so the defaults are checked in the source, comments
// stripped): it counts each store through the same tx() the rest of storage.js uses, and imports through the real migration.
await test("the defaults: storeRows counts through tx(); migrate is the real migration", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/storage.js", import.meta.url), "utf8").replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/gm, "$1");
  assert.match(src, /const storeRows = async \(name\) => wrapRequest\(\(await tx\(name\)\)\.count\(\)\);/);
  assert.match(src, /export async function hasLocalData\(\{ storeCount = storeRows, migrate = migrateFromLocalStorage \} = \{\}\) \{/);
  assert.match(src, /for \(const name of \["tasks", "history", "favorites"\]\) if \(await storeCount\(name\)\) return true;\s*return false;\s*\} catch \{ return true; \}/);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
