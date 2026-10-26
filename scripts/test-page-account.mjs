// Second account S5, review r8 (#1/#4/#6/#14): the account a page signed in as. session.js remembers it
// (bindPageAccount); while it is set, a session in storage that names ANOTHER account (another tab signed in as someone
// else, or a claim race) is never sent from this page: sessionToken() reads it as none, the data fetch answers 401 locally,
// a refusal never clears that other account's session, and the page is told to leave (onForeignSession).
// accountGuard.js pageMustLeave decides, on a storage event or the 60-second check, whether a signed-in page must leave.
// Written first: before the change these tests fail. Run: node scripts/test-page-account.mjs
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
};
const X = "11111111-2222-4333-8444-555555555555", Y = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const tok = (id, n = 1) => `u:${id}.${Math.floor(Date.now() / 1000) + 3600}.sig${n}`;
const store = (token) => mem.set("proximaai-session", JSON.stringify({ token, expires_at: Math.floor(Date.now() / 1000) + 3600, username: "n" }));

let Sx = {}, G = {};
try { Sx = await import("../src/lib/session.js"); } catch (e) { console.log("session.js import failed:", e.message); }
try { G = await import("../src/lib/accountGuard.js"); } catch {}
const tick = () => new Promise(r => setTimeout(r, 0));

let n = 0, failed = 0;
const test = async (name, fn) => {
  mem.clear();
  try { Sx.bindPageAccount?.(null); Sx.onForeignSession?.(null); Sx.onSessionExpired?.(null); } catch {}
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

await test("unbound (signed out, or before the account is confirmed): the stored token is used as before", () => {
  store(tok(X));
  assert.equal(Sx.pageAccountId(), null);
  assert.equal(Sx.sessionToken(), tok(X));
});

await test("bound to its own account: its token is used, a renewed or renamed token of the same account too", () => {
  Sx.bindPageAccount(X);
  store(tok(X));
  assert.equal(Sx.sessionToken(), tok(X));
  store(tok(X, 2));
  assert.equal(Sx.sessionToken(), tok(X, 2));
  Sx.bindPageAccount(X.toUpperCase());
  assert.equal(Sx.pageAccountId(), X, "kept lower-case");
  assert.equal(Sx.sessionToken(), tok(X, 2));
});

await test("another account's session in storage: never handed out by this page, which is told to leave", async () => {
  let left = 0;
  Sx.onForeignSession(() => { left++; });
  Sx.bindPageAccount(X);
  store(tok(Y));
  assert.equal(Sx.sessionToken(), null);
  await tick();
  assert.ok(left >= 1, "leave asked");
  assert.equal(JSON.parse(mem.get("proximaai-session")).token, tok(Y), "the other account's session is left alone");
});

await test("the data fetch sends no other account's token: a table call is answered 401 here, an RPC carries none", async () => {
  Sx.bindPageAccount(X);
  store(tok(Y));
  const sent = [];
  const f = Sx.withSessionHeader(async (input, init) => { sent.push(new Headers(init?.headers)); return new Response("[]"); }, { baseUrl: "https://db.test" });
  const r = await f("https://db.test/rest/v1/tasks?select=id", {});
  assert.equal(r.status, 401);
  assert.equal(sent.length, 0, "nothing left the page");
  await f("https://db.test/rest/v1/rpc/get_my_account", { headers: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].get("x-proxima-session"), null);
  store(tok(X));
  await f("https://db.test/rest/v1/tasks?select=id", {});
  assert.equal(sent[1].get("x-proxima-session"), tok(X), "its own token goes out");
});

await test("a refusal while another account's session is stored never clears it; the page leaves instead", async () => {
  let expired = 0, left = 0;
  Sx.onSessionExpired(() => { expired++; });
  Sx.onForeignSession(() => { left++; });
  Sx.bindPageAccount(X);
  store(tok(Y));
  Sx.reportSessionExpired(tok(X));
  await tick();
  assert.ok(mem.has("proximaai-session"), "not cleared");
  assert.equal(expired, 0, "this page is not 'expired': it is on another account's session");
  assert.ok(left >= 1);
});

await test("its own session refused: cleared and reported as before", () => {
  let expired = 0;
  Sx.onSessionExpired(() => { expired++; });
  Sx.bindPageAccount(X);
  store(tok(X));
  Sx.reportSessionExpired(tok(X));
  assert.equal(mem.has("proximaai-session"), false);
  assert.equal(expired, 1);
});

await test("unbinding (sign-out) restores the plain behaviour", () => {
  Sx.bindPageAccount(X);
  store(tok(Y));
  assert.equal(Sx.sessionToken(), null);
  Sx.bindPageAccount(null);
  assert.equal(Sx.sessionToken(), tok(Y));
});

await test("pageMustLeave: only a signed-in page; it leaves when signed out elsewhere, on another account's session, or off the record", () => {
  const rec = (id) => ({ id, username: "n" });
  const L = (o) => G.pageMustLeave({ authed: true, pageAccount: X, token: tok(X), stored: rec(X), ...o });
  assert.equal(L({}), false, "its own session, its own record");
  assert.equal(L({ authed: false, token: null }), false, "not signed in: nothing to leave");
  assert.equal(L({ token: null }), true, "signed out in another tab");
  assert.equal(L({ token: tok(Y), stored: rec(Y) }), true, "another account signed in and claimed: fits the record, but not this page (r8 #14, #4)");
  assert.equal(L({ token: tok(Y), stored: rec(X) }), true, "another account's session on this account's browser");
  assert.equal(L({ stored: rec(Y) }), true, "its session, but the browser is now another account's");
  assert.equal(L({ stored: { id: null, unreadable: true } }), true, "unreadable record");
  assert.equal(L({ stored: null }), false, "no record yet (claimed after the account check)");
  assert.equal(L({ pageAccount: null }), false, "not bound yet: the record decides");
  assert.equal(L({ pageAccount: null, stored: rec(Y) }), true);
  assert.equal(L({ pageAccount: X.toUpperCase() }), false, "case does not matter");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
