// Smoke test of api/ws-proxy.ts itself (not just src/lib/wsWebhook.js): runs the real handler under Node 24 (type
// stripping) with a throwaway signing key, a locally minted 'admin:test' token and stubbed Supabase / WaveSpeed
// fetches, and prints what reached "upstream". No network, no secrets, no billing.
// Run: node scripts/smoke-ws-proxy.mjs   Expected: submits carry standard_webhook only once WAVESPEED_WEBHOOK_SECRET is
// set; client webhook params never pass; history / polls / balance carry none; ?, #, .. in the path answer 400.
import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
const repo = process.argv[2] || fileURLToPath(new URL("..", import.meta.url));
const signKey = randomBytes(16).toString("hex");
Object.assign(process.env, { SESSION_SIGNING_KEY: signKey, SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "svc" });
delete process.env.UPSTASH_REDIS_REST_URL;
const exp = Math.floor(Date.now() / 1000) + 120;
const token = `admin:test.${exp}.` + createHmac("sha256", signKey).update(`admin:test.${exp}`).digest("hex");
const up = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("/rpc/get_my_wavespeed_key")) return new Response(JSON.stringify("ws-test-key-123456"), { status: 200 });
  up.push({ url: String(url), method: init.method, body: init.body ? new TextDecoder().decode(init.body) : null });
  return new Response(JSON.stringify({ data: { id: "p1" } }), { status: 200, headers: { "content-type": "application/json" } });
};
console.warn = () => {};
const { default: proxy } = await import(pathToFileURL(`${repo}/api/ws-proxy.ts`).href);
const call = async (p, { method = "POST", body, extra = "" } = {}) => {
  const res = await proxy(new Request(`https://proxima-ai-seven.vercel.app/api/ws-proxy?p=${p}${extra}`, { method, headers: { "x-proxima-session": token, "content-type": "application/json" }, body }), { waitUntil() {} });
  const u = up.at(-1); const url = new URL(u.url);
  return { status: res.status, path: url.pathname, query: Object.fromEntries(url.searchParams), bodySame: method === "GET" || u.body === body };
};
const submit = JSON.stringify({ prompt: "a red cube", seed: 1 });
const rows = [];
rows.push(["submit, no secret", await call("api/v3/wavespeed-ai/z-image/turbo", { body: submit })]);
process.env.WAVESPEED_WEBHOOK_SECRET = "whsec_" + randomBytes(32).toString("base64");
rows.push(["submit", await call("api/v3/wavespeed-ai/z-image/turbo", { body: submit })]);
rows.push(["submit + client webhook", await call("api/v3/wavespeed-ai/z-image/turbo", { body: submit, extra: "&webhook=https://evil.example&standard_webhook=https://evil.example" })]);
rows.push(["sync mode", await call("api/v3/wavespeed-ai/z-image/turbo", { body: JSON.stringify({ prompt: "x", enable_sync_mode: true }) })]);
rows.push(["history", await call("api/v3/predictions", { body: JSON.stringify({ page: 1, page_size: 100 }) })]);
rows.push(["poll + client webhook", await call("api/v3/predictions/p1/result", { method: "GET", extra: "&standard_webhook=https://evil.example" })]);
rows.push(["balance", await call("api/v3/balance", { method: "GET" })]);
for (const r of rows) console.log(JSON.stringify(r));
const raw = async (p, body = submit) => { const n = up.length; const res = await proxy(new Request(`https://proxima-ai-seven.vercel.app/api/ws-proxy?p=${p}`, { method: "POST", headers: { "x-proxima-session": token, "content-type": "application/json" }, body }), { waitUntil() {} }); return { status: res.status, forwarded: up.length > n }; };
console.log(JSON.stringify(["p with encoded ?", await raw(encodeURIComponent("api/v3/o/m?standard_webhook=https://evil.example"))]));
console.log(JSON.stringify(["p with encoded #", await raw(encodeURIComponent("api/v3/o/m#x"))]));
console.log(JSON.stringify(["p with ..", await raw("api/v3/predictions/../o/m")]));

// Expected results (fails with exit 1 on any difference).
const HOOK = "https://proxima-ai-seven.vercel.app/api/ws-webhook";
const expect = {
  "submit, no secret": {}, "submit": { standard_webhook: HOOK }, "submit + client webhook": { standard_webhook: HOOK },
  "sync mode": {}, "history": {}, "poll + client webhook": {}, "balance": {},
};
let bad = 0;
for (const [name, r] of rows) {
  const ok = r.status === 200 && r.bodySame && JSON.stringify(r.query) === JSON.stringify(expect[name]);
  if (!ok) { bad++; console.log("FAIL -", name); }
}
for (const p of [encodeURIComponent("api/v3/o/m?standard_webhook=https://evil.example"), encodeURIComponent("api/v3/o/m#x"), "api/v3/predictions/../o/m"]) {
  const r = await raw(p);
  if (r.status !== 400 || r.forwarded) { bad++; console.log("FAIL - path not refused:", p); }
}
console.log(bad ? `${bad} failed` : "all ok");
process.exit(bad ? 1 : 0);
