// storage.js migrateFromLocalStorage, the one-time import of the pre-rename 'prism' data, and hasLocalData, which runs it
// first (second account S5). Review r8 (security #2, tests #9): the import swallowed every error, so a failed step still
// deleted the old database (its data lost) and marked the browser as imported, and hasLocalData's "a failed import counts
// as data" could never happen. Now: true when done (or nothing to do), false when a step failed; then nothing old is
// deleted, the browser is not marked, and hasLocalData counts it as data.
// Runs the real storage.js on a small in-memory IndexedDB whose open, reads and writes can be made to fail.
// Written first: before the change these tests fail. Run: node scripts/test-prism-import.mjs
import assert from "node:assert/strict";

const mem = new Map();
let blocked = false;
globalThis.localStorage = {
  getItem: k => { if (blocked) throw new Error("SecurityError"); return mem.has(k) ? mem.get(k) : null; },
  setItem: (k, v) => { if (blocked) throw new Error("SecurityError"); mem.set(k, String(v)); },
  removeItem: k => mem.delete(k),
  get length() { if (blocked) throw new Error("SecurityError"); return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
const sess = new Map();
globalThis.sessionStorage = { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) };

// ─── in-memory IndexedDB ───
const dbs = new Map();          // name -> { version, stores: Map(store -> { keyPath, rows: Map }) }
const fail = { open: new Set(), read: new Set(), write: new Set() };   // db names; "db/store" for reads and writes
let opens = 0;
const later = (fn) => setTimeout(fn, 0);
function makeStore(dbName, rec, name, txnState) {
  const s = rec.stores.get(name);
  const req = (fn, failing) => { const r = {}; later(() => { if (failing) { r.error = new Error("UnknownError"); txnState.failed = r.error; r.onerror?.(); } else { r.result = fn(); r.onsuccess?.(); } }); return r; };
  return {
    getAll: () => req(() => [...s.rows.values()], fail.read.has(`${dbName}/${name}`)),
    count: () => req(() => s.rows.size, fail.read.has(`${dbName}/${name}`)),
    get: (k) => req(() => s.rows.get(k), fail.read.has(`${dbName}/${name}`)),
    put: (v) => req(() => { s.rows.set(v[s.keyPath], v); return v[s.keyPath]; }, fail.write.has(`${dbName}/${name}`)),
    delete: (k) => req(() => { s.rows.delete(k); }, fail.write.has(`${dbName}/${name}`)),
    clear: () => req(() => { s.rows.clear(); }, fail.write.has(`${dbName}/${name}`)),
    indexNames: { contains: () => true }, createIndex() {},
  };
}
function makeDb(name) {
  const rec = dbs.get(name);
  return {
    objectStoreNames: { contains: (s) => rec.stores.has(s) },
    transaction(names, mode = "readonly") {
      const state = { failed: null };
      const txn = { mode, error: null, oncomplete: null, onerror: null, onabort: null };
      txn.objectStore = (s) => makeStore(name, rec, s, state);
      later(() => later(() => { if (state.failed) { txn.error = state.failed; txn.onerror?.(); txn.onabort?.(); } else txn.oncomplete?.(); }));
      return txn;
    },
    close() {}, set onclose(_) {},
  };
}
const fakeIDB = {
  open(name, version) {
    opens++;
    const r = {};
    later(() => {
      if (fail.open.has(name)) { r.error = new Error("UnknownError"); r.onerror?.(); return; }
      if (!dbs.has(name)) {
        dbs.set(name, { version: 0, stores: new Map() });
        let aborted = false;
        r.result = makeDb(name);
        r.transaction = { abort() { aborted = true; } };
        r.onupgradeneeded?.({ target: r, currentTarget: r });
        if (aborted) { dbs.delete(name); r.error = new Error("AbortError"); r.onerror?.(); return; }
        dbs.get(name).version = version;
      }
      r.result = makeDb(name);
      r.onsuccess?.();
    });
    return r;
  },
  deleteDatabase(name) { dbs.delete(name); return {}; },
};
globalThis.window = { indexedDB: fakeIDB };
globalThis.indexedDB = fakeIDB;

const STORES = { settings: "key", history: "id", favorites: "id", presets: "modelId", tasks: "id" };
const newDb = () => ({ version: 3, stores: new Map(Object.entries(STORES).map(([n, k]) => [n, { keyPath: k, rows: new Map() }])) });
dbs.set("proximaai", newDb());
const prism = (rows) => {
  const rec = { version: 2, stores: new Map() };
  for (const [n, list] of Object.entries(rows)) rec.stores.set(n, { keyPath: STORES[n], rows: new Map(list.map(v => [v[STORES[n]], v])) });
  dbs.set("prism", rec);
};
const rowsOf = (db, store) => [...(dbs.get(db)?.stores.get(store)?.rows.values() || [])];

const S = await import("../src/lib/storage.js");

let n = 0, failed = 0;
const test = async (name, fn) => {
  mem.clear(); sess.clear(); blocked = false; opens = 0;
  for (const set of Object.values(fail)) set.clear();
  dbs.delete("prism");
  for (const s of dbs.get("proximaai").stores.values()) s.rows.clear();
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

await test("nothing old: done, marked, and an empty browser holds no account data", async () => {
  assert.equal(await S.migrateFromLocalStorage(), true);
  assert.equal(mem.get("proximaai-migrated"), "1");
  assert.equal(dbs.has("prism"), false, "no empty 'prism' database is left behind");
  assert.equal(await S.hasLocalData(), false);
});

await test("old data is imported, the old database deleted, the browser marked; it then counts as data", async () => {
  prism({ tasks: [{ id: "t1" }], history: [{ id: "h1" }], settings: [{ key: "theme", value: "dark" }] });
  assert.equal(await S.migrateFromLocalStorage(), true);
  assert.deepEqual(rowsOf("proximaai", "tasks").map(t => t.id), ["t1"]);
  assert.deepEqual(rowsOf("proximaai", "history").map(t => t.id), ["h1"]);
  assert.equal(dbs.has("prism"), false, "deleted after the import");
  assert.equal(mem.get("proximaai-migrated"), "1");
  assert.equal(await S.hasLocalData(), true);
});

await test("the old database cannot be opened: not done, not marked, and hasLocalData counts it (r8 #9)", async () => {
  prism({ tasks: [{ id: "t1" }] });
  fail.open.add("prism");
  assert.equal(await S.migrateFromLocalStorage(), false);
  assert.equal(mem.get("proximaai-migrated"), undefined, "tried again next time");
  assert.equal(dbs.has("prism"), true);
  assert.equal(await S.hasLocalData(), true, "fail closed with the real import");
});

await test("writing the new database fails: the old data is kept (not deleted), not marked; a later run imports it", async () => {
  prism({ tasks: [{ id: "t1" }, { id: "t2" }], history: [{ id: "h1" }] });
  fail.write.add("proximaai/tasks");
  assert.equal(await S.migrateFromLocalStorage(), false);
  assert.equal(dbs.has("prism"), true, "the only copy is not deleted");
  assert.equal(rowsOf("prism", "tasks").length, 2);
  assert.equal(mem.get("proximaai-migrated"), undefined);
  assert.equal(await S.hasLocalData(), true);
  fail.write.clear();
  assert.equal(await S.migrateFromLocalStorage(), true);
  assert.deepEqual(rowsOf("proximaai", "tasks").map(t => t.id).sort(), ["t1", "t2"]);
  assert.equal(dbs.has("prism"), false);
});

await test("reading an old store fails: nothing deleted, not marked", async () => {
  prism({ tasks: [{ id: "t1" }], history: [{ id: "h1" }] });
  fail.read.add("prism/history");
  assert.equal(await S.migrateFromLocalStorage(), false);
  assert.equal(dbs.has("prism"), true);
  assert.equal(mem.get("proximaai-migrated"), undefined);
});

await test("old logs in localStorage that cannot be written are kept for the next run", async () => {
  mem.set("prism-logs", JSON.stringify([{ id: "L1" }]));
  fail.write.add("proximaai/history");
  assert.equal(await S.migrateFromLocalStorage(), false);
  assert.ok(mem.has("prism-logs"), "kept");
  assert.equal(mem.get("proximaai-migrated"), undefined);
  assert.equal(await S.hasLocalData(), true);
  fail.write.clear();
  assert.equal(await S.migrateFromLocalStorage(), true);
  assert.deepEqual(rowsOf("proximaai", "history").map(h => h.id), ["L1"]);
  assert.ok(!mem.has("prism-logs"));
});

await test("already imported: true at once, no database opened", async () => {
  mem.set("proximaai-migrated", "1");
  prism({ tasks: [{ id: "t1" }] });
  assert.equal(await S.migrateFromLocalStorage(), true);
  assert.equal(opens, 0);
  assert.equal(dbs.has("prism"), true, "an old database left by someone else is not touched");
});

await test("storage that cannot be read: answers false instead of throwing", async () => {
  blocked = true;
  assert.equal(await S.migrateFromLocalStorage(), false);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);   // storage.js keeps a BroadcastChannel open when window is defined
