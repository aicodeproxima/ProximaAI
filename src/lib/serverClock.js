// The server's clock as this device estimates it (review round 3 #7). A restore stamps last_restore_at with the
// server's time, and the restore check (storage.js restoreGuard) compares it with the stamps of intents queued here, so
// those stamps are taken in server time: Date.now() plus an offset learned from every Supabase response's Date header
// (exposed to the app by CORS). Kept in localStorage, so a device that is offline still stamps with its last offset.
const KEY = "proximaai-clock-offset";
let offset = (() => { try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; } })();

export const serverNow = () => Date.now() + offset;
// The estimate can be off by the Date header's whole second plus half the quickest round trip (at most 1.5 s), so a
// snapshot time this much earlier is never after the server's real time (review round 10: Clear Outputs / Reset).
export const CLOCK_MARGIN_MS = 3000;

// One sample: the header has whole seconds (its midpoint is +500 ms) against the request's midpoint. The server stamps
// Date when it answers, so a slow request (an upload, a large pull) puts it late and biases the estimate by up to half
// its round trip (review round 4). So the quickest sample of the last 10 minutes wins, and one over 1.5 s is never
// used. Returns the current offset.
const MAX_RTT_MS = 1500, BEST_FOR_MS = 10 * 60 * 1000;
let best = null;   // { rtt, at } of the sample the offset came from
export function noteServerDate(date, sentAt, receivedAt) {
  const t = Date.parse(date), rtt = receivedAt - sentAt;
  if (!Number.isFinite(t) || !(rtt >= 0) || rtt > MAX_RTT_MS) return offset;
  const stale = !best || Math.abs(receivedAt - best.at) > BEST_FOR_MS;
  if (!stale && rtt >= best.rtt) return offset;
  const next = Math.round(t + 500 - (sentAt + receivedAt) / 2);
  best = { rtt, at: receivedAt };
  if (Math.abs(next - offset) >= 1000) { try { localStorage.setItem(KEY, String(next)); } catch {} }
  offset = next;
  return offset;
}

// Wraps a fetch so every response it returns teaches the offset; the response itself is untouched.
export const withServerClock = (fetchImpl) => async (input, init) => {
  const sentAt = Date.now();
  const res = await fetchImpl(input, init);
  try { const d = res?.headers?.get?.("date"); if (d) noteServerDate(d, sentAt, Date.now()); } catch {}
  return res;
};
