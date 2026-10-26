// Second account S5 (minimal form): one account per browser (src/lib/accountGuard.js). Written first: before the module
// exists every test fails. Run: node scripts/test-account-guard.mjs
import assert from "node:assert/strict";

const mem = new Map();
let refuse = false;
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (refuse) throw new Error("QuotaExceededError"); mem.set(k, String(v)); },
  removeItem: k => mem.delete(k), get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
};
let G;
try { G = await import("../src/lib/accountGuard.js"); } catch { G = {}; }

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { mem.clear(); refuse = false; await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};
const owner = { id: "11111111-1111-1111-1111-111111111111", role: "owner", username: "StephJr101" };
const member = { id: "22222222-2222-2222-2222-222222222222", role: "member", username: "friend" };

await test("a fresh browser (no record, no data): any account may use it and claims it", () => {
  assert.deepEqual(G.browserAccountDecision({ stored: null, hasLocalData: false, account: member }), { ok: true, claim: true });
  assert.deepEqual(G.browserAccountDecision({ stored: null, hasLocalData: false, account: owner }), { ok: true, claim: true });
});

await test("a browser with local data and no record (made before members existed) is the owner's: a member is refused", () => {
  assert.deepEqual(G.browserAccountDecision({ stored: null, hasLocalData: true, account: owner }), { ok: true, claim: true });
  assert.deepEqual(G.browserAccountDecision({ stored: null, hasLocalData: true, account: member }), { ok: false, reason: "other-account", other: null });
});

await test("a recorded browser: its account may use it (a renamed one re-records), any other is refused by name", () => {
  const stored = { id: owner.id, username: owner.username };
  assert.deepEqual(G.browserAccountDecision({ stored, hasLocalData: true, account: owner }), { ok: true, claim: false });
  assert.deepEqual(G.browserAccountDecision({ stored, hasLocalData: false, account: { ...owner, username: "Renamed" } }), { ok: true, claim: true });
  assert.deepEqual(G.browserAccountDecision({ stored, hasLocalData: false, account: member }), { ok: false, reason: "other-account", other: "StephJr101" });
  // even with no local data left: the record decides (its data may be in queues the check does not see)
  assert.equal(G.browserAccountDecision({ stored: { id: member.id, username: "friend" }, hasLocalData: false, account: owner }).ok, false);
});

await test("no account from the server: refused", () => {
  assert.deepEqual(G.browserAccountDecision({ stored: null, hasLocalData: false, account: null }), { ok: false, reason: "unknown-account", other: null });
  assert.equal(G.browserAccountDecision({ stored: null, hasLocalData: false, account: { role: "owner" } }).ok, false);
});

await test("claimBrowser records the account and reads it back; a refused write answers false", () => {
  assert.equal(G.readBrowserAccount(), null);
  assert.equal(G.claimBrowser(member), true);
  assert.deepEqual(G.readBrowserAccount(), { id: member.id, username: "friend", role: "member" });
  mem.clear(); refuse = true;
  assert.equal(G.claimBrowser(owner), false);
  assert.equal(G.readBrowserAccount(), null);
});

// Review r6 (security #3): a record that exists but cannot be read is not "no record" (that would let the owner claim a
// browser holding a member's data): it refuses every account until the browser's site data is cleared.
await test("an unreadable record is not 'no record': it refuses sign-in, join and a restored session", () => {
  mem.set(G.BROWSER_ACCOUNT_KEY, "{not json");
  assert.deepEqual(G.readBrowserAccount(), { id: null, unreadable: true });
  mem.set(G.BROWSER_ACCOUNT_KEY, JSON.stringify({ username: "x" }));
  const stored = G.readBrowserAccount();
  assert.deepEqual(stored, { id: null, unreadable: true });
  assert.deepEqual(G.browserAccountDecision({ stored, hasLocalData: false, account: owner }), { ok: false, reason: "unreadable-record", other: null });
  assert.equal(G.freeForNewAccount({ stored, hasLocalData: false }), false);
  assert.equal(G.sessionFitsBrowser(`u:${owner.id}.1.s`, stored), false);
  assert.match(G.browserAccountMessage({ ok: false, reason: "unreadable-record" }), /clear this site's data/);
  mem.delete(G.BROWSER_ACCOUNT_KEY);
  assert.equal(G.readBrowserAccount(), null, "absent: none");
});

// Review r6 (security #1): at load, a session with no record is never trusted on sight: the app checks the account with
// the server before anything loads or syncs.
await test("bootSessionDecision: none, fit, check (no record yet) or refuse", () => {
  const s = (a) => ({ token: `u:${a.id}.1793028924.sig` });
  assert.equal(G.bootSessionDecision(null, null), "none");
  assert.equal(G.bootSessionDecision({ token: "" }, null), "none");
  assert.equal(G.bootSessionDecision(s(owner), null), "check");
  assert.equal(G.bootSessionDecision(s(owner), { id: owner.id, username: "StephJr101", role: "owner" }), "fit");
  assert.equal(G.bootSessionDecision(s(member), { id: owner.id, username: "StephJr101", role: "owner" }), "refuse");
  assert.equal(G.bootSessionDecision(s(owner), { id: null, unreadable: true }), "refuse");
});

await test("the refusal names the other account when known, and says what to do", () => {
  const m = G.browserAccountMessage({ ok: false, reason: "other-account", other: "StephJr101" });
  assert.match(m, /another account's generations \(StephJr101\)/);
  assert.match(m, /private window/);
  assert.match(G.browserAccountMessage({ ok: false, reason: "unknown-account" }), /Couldn't confirm your account/);
});

// Review r7 (security #1, tests #3): a claim is a compare-and-set (another tab may have claimed the browser for another
// account meanwhile), read back; storage that throws or drops writes, and a record with an empty id, never pass for a claim.
await test("claimBrowser: only an empty browser or the same account; read back; never over another account's record", () => {
  assert.equal(G.claimBrowser(owner), true);
  assert.equal(G.claimBrowser(member), false, "another account's record stays");
  assert.deepEqual(G.readBrowserAccount(), { id: owner.id, username: "StephJr101", role: "owner" });
  assert.equal(G.claimBrowser({ ...owner, username: "Renamed" }), true, "the same account may refresh its record");
  assert.equal(G.readBrowserAccount().username, "Renamed");
  mem.set(G.BROWSER_ACCOUNT_KEY, "{broken");
  assert.equal(G.claimBrowser(owner), false, "an unreadable record is never overwritten");
});
await test("storage edges: a write that is dropped, a read that throws, an empty id", () => {
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {};   // accepted, not stored
  try { assert.equal(G.claimBrowser(member), false); } finally { globalThis.localStorage.setItem = realSet; }
  const realGet = globalThis.localStorage.getItem;
  globalThis.localStorage.getItem = () => { throw new Error("SecurityError"); };
  try { assert.deepEqual(G.readBrowserAccount(), { id: null, unreadable: true }); } finally { globalThis.localStorage.getItem = realGet; }
  mem.set(G.BROWSER_ACCOUNT_KEY, JSON.stringify({ id: "" }));
  assert.deepEqual(G.readBrowserAccount(), { id: null, unreadable: true });
});

// The session restored at page load is checked against the record without a network call: a u:<uuid> token names its
// account. A session from before any record existed is the owner's (only one account existed then).
await test("tokenAccountId reads the account of a u: token; anything else has none", () => {
  assert.equal(G.tokenAccountId(`u:${member.id}.1793028924.abcdef`), member.id);
  assert.equal(G.tokenAccountId(`u:${member.id.toUpperCase()}.1.x`), member.id);
  assert.equal(G.tokenAccountId("admin:1793028924.abcdef"), null);
  assert.equal(G.tokenAccountId(""), null);
  assert.equal(G.tokenAccountId(null), null);
});
await test("sessionFitsBrowser: no record fits (claimed after the account check); a record fits only its own account", () => {
  const tok = (a) => `u:${a.id}.1793028924.sig`;
  assert.equal(G.sessionFitsBrowser(tok(member), null), true);
  assert.equal(G.sessionFitsBrowser(tok(member), { id: member.id, username: "friend", role: "member" }), true);
  assert.equal(G.sessionFitsBrowser(tok(member), { id: owner.id, username: "StephJr101", role: "owner" }), false);
  assert.equal(G.sessionFitsBrowser("admin:1.sig", { id: owner.id, username: "StephJr101", role: "owner" }), false, "no id: sign in again");
  assert.equal(G.sessionFitsBrowser(null, null), false);
});
await test("claimBrowser keeps the role (owner-only screens read it)", () => {
  assert.equal(G.claimBrowser({ ...owner }), true);
  assert.deepEqual(G.readBrowserAccount(), { id: owner.id, username: "StephJr101", role: "owner" });
});
await test("a browser free for a new account (join): no record and no local data", () => {
  assert.equal(G.freeForNewAccount({ stored: null, hasLocalData: false }), true);
  assert.equal(G.freeForNewAccount({ stored: null, hasLocalData: true }), false);
  assert.equal(G.freeForNewAccount({ stored: { id: owner.id }, hasLocalData: false }), false);
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
