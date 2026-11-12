// api/ws-proxy.ts end-to-end tests with fetch stubbed (node 24 strips types).
// Verifies Phase 5 per-account provider key resolution, backwards compatibility for owner tokens,
// and the NO_PROVIDER_KEY error response.
// Run: node scripts/test-ws-proxy-handler.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.env.SESSION_SIGNING_KEY = "test-signing-key-hex-text";
process.env.SUPABASE_URL = "https://sb.example";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
delete process.env.UPSTASH_REDIS_REST_URL;

const { default: handler } = await import(pathToFileURL(`${repo}/api/ws-proxy.ts`).href);

const token = (sub = "u:00000000-0000-0000-0000-000000000001", exp = Math.floor(Date.now() / 1000) + 3600, key = process.env.SESSION_SIGNING_KEY) =>
  `${sub}.${exp}.${createHmac("sha256", key).update(`${sub}.${exp}`).digest("hex")}`;

let calls = [];
let rpc = (url, init) => new Response(JSON.stringify("ws-secret-key-123456"), { status: 200 });
let upstream = (url, init) => new Response(JSON.stringify({ code: 0, data: { id: "p1", status: "completed" } }), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).startsWith("https://sb.example/")) return rpc(url, init);
  return upstream(url, init);
};

const req = (path, { method = "POST", body, tok = token(), extra = "" } = {}) =>
  new Request(`https://proxima-ai-seven.vercel.app/api/ws-proxy?p=${encodeURIComponent(path)}${extra}`, {
    method,
    body: body !== undefined ? body : (method === "POST" ? JSON.stringify({ prompt: "a cute red panda" }) : undefined),
    headers: {
      "content-type": "application/json",
      ...(tok ? { "x-proxima-session": tok } : {}),
      origin: "https://proxima-ai-seven.vercel.app",
    },
  });

let n = 0, failed = 0;
const test = async (name, fn) => {
  calls = [];
  rpc = (url, init) => new Response(JSON.stringify("ws-secret-key-123456"), { status: 200 });
  try {
    await fn();
    n++;
    console.log("ok -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").slice(0, 3).join(" | "));
  }
};

await test("no token, bad signature, expired token: 401 session, nothing fetched", async () => {
  for (const tok of [null, token(undefined, undefined, "wrong-key"), token(undefined, Math.floor(Date.now() / 1000) - 10)]) {
    const r = await handler(req("api/v3/wavespeed-ai/z-image/turbo", { tok }));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("x-proxima-auth"), "session");
  }
  assert.equal(calls.length, 0);
});

await test("member token (u:<uuid>): resolves key via get_provider_key ('wavespeed') and forwards to upstream", async () => {
  const memberTok = token("u:a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  const r = await handler(req("api/v3/wavespeed-ai/z-image/turbo", { tok: memberTok }), { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { code: 0, data: { id: "p1", status: "completed" } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://sb.example/rest/v1/rpc/get_provider_key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_session_token: memberTok, p_provider: "wavespeed" });
  assert.equal(calls[1].url, "https://api.wavespeed.ai/api/v3/wavespeed-ai/z-image/turbo");
  assert.equal(calls[1].init.headers.get("authorization"), "Bearer ws-secret-key-123456");
});

await test("owner token (admin:<username>): maintains backwards compatibility and resolves key", async () => {
  const ownerTok = token("admin:StephJr101");
  const r = await handler(req("api/v3/balance", { method: "GET", tok: ownerTok }));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://sb.example/rest/v1/rpc/get_provider_key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_session_token: ownerTok, p_provider: "wavespeed" });
  assert.equal(calls[1].url, "https://api.wavespeed.ai/api/v3/balance");
  assert.equal(calls[1].init.headers.get("authorization"), "Bearer ws-secret-key-123456");
});

await test("no WaveSpeed key configured: HTTP 400 with NO_PROVIDER_KEY and X-Proxima-Auth: no-key", async () => {
  rpc = () => new Response("null", { status: 200 });
  const r = await handler(req("api/v3/wavespeed-ai/z-image/turbo"));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("x-proxima-auth"), "no-key");
  const data = await r.json();
  assert.deepEqual(data, {
    error: "NO_PROVIDER_KEY",
    message: "Please configure your WaveSpeed API key in Settings -> Providers.",
  });
  assert.equal(calls.length, 1);
});

await test("database session revocation / forbidden: 401 session", async () => {
  rpc = () => new Response(JSON.stringify({ message: "forbidden" }), { status: 400 });
  const r = await handler(req("api/v3/balance", { method: "GET" }));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("x-proxima-auth"), "session");
  assert.equal(calls.length, 1);
});

await test("fallback to get_my_wavespeed_key when get_provider_key returns 404 (pre-P5 db)", async () => {
  rpc = (url) => {
    if (String(url).endsWith("/get_provider_key")) return new Response("Not found", { status: 404 });
    if (String(url).endsWith("/get_my_wavespeed_key")) return new Response(JSON.stringify("fallback-key-999999"), { status: 200 });
    return new Response("error", { status: 500 });
  };
  const r = await handler(req("api/v3/balance", { method: "GET" }));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://sb.example/rest/v1/rpc/get_provider_key");
  assert.equal(calls[1].url, "https://sb.example/rest/v1/rpc/get_my_wavespeed_key");
  assert.equal(calls[2].url, "https://api.wavespeed.ai/api/v3/balance");
  assert.equal(calls[2].init.headers.get("authorization"), "Bearer fallback-key-999999");
});

await test("database error / network timeout: 503 retryable", async () => {
  rpc = () => { throw new Error("db down"); };
  const r = await handler(req("api/v3/balance", { method: "GET" }));
  assert.equal(r.status, 503);
  assert.equal(calls.length, 1);
});

await test("upstream WaveSpeed error: 502", async () => {
  const orig = upstream;
  upstream = () => { throw new Error("wavespeed unreachable"); };
  try {
    const r = await handler(req("api/v3/balance", { method: "GET" }));
    assert.equal(r.status, 502);
  } finally {
    upstream = orig;
  }
});

console.log(`\n${n} passed, ${failed} failed`);
if (failed) process.exit(1);
