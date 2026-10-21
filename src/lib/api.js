// ─── WaveSpeed API Integration ───
// Every call goes through the /api/wavespeed-v2 edge proxy with the signed-in session token. The proxy
// checks the token and adds the WaveSpeed key server-side, so the browser never holds the key.

import { sessionToken, reportSessionExpired, isSuperseded } from "./session.js";
import { uploadInputFile } from "./supabase.js";

const PROXY_ROOT = "/api/wavespeed-v2";
const API_BASE = `${PROXY_ROOT}/api/v3`;

// Maps a poll URL onto the proxy: WaveSpeed's absolute URL, the retired /wavespeed rewrite (tasks saved
// before the cut-over), or a bare API path. Anything else is refused so the session token never leaves
// this origin.
export function toProxyUrl(url) {
  const u = String(url || "");
  if (/^https?:\/\/api\.wavespeed\.ai\//i.test(u)) return u.replace(/^https?:\/\/api\.wavespeed\.ai/i, PROXY_ROOT);
  if (u.startsWith(`${PROXY_ROOT}/`)) return u;
  if (u.startsWith("/wavespeed/")) return PROXY_ROOT + u.slice("/wavespeed".length);
  if (u.startsWith("/api/v3/")) return PROXY_ROOT + u;
  if (u.startsWith("/")) return `${API_BASE}${u}`;
  throw { code: 0, message: `Refusing to poll a non-WaveSpeed URL: ${u.slice(0, 80)}` };
}

// The proxy marks its own refusals with X-Proxima-Auth so they can't be confused with WaveSpeed's
// answers: "session" = token missing/expired/forged (sign in again), "no-key" = no key saved yet.
async function wsFetch(url, options = {}) {
  const token = sessionToken();
  if (!token) {
    reportSessionExpired();
    throw { code: 401, message: "Session expired — sign in again", session: true };
  }
  const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), "X-Proxima-Session": token } });
  const refusal = res.headers.get("x-proxima-auth");
  if (res.status === 401 && refusal === "session") {
    if (isSuperseded(token)) return wsFetch(url, options); // refused a token replaced mid-flight: resend with the new one
    reportSessionExpired(token);
    throw { code: 401, message: "Session expired — sign in again", session: true };
  }
  if (res.status === 400 && refusal === "no-key") {
    throw { code: 400, message: "No WaveSpeed key saved — add it in Settings", noKey: true };
  }
  return res;
}

const timeoutSignal = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

// A submit that hangs on a connection Android killed gives up after 60 s (a slow phone upload still fits). The
// proxy finishes the submit anyway, so the task then waits for the history lookup instead of failing.
const SUBMIT_TIMEOUT_MS = 60_000;
export async function submitTask(modelSlug, payload) {
  const res = await wsFetch(`${API_BASE}/${modelSlug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: timeoutSignal(SUBMIT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { code: res.status, message: err.message || err.error || res.statusText };
  }
  return res.json();
}

// Each poll gives up after 15 s: when Android freezes the app it kills its sockets, and a request stuck on a dead
// connection would otherwise leave the poll loop waiting with nothing scheduled. The TimeoutError has no HTTP code,
// so the loop treats it as a network drop and retries.
const POLL_TIMEOUT_MS = 15_000;
export async function pollResult(pollUrl) {
  const signal = timeoutSignal(POLL_TIMEOUT_MS);
  const res = await wsFetch(toProxyUrl(pollUrl), signal ? { signal } : {});
  if (!res.ok) throw { code: res.status, message: res.statusText };
  return res.json();
}

// WaveSpeed's prediction history (POST /api/v3/predictions): the documented way to find a submit whose response never
// arrived, since submits carry no idempotency key. Used only for that; WaveSpeed asks clients not to poll it for
// status. `after` / `before` are ms timestamps; reads up to 5 pages of 100.
export async function listPredictions({ after, before }) {
  const items = [];
  for (let page = 1; page <= 5; page++) {
    const res = await wsFetch(`${API_BASE}/predictions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page, page_size: 100, created_after: new Date(after).toISOString(), created_before: new Date(before).toISOString() }),
      signal: timeoutSignal(POLL_TIMEOUT_MS),
    });
    if (!res.ok) throw { code: res.status, message: res.statusText };
    const json = await res.json();
    if (typeof json?.code === "number" && json.code !== 200) throw { code: json.code, message: json.message || "History lookup refused" };
    const got = json?.data?.items;
    if (!Array.isArray(got)) throw { code: 0, message: "Unexpected history response" };
    items.push(...got);
    if (got.length < 100) break;
  }
  return items;
}

// Deletes finished predictions on WaveSpeed (POST /api/v3/predictions/delete), so a generation deleted in the app is
// gone there too. Returns the ids WaveSpeed deleted now; running, unknown and already-deleted ids it skips silently
// (wsDelete.js settles those). A malformed answer throws a plain Error, which the queue retries rather than drops.
export async function deletePredictions(ids) {
  const res = await wsFetch(`${API_BASE}/predictions/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
    signal: timeoutSignal(POLL_TIMEOUT_MS),
  });
  if (!res.ok) throw { code: res.status, message: res.statusText };
  const json = await res.json();
  if (typeof json?.code === "number" && json.code !== 200) throw { code: json.code, message: json.message || "Delete refused" };
  if (!Array.isArray(json?.data?.deleted_ids)) throw new Error("Unexpected delete response");
  return json.data.deleted_ids;
}

// keyStatus: "ok" (key works), "missing" (none saved on the server), "invalid" (WaveSpeed rejected it),
// "unknown" (network/session trouble — don't block generation on it).
export async function checkBalance() {
  try {
    const res = await wsFetch(`${API_BASE}/balance`);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        error: `HTTP ${res.status}${txt ? ": " + txt.slice(0, 150) : ""}`, balance: null,
        keyStatus: res.status === 401 || res.status === 403 ? "invalid" : "unknown",
      };
    }
    const data = await res.json();
    const bal = data?.data?.balance ?? data?.balance ?? null;
    return { error: null, balance: typeof bal === "number" ? bal.toFixed(2) : bal, keyStatus: "ok" };
  } catch (e) {
    return { error: e.message || "Network error", balance: null, keyStatus: e.noKey ? "missing" : "unknown" };
  }
}

// Input media (source images, end frames, audio, driving video) goes to our own public storage bucket;
// WaveSpeed fetches it by URL. (WaveSpeed's upload endpoint needs the key in the browser.)
export async function uploadMedia(file) {
  return uploadInputFile(file);
}

export { API_BASE };
