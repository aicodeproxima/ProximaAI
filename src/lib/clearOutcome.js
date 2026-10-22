// ─── Which cloud clears did not confirm ───
// Reset Everything clears several cloud tables at once (Promise.allSettled). Each clear answers {ok, error} since
// 1bd2e68 ({ok: true, localOnly: true} on a local-only install). Anything else — refused, thrown, or no answer — is
// unconfirmed, and the status must say so instead of "cleared". Returns the names (same order as `settled`) that failed.
// After a clear (review wf_ec400a67-988 #1): the removed ids the cloud no longer holds are settled (`done`); those it
// still holds stay queued (`left`). An unreadable cloud (null) settles nothing. A cloud id that was not removed is a row
// another device added after the read: not this clear's to delete.
export function clearSettlement(removedIds, cloudIds) {
  const ids = [...new Set((removedIds || []).filter(Boolean))];
  if (!cloudIds) return { done: [], left: ids };
  return { done: ids.filter(id => !cloudIds.has(id)), left: ids.filter(id => cloudIds.has(id)) };
}

export function unconfirmedClears(settled, names) {
  return names.filter((_, i) => { const r = settled?.[i]; return !(r?.status === "fulfilled" && r.value?.ok === true); });
}
