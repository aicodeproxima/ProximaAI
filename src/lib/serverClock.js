// The server's clock as this device estimates it (review round 3 #7). A restore stamps last_restore_at with the
// server's time, and the restore check (storage.js restoreGuard) compares it with the stamps of intents queued here, so
// those stamps are taken in server time: Date.now() plus an offset learned from every Supabase response's Date header
// (exposed to the app by CORS). Kept in localStorage, so a device that is offline still stamps with its last offset.
const KEY = "proximaai-clock-offset";
let offset = (() => { try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; } })();

export const serverNow = () => Date.now() + offset;

// One sample: the header has whole seconds (its midpoint is +500 ms) against the request's midpoint. A sample whose
// round trip took over 5 s says too little and is skipped. Returns the current offset.
export function noteServerDate(date, sentAt, receivedAt) {
  const t = Date.parse(date);
  if (!Number.isFinite(t) || !(receivedAt >= sentAt) || receivedAt - sentAt > 5000) return offset;
  const next = Math.round(t + 500 - (sentAt + receivedAt) / 2);
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
