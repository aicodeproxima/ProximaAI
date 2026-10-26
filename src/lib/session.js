// ─── Signed-in session (server-issued, 12 hours) ───
// verify_admin returns an HMAC-signed token "<subject>.<exp>.<sig>". Every WaveSpeed call (via the
// /api/wavespeed-v2 proxy) and every account/backup RPC sends it; the server checks it, so editing
// localStorage no longer signs anyone in. The token is the only credential the browser keeps: the
// WaveSpeed key stays on the server.

import { tokenAccountId } from "./accountGuard.js";

const SESSION_KEY = "proximaai-session";
const USER_KEY = "proximaai-user"; // drives getDeviceId() -> "user:<name>" (the data scope)

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (s?.token && Number(s.expires_at) * 1000 > Date.now()) return s;
  } catch {}  // intentional: corrupt/blocked storage reads as signed out
  return null;
}

// The account this page signed in as (second account S5, review r8 #1/#4/#6/#14): set when the page's session is
// confirmed (a fitting session at load, the account check, sign-in, join), cleared at sign-out. While it is set, a session
// in storage that names ANOTHER account (another tab signed in as someone else) is never sent from this page:
// sessionToken() reads it as none (so the proxy, the RPCs and the data fetch all go without it), a refusal never clears
// that account's session, and the page is told to leave (onForeignSession) instead of carrying on under it.
let pageAccount = null;
let foreignHandler = null;
export function bindPageAccount(id) { pageAccount = typeof id === "string" && id ? id.toLowerCase() : null; }
export function pageAccountId() { return pageAccount; }
export function onForeignSession(fn) { foreignHandler = fn; }
const isForeign = (token) => !!(pageAccount && token && tokenAccountId(token) !== pageAccount);
const leaveForForeign = () => { try { queueMicrotask(() => { try { foreignHandler?.(); } catch {} }); } catch {} };

export function sessionToken() {
  const token = getSession()?.token || null;
  if (token && isForeign(token)) { leaveForForeign(); return null; }
  return token;
}

// The database's row policies admit a data request only when this header carries a token the server verifies (PostgREST
// and Storage copy request headers into Postgres's request.headers; migrations 20261022100000 + 20261022120000).
// withSessionHeader wraps the fetch supabase-js uses for <base>/rest/v1/ and <base>/storage/v1/ (never /auth/v1 or other
// hosts) so each of those requests carries the CURRENT token, read per request: sign-in, rename and sign-out apply at once.
// Signed out, a table or Storage call is answered here with 401 "session token missing" instead of reaching a server
// that would read nothing or delete nothing without saying so; RPCs still go out (verify_admin and the backup-code unlock
// run before a session exists; the others carry p_session_token). Edge logs keep x-client-info but not custom headers, so
// the marker "proxima-rls/1 sess/1|0" shows per device what was sent.
export const SESSION_HEADER = "x-proxima-session";
export const RLS_MARK = "proxima-rls/1";
// This build keeps one account's data per browser (src/lib/accountGuard.js): a member signs in only from such a build
// (verify_admin, migration 20261026600000).
export const GUARD_MARK = "proxima-guard/1";
const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || "");
export function withSessionHeader(baseFetch, { baseUrl = "", getToken = sessionToken } = {}) {
  const root = String(baseUrl).replace(/\/+$/, "");
  const dataPrefixes = root ? [`${root}/rest/v1/`, `${root}/storage/v1/`] : [];
  const rpcPrefix = `${root}/rest/v1/rpc/`;
  return (input, init) => {
    const url = urlOf(input);
    if (!dataPrefixes.some((p) => url.startsWith(p))) return baseFetch(input, init);
    const token = getToken();
    if (!token && !url.startsWith(rpcPrefix)) {
      const body = JSON.stringify({ code: "PGRST301", message: "session token missing", details: null, hint: "sign in again",
        statusCode: "401", error: "Unauthorized" });
      return Promise.resolve(new Response(body, { status: 401, headers: { "content-type": "application/json" } }));
    }
    const own = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    const headers = new Headers(own);
    if (token) headers.set(SESSION_HEADER, token); else headers.delete(SESSION_HEADER);
    headers.set("x-client-info", [headers.get("x-client-info"), `${RLS_MARK} sess/${token ? 1 : 0} ${GUARD_MARK}`].filter(Boolean).join(" "));
    return baseFetch(input, { ...init, headers });   // body passed by reference: a 50 MB upload is never copied
  };
}

export function setSession({ token, expires_at, username }) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, expires_at, username }));
    if (username) localStorage.setItem(USER_KEY, username);
  } catch {}  // intentional: private mode; the in-memory app still works until reload
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(USER_KEY); } catch {}
}

// Server-side token failures, as raised by _verify_session_token or the proxy's 401.
const SESSION_ERROR = /invalid session token|malformed (session token|exp)|session token expired|session token revoked|invalid signature|not admin-scoped/i;
export function isSessionError(err) {
  return SESSION_ERROR.test(String(err?.message || err || ""));
}

let expiredHandler = null;
export function onSessionExpired(fn) { expiredHandler = fn; }
// tokenUsed: the token the refused request carried. A refusal that arrives after this device already switched to a
// newer token (password change / rename revoke the old one) is stale and must not sign the fresh session out.
export function isSuperseded(tokenUsed) {
  const current = sessionToken();
  return !!(tokenUsed && current && current !== tokenUsed);
}
export function reportSessionExpired(tokenUsed) {
  if (isSuperseded(tokenUsed)) return;
  if (isForeign(getSession()?.token)) { leaveForForeign(); return; }   // another account's session: not this page's to clear
  clearSession();
  try { expiredHandler?.(); } catch {}
}
