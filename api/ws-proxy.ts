// ─── ProximaAI WaveSpeed proxy — Phase 2.1 (Deploy 1) ──────────────────────
//
// Replaces the open `vercel.json` rewrite `/wavespeed/* -> api.wavespeed.ai/*`.
// Closes audit CRITICALs C1 (anon-readable per-user keys) and C6 (open proxy,
// ACAO:*). The WaveSpeed bearer token NEVER comes from the browser anymore;
// it's read server-side from `user_secrets` (default-deny RLS) using the
// service-role key, after verifying the caller's HMAC session token in-memory.
//
// Runtime: Edge (Vercel). Chosen in plan §A because proxima uses async polling
// (submit returns prediction_id; short polls every 3-15s), so no single request
// ever approaches Edge's 25s ceiling even for 30-minute WaveSpeed gens.
//
// ⚠️ Deploy 1 (this file) lives at /api/wavespeed-v2/* — a NEW path. The legacy
// /wavespeed rewrite is UNTOUCHED, so this function is DORMANT (no client traffic)
// until Deploy 2a flips the client's API_BASE. That makes Deploy 1 zero-risk.
//
// Security review references baked in:
//   F.1.2 — read user_secrets first, fall back to settings.apiKey during the
//           parallel-store window (removed in a follow-up once 2.3 cleanup runs).
//   F.1.3 — CORS allowlist incl. `null` Origin (PWA/service-worker fetches).
//   F.1.4 — service-role key is a SERVER env var; this file is under api/ which
//           Vite never bundles to the client. CI bundle-audit gates this too.
//   F.1.5 — token verified against SESSION_SIGNING_KEY, falling back to
//           SESSION_SIGNING_KEY_PREVIOUS for a 12h rotation grace window.
//   M5    — req.signal piped to upstream so client disconnect cancels billing.

export const config = { runtime: 'edge' };

const WAVESPEED_BASE = 'https://api.wavespeed.ai';
const PROD_ORIGIN = 'https://proxima-ai-seven.vercel.app';

// Edge request-body ceiling. Vercel Edge caps the incoming body at ~4 MB. The
// media-upload path (image-to-3D / image-edit source images) can exceed this.
// Until the upload path's runtime is settled (open design question), guard it
// with a clear 413 instead of a silent truncation.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// ─── CORS (F.1.3) ──────────────────────────────────────────────────────────
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
    'Vary': 'Origin',
  };
}

// ─── Session token verification (in-memory; mirrors _verify_session_token) ──
// Token shape: "<subject>.<exp_epoch>.<hex_hmac>"
// pgcrypto's hmac(msg, key, 'sha256') treats the key as the RAW TEXT bytes of
// the hex string (it does NOT hex-decode the key), so we import the hex STRING
// (UTF-8 bytes) as the HMAC key to match exactly. Verified against a live RPC
// token in scripts/verify-hmac.mjs.
async function hmacHex(msg: string, keyText: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
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
  if (!Number.isFinite(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null; // expired
  const msg = `${subject}.${exp}`;
  const candidateKeys = [process.env.SESSION_SIGNING_KEY, process.env.SESSION_SIGNING_KEY_PREVIOUS]
    .filter((k): k is string => !!k);
  if (candidateKeys.length === 0) {
    console.error('[wavespeed-v2] SESSION_SIGNING_KEY not configured — cannot verify tokens');
    return null; // fail closed
  }
  for (const key of candidateKeys) {
    const expected = await hmacHex(msg, key);
    if (timingSafeEqualHex(expected, sig)) return subject;
  }
  return null;
}

// ─── Per-user WaveSpeed key (service role) ──────────────────────────────────
function subjectToDeviceId(subject: string): string {
  return subject.startsWith('admin:') ? `user:${subject.slice(6)}` : subject;
}
async function getUserWaveSpeedKey(token: string, subject: string): Promise<string | null> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('[wavespeed-v2] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    return null;
  }
  const headers = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  // Primary: user_secrets via SECURITY DEFINER RPC (re-verifies the token).
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_my_wavespeed_key`, {
      method: 'POST', headers, body: JSON.stringify({ p_session_token: token }),
    });
    if (r.ok) {
      const v = await r.json();
      if (typeof v === 'string' && v.length >= 8) return v;
    }
  } catch (e) { console.warn('[wavespeed-v2] get_my_wavespeed_key failed', e); }

  // Fallback (F.1.2): legacy settings.apiKey, read via service role bypassing RLS.
  // Removed once Phase 2.3 cleanup deletes settings.apiKey rows.
  try {
    const deviceId = subjectToDeviceId(subject);
    const url = `${SUPABASE_URL}/rest/v1/settings?device_id=eq.${encodeURIComponent(deviceId)}&key=eq.apiKey&select=value`;
    const r = await fetch(url, { headers });
    if (r.ok) {
      const rows = await r.json();
      const raw = Array.isArray(rows) && rows[0]?.value;
      const key = typeof raw === 'string' ? raw : null;
      if (key && key.length >= 8) {
        console.warn('[wavespeed-v2] served key from legacy settings.apiKey fallback');
        return key;
      }
    }
  } catch (e) { console.warn('[wavespeed-v2] settings.apiKey fallback failed', e); }

  return null;
}

// ─── Rate limiting (Upstash REST; no SDK import) ────────────────────────────
// Sliding-ish fixed-window: INCR a per-minute bucket, EXPIRE 60s. 30 req / 60s.
// If Upstash env is ABSENT → not configured yet (Deploy 1 pre-provisioning):
//   skip with a warning so the function is testable before Upstash exists.
// If Upstash env is PRESENT but the call errors → real outage → fail CLOSED (503).
const RATE_LIMIT = 30;
async function checkRateLimit(userId: string): Promise<{ ok: boolean; configured: boolean; remaining: number }> {
  const URL_ = process.env.UPSTASH_REDIS_REST_URL;
  const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL_ || !TOKEN) {
    console.warn('[wavespeed-v2] rate limiting DISABLED — UPSTASH not configured (Deploy-1 state)');
    return { ok: true, configured: false, remaining: RATE_LIMIT };
  }
  const windowKey = `proxima-ws:${userId}:${Math.floor(Date.now() / 60000)}`;
  try {
    // Pipeline INCR + EXPIRE in one round trip.
    const r = await fetch(`${URL_}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', windowKey], ['EXPIRE', windowKey, '60']]),
    });
    if (!r.ok) throw new Error(`Upstash HTTP ${r.status}`);
    const out = await r.json();
    const count = Array.isArray(out) ? Number(out[0]?.result ?? 0) : 0;
    return { ok: count <= RATE_LIMIT, configured: true, remaining: Math.max(0, RATE_LIMIT - count) };
  } catch (e) {
    console.error('[wavespeed-v2] Upstash error — failing closed', e);
    return { ok: false, configured: true, remaining: 0 }; // fail closed (F deliverable)
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: cors });
  }

  // 1. Auth — session token from header (Phase 2) ; Phase 3 will accept Supabase JWT.
  const token = req.headers.get('x-proxima-session')
    || (req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null);
  const subject = await verifySessionToken(token);
  if (!subject) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 2. Rate limit (per authenticated user).
  const rl = await checkRateLimit(subject);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'Rate limited' }), {
      status: rl.configured ? 429 : 503,
      headers: { ...cors, 'Content-Type': 'application/json', 'X-RateLimit-Remaining': String(rl.remaining) },
    });
  }

  // 3. Resolve the caller's WaveSpeed key server-side.
  const wsKey = await getUserWaveSpeedKey(token!, subject);
  if (!wsKey) {
    return new Response(JSON.stringify({ error: 'No WaveSpeed key configured' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 4. Build the upstream URL. The vercel.json rewrite delivers the WaveSpeed
  //    path as ?p=<path> (Vercel's filesystem catch-all [...path] only matches a
  //    single segment in non-Next projects, so we route via a :path* rewrite into
  //    this single function instead). Fall back to stripping the prefix if the
  //    original URL passed through unrewritten.
  const reqUrl = new URL(req.url);
  let path = reqUrl.searchParams.get('p') || reqUrl.pathname.replace(/^\/api\/(wavespeed-v2|ws-proxy)\/?/, '');
  path = path.replace(/^\/+/, '');
  // Preserve any genuine upstream query params (everything except our internal 'p').
  const passthrough = new URLSearchParams(reqUrl.search);
  passthrough.delete('p');
  const qs = passthrough.toString();
  const upstreamUrl = `${WAVESPEED_BASE}/${path}${qs ? `?${qs}` : ''}`;

  // 5. Forward headers: copy Content-Type, REPLACE Authorization with server key,
  //    drop hop-by-hop and identifying headers.
  const fwdHeaders = new Headers();
  const ct = req.headers.get('content-type');
  if (ct) fwdHeaders.set('content-type', ct);
  fwdHeaders.set('authorization', `Bearer ${wsKey}`);

  // 6. Body: buffer (Edge body ceiling) with a clear 413 on oversize.
  let body: ArrayBuffer | undefined;
  if (req.method === 'POST') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'Payload too large for proxy (max 4 MB)' }), {
        status: 413, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    body = buf.byteLength > 0 ? buf : undefined;
  }

  // 7. Forward to WaveSpeed; pipe abort signal for client-disconnect cancel (M5).
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwdHeaders,
      body,
      signal: req.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      return new Response(null, { status: 499, headers: cors }); // client closed request
    }
    console.error('[wavespeed-v2] upstream fetch failed', e);
    return new Response(JSON.stringify({ error: 'Upstream error' }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 8. Stream the response back. Restrict ACAO to the allowlisted origin (no '*').
  const respHeaders = new Headers(cors);
  const upstreamCt = upstream.headers.get('content-type');
  if (upstreamCt) respHeaders.set('content-type', upstreamCt);
  respHeaders.set('x-request-id', crypto.randomUUID());
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
