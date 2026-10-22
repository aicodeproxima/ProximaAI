// Tests for src/lib/session.js withSessionHeader — every Supabase data request carries the signed-in session token, which
// the database policies check (migrations 20261022100000 + 20261022120000). Run: node scripts/test-session-header.mjs
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { setSession, clearSession, withSessionHeader, SESSION_HEADER } = await import("../src/lib/session.js");

const BASE = "https://x.supabase.co";
const EXP = Math.floor(Date.now() / 1000) + 3600;
const calls = [];
const base = async (input, init) => { calls.push({ input, init }); return new Response("{}", { status: 200 }); };
const wrapped = withSessionHeader(base, { baseUrl: BASE + "/" });
const sbInit = (extra = {}) => ({ method: "POST", body: "{\"id\":\"t1\"}",
  headers: new Headers({ apikey: "pk", Authorization: "Bearer pk", "Content-Type": "application/json", "X-Client-Info": "postgrest-js/0.0.0-automated", ...extra }) });
const hdr = (i) => new Headers(calls[i].init?.headers);

let n = 0, failed = 0;
const test = async (name, fn) => {
  store.clear(); calls.length = 0;
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", e.message.split("\n")[0]); }
};

await test("signed in: REST requests carry the token; the request is otherwise unchanged", async () => {
  setSession({ token: "tok-1", expires_at: EXP, username: "owner" });
  await wrapped(`${BASE}/rest/v1/tasks?select=id`, sbInit());
  assert.equal(SESSION_HEADER, "x-proxima-session");
  assert.equal(hdr(0).get("x-proxima-session"), "tok-1");
  assert.equal(hdr(0).get("apikey"), "pk");
  assert.equal(hdr(0).get("authorization"), "Bearer pk");
  assert.equal(hdr(0).get("content-type"), "application/json");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "{\"id\":\"t1\"}");
  assert.equal(calls[0].input, `${BASE}/rest/v1/tasks?select=id`);
});

await test("signed in: Storage requests carry the token, and a file body is passed by reference (50 MB never copied)", async () => {
  setSession({ token: "tok-1", expires_at: EXP, username: "owner" });
  const file = new Blob(["x".repeat(16)], { type: "video/mp4" });
  await wrapped(`${BASE}/storage/v1/object/generations/uploads/u/a.mp4`, { method: "POST", body: file, headers: { apikey: "pk" } });
  assert.equal(hdr(0).get("x-proxima-session"), "tok-1");
  assert.equal(calls[0].init.body, file);
});

await test("x-client-info keeps its value and gains the marker the edge logs show: sess/1 signed in, sess/0 out", async () => {
  setSession({ token: "tok-1", expires_at: EXP, username: "owner" });
  await wrapped(`${BASE}/rest/v1/tasks`, sbInit());
  assert.equal(hdr(0).get("x-client-info"), "postgrest-js/0.0.0-automated proxima-rls/1 sess/1");
  await wrapped(`${BASE}/storage/v1/object/list/generations`, { method: "POST", headers: { apikey: "pk" } });
  assert.equal(hdr(1).get("x-client-info"), "proxima-rls/1 sess/1");
  clearSession();
  await wrapped(`${BASE}/rest/v1/rpc/verify_admin`, sbInit());
  assert.equal(hdr(2).get("x-client-info"), "postgrest-js/0.0.0-automated proxima-rls/1 sess/0");
});

await test("the token is read per request: sign-in, rename and sign-out apply at once", async () => {
  setSession({ token: "tok-1", expires_at: EXP, username: "owner" });
  await wrapped(`${BASE}/rest/v1/tasks`, sbInit());
  setSession({ token: "tok-2", expires_at: EXP, username: "renamed" });
  await wrapped(`${BASE}/rest/v1/tasks`, sbInit());
  clearSession();
  const r = await wrapped(`${BASE}/rest/v1/tasks`, sbInit());
  assert.equal(hdr(0).get("x-proxima-session"), "tok-1");
  assert.equal(hdr(1).get("x-proxima-session"), "tok-2");
  assert.equal(calls.length, 2, "signed out: the third request never reaches the network");
  assert.equal(r.status, 401);
});

await test("signed out: table and Storage calls are answered locally with 401 'session token missing'", async () => {
  for (const url of [`${BASE}/rest/v1/tasks?id=in.(a)`, `${BASE}/storage/v1/object/generations`, `${BASE}/storage/v1/object/list/generations`]) {
    const r = await wrapped(url, sbInit());
    assert.equal(r.status, 401, url);
    const body = await r.json();
    assert.equal(body.message, "session token missing");
  }
  assert.equal(calls.length, 0);
});

await test("an expired session in localStorage counts as signed out", async () => {
  setSession({ token: "old", expires_at: Math.floor(Date.now() / 1000) - 5, username: "owner" });
  const r = await wrapped(`${BASE}/rest/v1/history`, sbInit());
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

await test("signed out: RPCs still go out (sign-in and unlock run before a session exists), without a session header", async () => {
  await wrapped(`${BASE}/rest/v1/rpc/verify_admin`, sbInit());
  await wrapped(`${BASE}/rest/v1/rpc/unlock_admin_with_backup_code`, sbInit());
  assert.equal(calls.length, 2);
  assert.equal(hdr(0).get("x-proxima-session"), null);
});

await test("a caller's session header is replaced by the current token, and removed when signed out", async () => {
  setSession({ token: "tok-1", expires_at: EXP, username: "owner" });
  await wrapped(`${BASE}/rest/v1/tasks`, sbInit({ "x-proxima-session": "stale" }));
  assert.equal(hdr(0).get("x-proxima-session"), "tok-1");
  clearSession();
  await wrapped(`${BASE}/rest/v1/rpc/verify_admin`, sbInit({ "x-proxima-session": "stale" }));
  assert.equal(hdr(1).get("x-proxima-session"), null);
});

await test("Auth and other hosts are untouched: same init object, no token, no marker", async () => {
  setSession({ token: "tok-1", expires_at: EXP, username: "owner" });
  const init1 = sbInit(), init2 = sbInit(), init3 = sbInit();
  await wrapped(`${BASE}/auth/v1/otp`, init1);
  await wrapped("https://other.host/rest/v1/tasks", init2);
  await wrapped(`${BASE}/realtime/v1/api/broadcast`, init3);
  assert.equal(calls[0].init, init1);
  assert.equal(calls[1].init, init2);
  assert.equal(calls[2].init, init3);
  assert.equal(hdr(0).get("x-proxima-session"), null);
});

await test("a Request input without init keeps its own headers", async () => {
  setSession({ token: "tok-1", expires_at: EXP, username: "owner" });
  await wrapped(new Request(`${BASE}/rest/v1/tasks`, { headers: { apikey: "pk" } }));
  assert.equal(hdr(0).get("apikey"), "pk");
  assert.equal(hdr(0).get("x-proxima-session"), "tok-1");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
