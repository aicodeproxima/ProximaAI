// Tests for src/lib/wsWebhook.js — WaveSpeed's result webhook (signature, outcome, handler) and the proxy's
// standard_webhook parameter. Run: node scripts/test-ws-webhook.mjs
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { verifyWebhook, webhookUpdate, handleWebhook, forwardParams, WEBHOOK_URL, WEBHOOK_TOLERANCE_S, safeUpstreamPath } from "../src/lib/wsWebhook.js";
import { applyPoll, GONE_ERROR } from "../src/lib/taskResume.js";

const NOW = 1_800_000_000_000;
const TS = String(Math.floor(NOW / 1000));
const SECRET = "whsec_" + randomBytes(32).toString("base64");
const OTHER = "whsec_" + randomBytes(32).toString("base64");

// Signs like WaveSpeed (Standard Webhooks), independently of the code under test: node:crypto, not Web Crypto.
const sign = (secret, id, ts, body) =>
  "v1," + createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${ts}.`).update(body).digest("base64");
const headersFor = (body, { id = "msg_1", ts = TS, secret = SECRET, signature } = {}) =>
  new Headers({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signature ?? sign(secret, id, ts, body) });

const EVENT = { id: "pred_1", model: "wavespeed-ai/z-image/turbo", status: "completed", outputs: ["https://cdn.example/x.png"],
  urls: { get: "https://api.wavespeed.ai/api/v3/predictions/pred_1/result" }, created_at: "2026-10-20T21:00:00.123456789Z", error: "" };
const BODY = JSON.stringify(EVENT);

let n = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log("ok -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "\n   ", String(e?.message || e).split("\n").filter(Boolean).slice(0, 4).join(" | ")); }
};

// ─── Signature ───
await test("accepts a body signed with the secret", async () => {
  assert.deepEqual(await verifyWebhook(headersFor(BODY), BODY, [SECRET], NOW), { ok: true });
});

await test("rejects a tampered body", async () => {
  const r = await verifyWebhook(headersFor(BODY), BODY.replace("x.png", "y.png"), [SECRET], NOW);
  assert.deepEqual(r, { ok: false, reason: "signature" });
});

await test("rejects a body signed with another secret", async () => {
  const r = await verifyWebhook(headersFor(BODY, { secret: OTHER }), BODY, [SECRET], NOW);
  assert.deepEqual(r, { ok: false, reason: "signature" });
});

await test("rejects a timestamp more than 5 minutes old, even with a valid signature", async () => {
  const ts = String(Number(TS) - WEBHOOK_TOLERANCE_S - 1);
  assert.deepEqual(await verifyWebhook(headersFor(BODY, { ts }), BODY, [SECRET], NOW), { ok: false, reason: "stale" });
});

await test("rejects a timestamp more than 5 minutes in the future", async () => {
  const ts = String(Number(TS) + WEBHOOK_TOLERANCE_S + 1);
  assert.deepEqual(await verifyWebhook(headersFor(BODY, { ts }), BODY, [SECRET], NOW), { ok: false, reason: "stale" });
});

await test("accepts a timestamp at the edge of the tolerance", async () => {
  const ts = String(Number(TS) - WEBHOOK_TOLERANCE_S);
  assert.deepEqual(await verifyWebhook(headersFor(BODY, { ts }), BODY, [SECRET], NOW), { ok: true });
});

await test("rejects a signature moved onto another message id (the id is signed)", async () => {
  const h = headersFor(BODY, { id: "msg_1" });
  h.set("webhook-id", "msg_2");
  assert.deepEqual(await verifyWebhook(h, BODY, [SECRET], NOW), { ok: false, reason: "signature" });
});

await test("rejects missing headers", async () => {
  for (const drop of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const h = headersFor(BODY);
    h.delete(drop);
    assert.deepEqual(await verifyWebhook(h, BODY, [SECRET], NOW), { ok: false, reason: "headers" }, drop);
  }
});

await test("accepts any matching v1 signature in a space-separated list (key rotation)", async () => {
  const sig = `v1,${Buffer.from("nope").toString("base64")} ${sign(SECRET, "msg_1", TS, BODY)}`;
  assert.deepEqual(await verifyWebhook(headersFor(BODY, { signature: sig }), BODY, [SECRET], NOW), { ok: true });
});

await test("accepts a body signed with the previous secret while both are configured", async () => {
  assert.deepEqual(await verifyWebhook(headersFor(BODY, { secret: OTHER }), BODY, [SECRET, OTHER], NOW), { ok: true });
});

await test("ignores signatures of another scheme (legacy v3 hex)", async () => {
  const hex = createHmac("sha256", SECRET.slice(6)).update(`msg_1.${TS}.${BODY}`).digest("hex");
  assert.deepEqual(await verifyWebhook(headersFor(BODY, { signature: `v3,${hex}` }), BODY, [SECRET], NOW), { ok: false, reason: "signature" });
});

await test("verifies the raw bytes of a non-ASCII body", async () => {
  const body = new TextEncoder().encode(JSON.stringify({ ...EVENT, input: { prompt: "café ☕ 東京" } }));
  assert.deepEqual(await verifyWebhook(headersFor(Buffer.from(body)), body, [SECRET], NOW), { ok: true });
});

await test("fails closed with no secret configured", async () => {
  assert.deepEqual(await verifyWebhook(headersFor(BODY), BODY, [], NOW), { ok: false, reason: "no-secret" });
  assert.deepEqual(await verifyWebhook(headersFor(BODY), BODY, ["", "whsec_"], NOW), { ok: false, reason: "no-secret" });
});

// ─── Outcome (same rules as a poll answer) ───
const running = { id: "t1", status: "processing", startTime: NOW - 60_000, outputs: [], error: null };
const pick = (t) => t && { status: t.status, outputs: t.outputs ?? [], error: t.error ?? null };

await test("a completed event with outputs completes the task", () => {
  const u = webhookUpdate({ ...EVENT, timings: { inference: 1234 }, has_nsfw_contents: [false] }, NOW);
  assert.deepEqual(u, { status: "completed", outputs: EVENT.outputs, error: null, endTime: NOW, inferenceMs: 1234, nsfw: [false] });
});

await test("a completed event without outputs is not an outcome yet", () => {
  assert.equal(webhookUpdate({ ...EVENT, outputs: [] }, NOW), null);
  assert.equal(webhookUpdate({ ...EVENT, outputs: undefined }, NOW), null);
});

await test("failed / timeout / cancelled are final failures with the poll's error text", () => {
  assert.deepEqual(pick(webhookUpdate({ id: "p", status: "failed", error: "NSFW content detected" }, NOW)), { status: "failed", outputs: [], error: "NSFW content detected" });
  assert.equal(webhookUpdate({ id: "p", status: "failed", error: "" }, NOW).error, "Generation failed");
  assert.equal(webhookUpdate({ id: "p", status: "timeout" }, NOW).error, "WaveSpeed timed out this generation");
  assert.equal(webhookUpdate({ id: "p", status: "cancelled" }, NOW).error, "Cancelled on WaveSpeed");
});

await test("a failure never carries outputs (the row keeps its own)", () => {
  assert.equal(webhookUpdate({ id: "p", status: "failed", error: "x", outputs: ["https://cdn.example/partial.png"] }, NOW).outputs, null);
});

await test("deleted means the result is gone", () => {
  assert.deepEqual(pick(webhookUpdate({ id: "p", status: "deleted" }, NOW)), { status: "failed", outputs: [], error: GONE_ERROR });
});

await test("created / processing / unknown statuses are no outcome", () => {
  for (const status of ["created", "processing", "pending", "weird", undefined]) assert.equal(webhookUpdate({ id: "p", status }, NOW), null, String(status));
});

await test("matches the poll loop's outcome for every status (one rule set)", () => {
  const events = [EVENT, { ...EVENT, outputs: [] }, { id: "p", status: "failed", error: "boom" }, { id: "p", status: "failed" },
    { id: "p", status: "timeout" }, { id: "p", status: "cancelled" }, { id: "p", status: "canceled" }, { id: "p", status: "deleted" },
    { id: "p", status: "expired" }, { id: "p", status: "processing" }];
  for (const e of events) {
    const fromPoll = pick(applyPoll(running, e, NOW));
    const fromHook = pick(webhookUpdate(e, NOW));
    if (fromHook) fromHook.outputs = fromHook.outputs ?? [];
    assert.deepEqual(fromHook, fromPoll, e.status);
  }
});

// ─── Handler ───
const call = async (over = {}) => {
  const applied = [];
  const body = over.body ?? BODY;
  const res = await handleWebhook({
    headers: over.headers ?? headersFor(body), body, secrets: over.secrets ?? [SECRET], now: NOW,
    apply: over.apply ?? (async (a) => { applied.push(a); return over.answer ?? "applied"; }),
  });
  return { ...res, applied };
};

await test("a valid completed event is applied with its webhook id and the prediction id", async () => {
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].webhookId, "msg_1");
  assert.equal(r.applied[0].taskId, "pred_1");
  assert.equal(r.applied[0].status, "completed");
  assert.deepEqual(r.applied[0].outputs, EVENT.outputs);
});

await test("a replayed webhook id is acknowledged without a second write", async () => {
  const r = await call({ answer: "duplicate" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "duplicate");
});

await test("a bad signature is refused before anything is written", async () => {
  const r = await call({ headers: headersFor(BODY, { secret: OTHER }) });
  assert.equal(r.status, 401);
  assert.equal(r.applied.length, 0);
});

await test("a stale delivery is refused", async () => {
  const r = await call({ headers: headersFor(BODY, { ts: String(Number(TS) - 600) }) });
  assert.equal(r.status, 401);
  assert.equal(r.applied.length, 0);
});

await test("no secret configured answers 503 (WaveSpeed retries) and writes nothing", async () => {
  const r = await call({ secrets: [] });
  assert.equal(r.status, 503);
  assert.equal(r.applied.length, 0);
});

await test("a still-running event is acknowledged and not written", async () => {
  const body = JSON.stringify({ ...EVENT, status: "processing", outputs: [] });
  const r = await call({ body });
  assert.equal(r.status, 200);
  assert.equal(r.applied.length, 0);
});

await test("a signed body that is not a prediction is refused", async () => {
  for (const body of ["not json", JSON.stringify({ status: "completed" }), JSON.stringify({ id: 42, status: "completed" }), JSON.stringify({ id: "x".repeat(300), status: "failed" })]) {
    const r = await call({ body });
    assert.equal(r.status, 400, body.slice(0, 30));
    assert.equal(r.applied.length, 0);
  }
});

await test("a database failure answers 503 so WaveSpeed redelivers", async () => {
  const r = await call({ apply: async () => { throw new Error("supabase down"); } });
  assert.equal(r.status, 503);
});

await test("an event for a row that has not landed yet is kept (queued), not refused", async () => {
  const r = await call({ answer: "queued" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "queued");
});

// ─── Proxy: standard_webhook on submits ───
const SUBMIT = { method: "POST", path: "api/v3/wavespeed-ai/z-image/turbo", body: JSON.stringify({ prompt: "a cat" }), webhookOn: true };
const fwd = (over = {}, params = "") => Object.fromEntries(forwardParams(new URLSearchParams(params), { ...SUBMIT, ...over }));

await test("a submit gets the server's webhook URL", () => {
  assert.deepEqual(fwd(), { standard_webhook: WEBHOOK_URL });
  assert.equal(WEBHOOK_URL, "https://proxima-ai-seven.vercel.app/api/ws-webhook");
});

await test("the client cannot choose or add a webhook", () => {
  assert.deepEqual(fwd({}, "p=x&webhook=https://evil.example&standard_webhook=https://evil.example&foo=1"), { foo: "1", standard_webhook: WEBHOOK_URL });
  assert.deepEqual(fwd({ method: "GET", path: "api/v3/balance" }, "standard_webhook=https://evil.example&webhook=x"), {});
});

await test("history lookups, polls and other calls get no webhook", () => {
  assert.deepEqual(fwd({ path: "api/v3/predictions", body: JSON.stringify({ page: 1 }) }), {});
  assert.deepEqual(fwd({ path: "api/v3/predictions/abc/result" }), {});
  assert.deepEqual(fwd({ method: "GET", path: "api/v3/predictions/abc/result", body: "" }), {});
  assert.deepEqual(fwd({ path: "api/v3/media/upload/binary" }), {});
  assert.deepEqual(fwd({ path: "api/v3/webhook/secret" }), {});
});

await test("sync-mode and base64-output submits get no webhook (WaveSpeed rejects the combination)", () => {
  assert.deepEqual(fwd({ body: JSON.stringify({ prompt: "x", enable_sync_mode: true }) }), {});
  assert.deepEqual(fwd({ body: JSON.stringify({ prompt: "x", enable_base64_output: true }) }), {});
  assert.deepEqual(fwd({ body: JSON.stringify({ prompt: "x", enable_sync_mode: false, enable_base64_output: false }) }), { standard_webhook: WEBHOOK_URL });
});

await test("a body that is not a JSON object gets no webhook", () => {
  for (const body of ["", "nope", "[]", "null"]) assert.deepEqual(fwd({ body }), {}, body);
});

await test("no webhook until the secret is configured", () => {
  assert.deepEqual(fwd({ webhookOn: false }), {});
});

await test("a byte body (as the proxy holds it) is read only for submits", () => {
  const bytes = new TextEncoder().encode(SUBMIT.body).buffer;
  assert.deepEqual(fwd({ body: bytes }), { standard_webhook: WEBHOOK_URL });
  assert.deepEqual(fwd({ path: "api/v3/predictions", body: new TextEncoder().encode("{}").buffer }), {});
  assert.deepEqual(fwd({ body: new Uint8Array([0xff, 0xfe, 0x00]).buffer }), {});
});

// ─── Proxy: the upstream path ───
await test("plain WaveSpeed paths pass, leading slashes dropped", () => {
  for (const p of ["api/v3/wavespeed-ai/flux-schnell", "api/v3/bytedance/seedance-2.0-fast/video-edit-turbo",
    "api/v3/predictions/0a1b2c/result", "api/v3/predictions", "api/v3/balance", "api/v3/some_owner/Model.v2~x"]) {
    assert.equal(safeUpstreamPath(p), p);
  }
  assert.equal(safeUpstreamPath("///api/v3/balance"), "api/v3/balance");
});

await test("a path cannot carry its own query, fragment, escapes or dot segments", () => {
  for (const p of ["api/v3/o/m?standard_webhook=https://evil.example", "api/v3/o/m#x", "api/v3/o/m%3Fa=b",
    "api/v3/predictions/../o/m", "api/v3/./o/m", "api/v3/o/..", "..", "api/v3//o/m", "api/v3/o/m/", "api/v3/o m",
    "api\\v3\\o", "api/v3/o/m\n", "", null, undefined, "https://evil.example/api/v3/o/m"]) {
    assert.equal(safeUpstreamPath(p), null, JSON.stringify(p));
  }
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
