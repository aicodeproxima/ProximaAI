// Tests for the clear/delete helpers in src/lib/supabase.js: each says whether the server confirmed the delete
// ({ ok, error }), so Clear / Reset can report honestly. Run: node scripts/test-remote-clears.mjs
import assert from "node:assert/strict";
import { loadSupabase, fakeClient } from "./lib/load-supabase.mjs";

const store = new Map([["proximaai-user", "owner"]]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
console.warn = () => {};
const sb = await loadSupabase();

const CASES = [
  ["clearTasksRemote", () => sb.clearTasksRemote(), "tasks", [["delete"], ["eq", "device_id", "user:owner"]]],
  ["clearHistoryRemote", () => sb.clearHistoryRemote(), "history", [["delete"], ["eq", "device_id", "user:owner"]]],
  ["clearSettingsRemote", () => sb.clearSettingsRemote(), "settings", [["delete"], ["eq", "device_id", "user:owner"]]],
  ["clearFavoritesRemote", () => sb.clearFavoritesRemote(), "favorites", [["delete"], ["eq", "device_id", "user:owner"]]],
  ["deleteTaskRemote", () => sb.deleteTaskRemote("t-1"), "tasks", [["delete"], ["eq", "id", "t-1"], ["eq", "device_id", "user:owner"]]],
];

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

for (const [name, call, table, ops] of CASES) {
  await test(`${name}: a confirmed delete of this scope's rows answers { ok: true }`, async () => {
    const c = fakeClient(); sb.__setClientForTests(c);
    assert.deepEqual(await call(), { ok: true });
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].table, table);
    assert.deepEqual(c.calls[0].ops, ops);
  });
  await test(`${name}: a refused delete (e.g. 403 session token missing) answers { ok: false, error }`, async () => {
    sb.__setClientForTests(fakeClient(() => ({ data: null, error: { message: "session token missing", code: "28000" } })));
    assert.deepEqual(await call(), { ok: false, error: "session token missing" });
  });
  await test(`${name}: a network failure answers { ok: false, error }`, async () => {
    sb.__setClientForTests(fakeClient(() => { throw new TypeError("Failed to fetch"); }));
    assert.deepEqual(await call(), { ok: false, error: "Failed to fetch" });
  });
  await test(`${name}: cloud configured but not started answers { ok: false } (nothing was deleted)`, async () => {
    sb.__setClientForTests(null);
    const r = await call();
    assert.equal(r.ok, false);
    assert.match(r.error, /not initialized/);
  });
}

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
