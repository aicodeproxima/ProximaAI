// Tests for the clears in src/lib/supabase.js. Every clear or delete of this account's rows is restore-checked on the
// server (clear_queued_rows / delete_queued_rows, review rounds 8 and 9). The plain scoped deletes (clearTasksRemote,
// clearHistoryRemote, clearSettingsRemote, clearFavoritesRemote, deleteTaskRemote) are gone: Reset's settings clear, the
// last one in use, deleted the restore marker and wiped a restore that landed after the checked clears.
// Run: node scripts/test-remote-clears.mjs
import assert from "node:assert/strict";
import { loadSupabase, fakeClient } from "./lib/load-supabase.mjs";

const store = new Map([["proximaai-user", "owner"]]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
console.warn = () => {};
const sb = await loadSupabase();
store.set("proximaai-session", JSON.stringify({ token: "tok", expires_at: Math.floor(Date.now() / 1000) + 3600, username: "owner" }));

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

await test("no unchecked bulk delete is exported any more", async () => {
  for (const name of ["clearTasksRemote", "clearHistoryRemote", "clearSettingsRemote", "clearFavoritesRemote", "deleteTaskRemote"]) {
    assert.equal(sb[name], undefined, name);
  }
});
// Review round 10 (F6): four separate restore-checked calls could be half-voided by a restore landing between them.
await test("Reset is ONE reset_queued_rows call at the reset's snapshot time, no REST delete", async () => {
  const c = fakeClient(); const seen = [];
  c.rpc = async (fn, args) => { seen.push([fn, args.p_queued_at]); return { data: { ok: true, voided: false, deleted: { history: 0, task: 0, settings: 1, favorites: 1 } }, error: null }; };
  sb.__setClientForTests(c);
  const r = await sb.resetQueuedRemote(42, ["t"], ["h"]);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [["reset_queued_rows", 42]]);
  assert.equal(c.calls.length, 0, "no REST delete");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
