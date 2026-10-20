// ─── Signed-in session (server-issued, 12 hours) ───
// verify_admin returns an HMAC-signed token "<subject>.<exp>.<sig>". Every WaveSpeed call (via the
// /api/wavespeed-v2 proxy) and every account/backup RPC sends it; the server checks it, so editing
// localStorage no longer signs anyone in. The token is the only credential the browser keeps: the
// WaveSpeed key stays on the server.

const SESSION_KEY = "proximaai-session";
const USER_KEY = "proximaai-user"; // drives getDeviceId() -> "user:<name>" (the data scope)

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (s?.token && Number(s.expires_at) * 1000 > Date.now()) return s;
  } catch {}  // intentional: corrupt/blocked storage reads as signed out
  return null;
}

export function sessionToken() {
  return getSession()?.token || null;
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
export function reportSessionExpired() {
  clearSession();
  try { expiredHandler?.(); } catch {}
}
