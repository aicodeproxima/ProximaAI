// ─── ProximaAI WaveSpeed result webhook ─────────────────────────────────────
//
// WaveSpeed POSTs each submit's outcome here: api/ws-proxy.ts adds standard_webhook=<this URL> to every submit once
// WAVESPEED_WEBHOOK_SECRET is set. The delivery is verified against that secret (plus
// WAVESPEED_WEBHOOK_SECRET_PREVIOUS during a rotation) and written into the cloud `tasks` row by the
// ws_webhook_apply RPC with the service-role key, so a generation finishes even when every device is closed.
// The decisions live in src/lib/wsWebhook.js (tests: scripts/test-ws-webhook.mjs, scripts/test-ws-webhook-db.sql).
//
// Answers: 200 handled (applied / finished / queued / duplicate / still running), 401 bad or stale signature,
// 400 not a prediction, 413 oversize, 503 not configured or the database did not answer (WaveSpeed retries up to 3
// times). WaveSpeed wants an answer within 10 s, so the database call gives up after 8 s. Nothing from the body
// (prompt, outputs) is logged.

import { handleWebhook } from '../src/lib/wsWebhook.js';

export const config = { runtime: 'edge' };

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const RPC_TIMEOUT_MS = 8000;

type Apply = {
  webhookId: string; taskId: string; status: string; outputs: unknown; error: string | null;
  endTime: number; inferenceMs: number | null; nsfw: unknown;
};

async function applyViaRpc(a: Apply): Promise<string> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ws_webhook_apply`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_webhook_id: a.webhookId, p_task_id: a.taskId, p_status: a.status, p_outputs: a.outputs, p_error: a.error,
      p_end_time: a.endTime, p_inference_ms: a.inferenceMs, p_nsfw: a.nsfw,
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`ws_webhook_apply HTTP ${r.status}`);
  return String(await r.json());
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return json(413, { error: 'Payload too large' });
  const secrets = [process.env.WAVESPEED_WEBHOOK_SECRET, process.env.WAVESPEED_WEBHOOK_SECRET_PREVIOUS]
    .filter((s): s is string => !!s);
  const res = await handleWebhook({
    headers: req.headers, body, secrets, now: Date.now(),
    apply: (a: Apply) => applyViaRpc(a).catch((e) => { console.warn('[ws-webhook] apply failed:', String(e?.message || e)); throw e; }),
  });
  console.log('[ws-webhook]', res.status, res.body.result || res.body.reason || res.body.error);
  return json(res.status, res.body);
}
