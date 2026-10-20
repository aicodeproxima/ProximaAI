// Tests for src/lib/session.js — what a "session refused" answer does. Run: node scripts/test-session.mjs
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { setSession, getSession, reportSessionExpired, onSessionExpired } = await import("../src/lib/session.js");

const EXP = Math.floor(Date.now() / 1000) + 3600;
let n = 0, failed = 0, fired = 0;
onSessionExpired(() => { fired++; });
const test = (name, fn) => {
  store.clear(); fired = 0;
  try { fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

test("a late refusal for a token this device already replaced keeps the fresh session", () => {
  setSession({ token: "old", expires_at: EXP, username: "owner" });
  setSession({ token: "new", expires_at: EXP, username: "owner" }); // password change / rename swapped it
  reportSessionExpired("old");
  assert.equal(getSession()?.token, "new");
  assert.equal(store.get("proximaai-user"), "owner");
  assert.equal(fired, 0, "must not sign out");
});

test("a refusal for the current token signs this device out", () => {
  setSession({ token: "cur", expires_at: EXP, username: "owner" });
  reportSessionExpired("cur");
  assert.equal(getSession(), null);
  assert.equal(store.get("proximaai-user"), undefined);
  assert.equal(fired, 1);
});

test("a refusal with no token information signs out (no token was sent)", () => {
  setSession({ token: "cur", expires_at: EXP, username: "owner" });
  reportSessionExpired();
  assert.equal(getSession(), null);
  assert.equal(fired, 1);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
