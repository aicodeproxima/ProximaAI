// api/kie-proxy.ts end to end, with fetch stubbed (node 24 strips the types). Checks the order that keeps keys safe: no
// valid session → 401 and no key lookup; a refused call → no key lookup; the key goes only to api.kie.ai as a bearer;
// the database's session refusal → 401; no key → 400 no-key; lookup failure → 503.
// Run: node scripts/test-kie-proxy-handler.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.SESSION_SIGNING_KEY = "test-signing-key-hex-text";
process.env.SUPABASE_URL = "https://sb.example";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
const { default: handler } = await import("../api/kie-proxy.ts");

const token = (sub = "u:00000000-0000-0000-0000-000000000001", exp = Math.floor(Date.now() / 1000) + 3600, key = process.env.SESSION_SIGNING_KEY) =>
  `${sub}.${exp}.${createHmac("sha256", key).update(`${sub}.${exp}`).digest("hex")}`;
let calls = [];
let rpc = () => new Response(JSON.stringify("kie-secret-0123456789"), { status: 200 });
let kie = () => new Response(JSON.stringify({ code: 200, msg: "success", data: { taskId: "t1" } }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return String(url).startsWith("https://sb.example/") ? rpc(url, init) : kie(url, init);
};
const req = (path, { method = "POST", body, tok = token(), qs = "" } = {}) =>
  new Request(`https://app.example/api/kie-proxy?p=${encodeURIComponent(path)}${qs}`, {
    method, body, headers: { "content-type": "application/json", ...(tok ? { "x-proxima-session": tok } : {}), origin: "https://proxima-ai-seven.vercel.app" },
  });

let n = 0, failed = 0;
const test = async (name, fn) => {
  calls = [];
  rpc = () => new Response(JSON.stringify("kie-secret-0123456789"), { status: 200 });
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};
const body = JSON.stringify({ model: "nano-banana-pro", input: { prompt: "a cat" }, callBackUrl: "https://evil.example/h" });

await test("no token, a bad signature, an expired token: 401 session, nothing fetched", async () => {
  for (const tok of [null, token(undefined, undefined, "wrong-key"), token(undefined, Math.floor(Date.now() / 1000) - 5)]) {
    const r = await handler(req("api/v1/jobs/createTask", { body, tok }));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("x-proxima-auth"), "session");
  }
  assert.equal(calls.length, 0);
});

await test("a refused call (chat completions) never reads the key", async () => {
  const r = await handler(req("api/v1/chat/completions", { body: "{}" }));
  assert.equal(r.status, 404);
  assert.equal(calls.length, 0);
});

await test("createTask: key read for this token, sent only to api.kie.ai as bearer, callBackUrl stripped, answer passed through", async () => {
  const tok = token();
  const r = await handler(req("api/v1/jobs/createTask", { body, tok }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { code: 200, msg: "success", data: { taskId: "t1" } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://sb.example/rest/v1/rpc/get_provider_key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_session_token: tok, p_provider: "kie" });
  assert.equal(calls[1].url, "https://api.kie.ai/api/v1/jobs/createTask");
  assert.equal(calls[1].init.headers.authorization, "Bearer kie-secret-0123456789");
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: "nano-banana-pro", input: { prompt: "a cat" } });
  assert.equal(r.headers.get("access-control-allow-origin"), "https://proxima-ai-seven.vercel.app");
});

await test("recordInfo is a GET with only taskId", async () => {
  const r = await handler(req("api/v1/jobs/recordInfo", { method: "GET", qs: "&taskId=t1&x=1" }));
  assert.equal(r.status, 200);
  assert.equal(calls[1].url, "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=t1");
  assert.equal(calls[1].init.method, "GET");
});

await test("the database refuses the session (revoked): 401 session, kie.ai never called", async () => {
  rpc = () => new Response(JSON.stringify({ message: "session token revoked" }), { status: 400 });
  const r = await handler(req("api/v1/chat/credit", { method: "GET" }));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("x-proxima-auth"), "session");
  assert.equal(calls.length, 1);
});

await test("no kie.ai key saved: 400 no-key", async () => {
  rpc = () => new Response("null", { status: 200 });
  const r = await handler(req("api/v1/chat/credit", { method: "GET" }));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("x-proxima-auth"), "no-key");
  assert.equal(calls.length, 1);
});

await test("key lookup failure: 503, kie.ai never called", async () => {
  rpc = () => { throw new Error("network"); };
  const r = await handler(req("api/v1/chat/credit", { method: "GET" }));
  assert.equal(r.status, 503);
  assert.equal(calls.length, 1);
});

await test("kie.ai unreachable: 502", async () => {
  const keep = kie;
  kie = () => { throw new Error("down"); };
  try {
    const r = await handler(req("api/v1/chat/credit", { method: "GET" }));
    assert.equal(r.status, 502);
  } finally { kie = keep; }
});

await test("a disallowed origin gets the production origin back, not its own", async () => {
  const r = await handler(new Request("https://app.example/api/kie-proxy?p=api/v1/chat/credit", { method: "GET", headers: { "x-proxima-session": token(), origin: "https://evil.example" } }));
  assert.equal(r.headers.get("access-control-allow-origin"), "https://proxima-ai-seven.vercel.app");
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
