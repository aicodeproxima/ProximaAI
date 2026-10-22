// WaveSpeed's result webhook (pure — tested by scripts/test-ws-webhook.mjs).
//
// api/ws-proxy.ts asks WaveSpeed to POST every submit's result to api/ws-webhook.ts, which saves it into the cloud
// `tasks` row by its prediction id (task_id). The result then lands even when every device is closed for longer than
// WaveSpeed keeps it (a 54 h-old prediction already answered "deleted" on 2026-10-20); a device picks it up from the
// cloud on its next sync (planTaskSync `finish`). Client polling and the history lookup stay as the fallback: a
// delivery that fails 3 retries is dropped.
//
// Deliveries are signed under the Standard Webhooks spec (wavespeed.ai/docs/verify-webhooks, read 2026-10-20):
// headers webhook-id / webhook-timestamp / webhook-signature ("v1,<base64>", space-separated during a key rotation),
// HMAC-SHA256 over "<webhook-id>.<webhook-timestamp>.<raw body>", keyed with the base64-decoded part of the whsec_
// secret after its prefix. WaveSpeed wants a 2xx within 10 s.

import { applyPoll } from "./taskResume.js";

export const WEBHOOK_URL = "https://proxima-ai-seven.vercel.app/api/ws-webhook";
export const WEBHOOK_TOLERANCE_S = 300;
const MAX_ID_LENGTH = 200;

const enc = new TextEncoder();
const bytesOf = (body) => (typeof body === "string" ? enc.encode(body) : new Uint8Array(body));

function keyBytes(secret) {
  const b64 = String(secret || "").replace(/^whsec_/, "");
  if (!b64) return null;
  try { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch { return null; }
}

async function hmacBase64(key, content) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, content))));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// { ok: true } or { ok: false, reason }: "no-secret" (none configured), "headers", "stale" (outside ±5 minutes, so a
// captured delivery cannot be replayed later), "signature". `secrets` lists the current secret and, during a
// rotation, the previous one. `body` is the raw body (string or bytes) exactly as received.
export async function verifyWebhook(headers, body, secrets, now) {
  const keys = (secrets || []).map(keyBytes).filter(k => k?.length > 0);
  if (!keys.length) return { ok: false, reason: "no-secret" };
  const id = headers.get("webhook-id"), ts = headers.get("webhook-timestamp"), signature = headers.get("webhook-signature");
  if (!id || !ts || !signature) return { ok: false, reason: "headers" };
  if (!/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_S) return { ok: false, reason: "stale" };
  const prefix = enc.encode(`${id}.${ts}.`), raw = bytesOf(body);
  const content = new Uint8Array(prefix.length + raw.length);
  content.set(prefix);
  content.set(raw, prefix.length);
  const given = signature.split(" ").filter(s => s.startsWith("v1,")).map(s => s.slice(3));
  for (const key of keys) {
    const expected = await hmacBase64(key, content);
    if (given.some(g => sameString(g, expected))) return { ok: true };
  }
  return { ok: false, reason: "signature" };
}

// What a delivery means for the task, by the poll loop's own rules (applyPoll): the columns to write, or null while
// it is no outcome yet (a "completed" without outputs, created, processing). A failure carries no outputs, so the
// row keeps its own.
export function webhookUpdate(event, now) {
  const t = applyPoll({ startTime: now }, event, now);
  if (!t) return null;
  const done = t.status === "completed";
  const inference = event?.timings?.inference;
  return {
    status: t.status,
    outputs: done ? t.outputs : null,
    error: done ? null : t.error,
    endTime: now,
    inferenceMs: done && Number.isFinite(inference) ? Math.round(inference) : null,
    nsfw: done ? (event?.has_nsfw_contents ?? null) : null,
  };
}

// One delivery → { status, body }. `apply` writes the update and answers "applied" | "finished" (row already
// finished) | "queued" (no row with that task_id yet; applied when it lands) | "duplicate" (webhook id seen before) |
// "deleted" (the prediction was deleted in the app, so nothing is kept).
// Anything it throws answers 503, so WaveSpeed redelivers.
export async function handleWebhook({ headers, body, secrets, now, apply }) {
  const v = await verifyWebhook(headers, body, secrets, now);
  if (!v.ok) {
    return v.reason === "no-secret"
      ? { status: 503, body: { error: "Webhook secret not configured" } }
      : { status: 401, body: { error: "Invalid webhook", reason: v.reason } };
  }
  let event = null;
  try { event = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)); } catch { /* refused below */ }
  const taskId = event?.id;
  if (typeof taskId !== "string" || !taskId || taskId.length > MAX_ID_LENGTH) return { status: 400, body: { error: "Not a prediction" } };
  const update = webhookUpdate(event, now);
  if (!update) return { status: 200, body: { result: "running" } };
  try {
    return { status: 200, body: { result: await apply({ webhookId: headers.get("webhook-id"), taskId, ...update }) } };
  } catch {
    return { status: 503, body: { error: "Could not save the result" } };
  }
}

// ─── Proxy side ───
// A model submit is POST api/v3/<owner>/<model...>; the history lookup (api/v3/predictions), polls, uploads and the
// secret endpoint are not. WaveSpeed rejects a webhook combined with sync mode or base64 output.
const SUBMIT_PATH = /^api\/v3\/(?!predictions(\/|$)|media\/|webhook\/)[^/]+\/[^/]/;
const isOn = (v) => v === true || v === "true" || v === 1;
// `body` is the raw body (string or bytes); it is decoded only once the path is a submit.
export function isWebhookSubmit(method, path, body) {
  if (method !== "POST" || !SUBMIT_PATH.test(path)) return false;
  let payload;
  try { payload = JSON.parse(typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { return false; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return !isOn(payload.enable_sync_mode) && !isOn(payload.enable_base64_output);
}

// The query string forwarded upstream: the client's own parameters minus the proxy's routing `p` and any webhook it
// tried to set, plus the server's webhook on submits once the signing secret is configured (`webhookOn`).
export function forwardParams(params, { method, path, body, webhookOn }) {
  const out = new URLSearchParams(params);
  for (const k of ["p", "webhook", "standard_webhook"]) out.delete(k);
  if (webhookOn && isWebhookSubmit(method, path, body)) out.set("standard_webhook", WEBHOOK_URL);
  return out;
}

// The WaveSpeed path the proxy forwards to, or null. The rewrite hands it over URL-decoded (?p=), so a "?" or "#"
// inside it would become the upstream query or fragment, and a ".." segment is normalised by fetch: either would let a
// caller set its own webhook or make a submit look like something else. Only plain segments pass.
const PATH_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/; // never empty, never "." / ".."
export function safeUpstreamPath(raw) {
  const path = String(raw ?? "").replace(/^\/+/, "");
  return path && path.split("/").every(s => PATH_SEGMENT.test(s)) ? path : null;
}

// A delete the app sends through the proxy (POST api/v3/predictions/delete {ids}): the prediction ids it names, or null
// for any other request. The proxy records them (ws_predictions_deleted) before WaveSpeed is asked, so a result WaveSpeed
// delivers later (it will not delete a running prediction) is dropped instead of kept (finding #8, 2026-10-22).
export const MAX_DELETE_IDS = 500;   // ids per ws_predictions_deleted call; the proxy records larger deletes in slices
const DELETE_PATH = "api/v3/predictions/delete";
export function deleteRequestIds(method, path, body) {
  if (method !== "POST" || path !== DELETE_PATH) return null;
  let payload;
  try { payload = JSON.parse(typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { return []; }
  const ids = Array.isArray(payload?.ids) ? payload.ids : [];
  return [...new Set(ids.filter(i => typeof i === "string" && i.length > 0 && i.length <= MAX_ID_LENGTH))];
}
