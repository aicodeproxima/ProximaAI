// ─── Which cloud clears did not confirm ───
// Reset Everything clears several cloud tables at once (Promise.allSettled). Each clear answers {ok, error} since
// 1bd2e68 ({ok: true, localOnly: true} on a local-only install). Anything else — refused, thrown, or no answer — is
// unconfirmed, and the status must say so instead of "cleared". Returns the names (same order as `settled`) that failed.
export function unconfirmedClears(settled, names) {
  return names.filter((_, i) => { const r = settled?.[i]; return !(r?.status === "fulfilled" && r.value?.ok === true); });
}
