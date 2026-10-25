// ─── ProximaAI kie.ai proxy (docs/SECOND-ACCOUNT-PLAN.md S2) ─────────────────
//
// The browser never holds a kie.ai key. Each account saves its own key in Settings (set_my_provider_key, kept in
// Supabase Vault); this function verifies the caller's session token, reads THAT account's key server-side
// (get_provider_key, service role, which re-verifies the token in the database so revocation applies) and forwards
// one of exactly four kie.ai calls, rebuilt by src/lib/kieProxy.js kieUpstream (createTask, recordInfo, credit,
// download-url). Reached through the vercel.json rewrite /api/kie/:path* → /api/kie-proxy?p=:path*.
//
// Same session check and CORS rules as api/ws-proxy.ts (kept as a copy so that file stays untouched). No rate limit
// here: limits are off by default (owner ruling 2026-10-23) and arrive switchable in P5.
// Answers: kie.ai's JSON passes through unchanged (kie.ai reports most errors as HTTP 200 with its own `code`).
//   401 X-Proxima-Auth: session  — no valid session          400 X-Proxima-Auth: no-key — no kie.ai key saved
//   400/404/413                  — a call kieUpstream refuses 503 — key lookup failed (retryable)
//   502                          — kie.ai unreachable

import { kieUpstream } from '../src/lib/kieProxy.js';

export const config = { runtime: 'edge' };

const PROD_ORIGIN = 'https://proxima-ai-seven.vercel.app';

function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null || origin === '' || origin === 'null') return true; // PWA / SW / same-origin
  if (origin === PROD_ORIGIN) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && u.hostname.endsWith('.vercel.app')) return true; // preview branches
  } catch { /* malformed Origin → not allowed */ }
  return false;
}
function corsHeaders(origin: string | null): Record<string, string> {
  const allow = isAllowedOrigin(origin) && origin && origin !== 'null' ? origin : PROD_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Proxima-Session',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'X-Proxima-Auth',
    'Vary': 'Origin',
  };
}

// Session token check in memory (mirrors _verify_session_token; see api/ws-proxy.ts for the key-as-text detail).
async function hmacHex(msg: string, keyText: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifySessionToken(token: string | null): Promise<string | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [subject, expStr, sig] = parts;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const keys = [process.env.SESSION_SIGNING_KEY, process.env.SESSION_SIGNING_KEY_PREVIOUS].filter((k): k is string => !!k);
  if (keys.length === 0) {
    console.error('[kie-proxy] SESSION_SIGNING_KEY not configured — cannot verify tokens');
    return null; // fail closed
  }
  for (const key of keys) {
    if (timingSafeEqualHex(await hmacHex(`${subject}.${exp}`, key), sig)) return subject;
  }
  return null;
}

type KeyLookup = { key: string } | { status: 'missing' | 'session' | 'error' };
async function getKieKey(token: string): Promise<KeyLookup> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('[kie-proxy] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    return { status: 'error' };
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_provider_key`, {
      method: 'POST',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_session_token: token, p_provider: 'kie' }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const v = await r.json();
      return typeof v === 'string' && v.length >= 8 ? { key: v } : { status: 'missing' };
    }
    const body = await r.text().catch(() => '');
    if (/session token|invalid signature|malformed|forbidden/i.test(body)) return { status: 'session' };
    console.warn('[kie-proxy] get_provider_key HTTP', r.status);
    return { status: 'error' };
  } catch (e) {
    console.warn('[kie-proxy] get_provider_key failed', String((e as Error)?.message || e));
    return { status: 'error' };
  }
}

export default async function handler(req: Request, ctx?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));
  const json = { ...cors, 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors });

  const token = req.headers.get('x-proxima-session') || (req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null);
  if (!(await verifySessionToken(token))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...json, 'X-Proxima-Auth': 'session' } });
  }

  // The call is checked before the key is read, so a refused call never touches the key.
  const reqUrl = new URL(req.url);
  const bodyText = req.method === 'POST' ? await req.text() : '';
  const call = kieUpstream(req.method, reqUrl.searchParams.get('p') || reqUrl.pathname.replace(/^\/api\/(kie|kie-proxy)\/?/, ''),
    reqUrl.searchParams, bodyText);
  if (!call.ok) return new Response(JSON.stringify({ error: call.error }), { status: call.status, headers: json });

  const lookup = await getKieKey(token!);
  if (!('key' in lookup)) {
    if (lookup.status === 'session') return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...json, 'X-Proxima-Auth': 'session' } });
    if (lookup.status === 'missing') return new Response(JSON.stringify({ error: 'No kie.ai key saved' }), { status: 400, headers: { ...json, 'X-Proxima-Auth': 'no-key' } });
    return new Response(JSON.stringify({ error: 'Key lookup failed — try again' }), { status: 503, headers: json });
  }

  // A GET stops when the browser goes away (the next poll asks again). A createTask POST is never cut off: kie.ai may
  // already have accepted and billed it, and cancelling only loses its taskId.
  let upstream: Response;
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${lookup.key}` };
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    const sent = fetch(call.url, { method: call.method, headers, body: call.body, signal: req.method === 'GET' ? req.signal : undefined });
    if (req.method === 'POST') ctx?.waitUntil?.(sent.catch(() => undefined));
    upstream = await sent;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return new Response(null, { status: 499, headers: cors });
    console.error('[kie-proxy] upstream fetch failed', String((e as Error)?.message || e));
    return new Response(JSON.stringify({ error: 'Upstream error' }), { status: 502, headers: json });
  }
  const respHeaders = new Headers(cors);
  const ct = upstream.headers.get('content-type');
  if (ct) respHeaders.set('content-type', ct);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
