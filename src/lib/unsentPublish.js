// This browser's rows not uploaded yet, published in settings form-inputs:<browser>:unsent (App.jsx; the server treats
// every form-inputs:% row as a form hold, and other devices hold what it names before deleting files or WaveSpeed
// results). Pure, so node tests run it (scripts/test-b17-publisher.mjs) and the simulator imports it as is.
//
// Task B17 (review round 30 #1/#2): every publication is sent at once. Round 29's one-at-a-time chain kept the rows queued
// after an unanswered write from being published until a frozen page thawed, and another device's delete of a sibling
// then removed a live generation's input (simulator I6-end). Writes may now land in any order, from any tab or the
// page-exit write: the server keeps the newest set (migration 20261025900000, by value.at on the server-aligned clock).
// `confirmed` is the newest publication the server answered: an older write answered later never replaces it, and a set
// that differs from it is due (sent now, even while an older write is still unanswered).
//
// A write whose stamp is older than the stored one (a device clock stepped back) is refused by the server with the stored
// stamp (PT409); staleAt(error) reads it, advance(at) moves this browser's floor above it, and the set is computed and sent
// again, up to MAX_STALE_RETRIES times (B17 review #1/#5: a silently skipped write used to count as published; B17
// verification: overlapping writes may be refused more than once while the set changes).
//
// deps: configured() -> bool; compute() -> {paths, ids, predictions}; now() -> ms (formStamp(serverNow()) in the app);
// due(confirmed, items, now) -> bool (fileDelete.js formPublishDue); send(value) -> Promise (syncSetting); onExit();
// staleAt(error) -> the stored stamp of a stale-stamp refusal, else NaN; advance(at).
export const MAX_STALE_RETRIES = 3;
export function createUnsentPublisher({ configured, compute, now, due, send, onExit, staleAt, advance }) {
  let confirmed = null;
  // Resolves true once the cloud holds the current set (written now, or unchanged since the newest confirmed write and not
  // due), false when the write failed.
  async function publish({ exiting = false } = {}, retries = 0) {
    if (!configured()) return true;
    const at = now(), un = compute();
    const items = [...un.paths, ...un.ids.map(i => `id:${i}`), ...un.predictions.map(p => `p:${p}`)];
    if (!due(confirmed, items, at)) return true;
    if (exiting) onExit?.();
    try {
      await send({ at, paths: un.paths, ids: un.ids, predictions: un.predictions });
      if (!confirmed || at >= confirmed.at) confirmed = { at, paths: items };
      return true;
    } catch (e) {
      const stored = staleAt ? staleAt(e) : NaN;
      if (retries >= MAX_STALE_RETRIES || !Number.isFinite(stored)) return false;
      advance?.(stored);
      return publish({ exiting }, retries + 1);
    }
  }
  return { publish, confirmed: () => confirmed };
}
