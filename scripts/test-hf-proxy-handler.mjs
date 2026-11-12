// api/higgsfield-proxy.ts end to end test suite (with fetch stubbed).
// Verifies session verification, per-account Vault key retrieval, endpoint whitelisting,
// header formatting (`Authorization: Key <id>:<secret>`), missing key error shape, and status/delete routing.
// Run via: node scripts/test-hf-proxy-handler.mjs

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.SESSION_SIGNING_KEY = "test-signing-key-hex-text";
process.env.SUPABASE_URL = "https://sb.example";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
const { default: handler } = await import("../api/higgsfield-proxy.ts");

const token = (sub = "u:00000000-0000-0000-0000-000000000001", exp = Math.floor(Date.now() / 1000) + 3600, key = process.env.SESSION_SIGNING_KEY) =>
  `${sub}.${exp}.${createHmac("sha256", key).update(`${sub}.${exp}`).digest("hex")}`;

let calls = [];
const HF_TEST_KEY = "7463fb77-5ce2-4552-bda6-37e96b837fcc:e9dd8f992eb8373f7eb1da5b33471dfab4258081325516640350c21e22fed13b";
let rpc = () => new Response(JSON.stringify(HF_TEST_KEY), { status: 200 });
let hf = () => new Response(JSON.stringify({ status: "queued", request_id: "req_123" }), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return String(url).startsWith("https://sb.example/") ? rpc(url, init) : hf(url, init);
};

const req = (path, { method = "POST", body, tok = token(), qs = "" } = {}) =>
  new Request(`https://app.example/api/higgsfield-proxy?p=${encodeURIComponent(path)}${qs}`, {
    method, body, headers: { "content-type": "application/json", ...(tok ? { "x-proxima-session": tok } : {}), origin: "https://proxima-ai-seven.vercel.app" },
  });

let n = 0, failed = 0;
const test = async (name, fn) => {
  calls = [];
  rpc = () => new Response(JSON.stringify(HF_TEST_KEY), { status: 200 });
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | ")); }
};

const motionBody = JSON.stringify({
  video_url: "https://cdn.example.com/source.mp4",
  image_urls: ["https://cdn.example.com/char.png"],
  resolution: "720p"
});

await test("no token, bad signature, expired token: 401 session, nothing fetched", async () => {
  for (const tok of [null, token(undefined, undefined, "wrong-key"), token(undefined, Math.floor(Date.now() / 1000) - 5)]) {
    const r = await handler(req("higgsfield/genjutsu/motion-transfer/v1.0", { body: motionBody, tok }));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("x-proxima-auth"), "session");
  }
  assert.equal(calls.length, 0);
});

await test("refused / unwhitelisted call: 404, never reads key", async () => {
  const r = await handler(req("v1/chat/completions", { body: "{}" }));
  assert.equal(r.status, 404);
  assert.equal(calls.length, 0);
});

await test("Motion Transfer: key read, sent with 'Authorization: Key ...', response passed through", async () => {
  const tok = token();
  const r = await handler(req("higgsfield/genjutsu/motion-transfer/v1.0", { body: motionBody, tok }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "queued", request_id: "req_123" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://sb.example/rest/v1/rpc/get_provider_key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_session_token: tok, p_provider: "higgsfield" });
  assert.equal(calls[1].url, "https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0");
  assert.equal(calls[1].init.headers.authorization, `Key ${HF_TEST_KEY}`);
});

await test("Restyle Presets GET: forwarded without body", async () => {
  hf = () => new Response(JSON.stringify({ presets: [{ id: "p1", name: "Anime" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const r = await handler(req("models/higgsfield/genjutsu/restyle/v1.0/presets", { method: "GET" }));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.presets[0].id, "p1");
  assert.equal(calls[1].url, "https://api.higgsfield.ai/models/higgsfield/genjutsu/restyle/v1.0/presets");
});

await test("Status polling GET requests/:id/status: routed properly", async () => {
  hf = () => new Response(JSON.stringify({ status: "completed", video: { url: "https://cdn.example.com/out.mp4" } }), { status: 200, headers: { "content-type": "application/json" } });
  const r = await handler(req("requests/req_123/status", { method: "GET" }));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.status, "completed");
  assert.equal(calls[1].url, "https://api.higgsfield.ai/requests/req_123/status");
});

await test("DELETE requests/:id: forwards deletion with Key authorization", async () => {
  hf = () => new Response(JSON.stringify({ status: "deleted" }), { status: 200, headers: { "content-type": "application/json" } });
  const r = await handler(req("requests/req_123", { method: "DELETE" }));
  assert.equal(r.status, 200);
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[1].url, "https://api.higgsfield.ai/requests/req_123");
  assert.equal(calls[1].init.headers.authorization, `Key ${HF_TEST_KEY}`);
});

await test("missing key: answers 400 with NO_PROVIDER_KEY error", async () => {
  rpc = () => new Response(JSON.stringify(null), { status: 200 });
  const r = await handler(req("requests/req_123/status", { method: "GET" }));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("x-proxima-auth"), "no-key");
  const data = await r.json();
  assert.equal(data.error, "NO_PROVIDER_KEY");
});

await test("database session revocation: answers 401 with session auth header", async () => {
  rpc = () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
  const r = await handler(req("requests/req_123/status", { method: "GET" }));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("x-proxima-auth"), "session");
});

if (failed > 0) {
  console.error(`\nFAILED: ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\nAll ${n} test(s) passed cleanly`);
}
