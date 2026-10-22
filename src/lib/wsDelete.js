// Deleting a generation in the app also deletes its prediction on WaveSpeed, so the result is gone from both (owner,
// 2026-10-21: "i want the delete from our app and the wavespeed servers to be synced"). Pure queue logic, tested by
// scripts/test-ws-delete.mjs; the queue lives in localStorage (storage.js) and the request is api.js deletePredictions.
//
// WaveSpeed (docs/delete-task, read 2026-10-21): POST /api/v3/predictions/delete {ids: [...]} answers
// data.deleted_ids with only what it deleted now. Running (created/processing), unknown, foreign and already-deleted ids
// are skipped silently. A delete is permanent and refunds nothing; the id stays in WaveSpeed's own history with status
// "deleted" (the lost-submit lookup never adopts those, taskResume.js planOrphans).
//
// Queue: {predictionId: {at, attempts, next, running}}. A dedicated queue, not the 200-entry failed-sync queue, so a
// mass delete never evicts pending uploads.

import { pollErrorAction, isRecoverableFailure } from "./taskResume.js";

export const WS_DELETE_CHUNK = 50;               // ids per request (WaveSpeed states no maximum)
export const RUNNING_RETRY_MS = 10 * 60 * 1000;  // a prediction still running when deleted: ask again after this
export const MAX_RUNNING_ATTEMPTS = 6;           // ~1 h of retries for one that was running
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const IN_FLIGHT = new Set(["pending", "processing"]);

// Adds the prediction ids of deleted tasks. A task never submitted has no id and nothing to delete on WaveSpeed. One
// may still be running there although the app shows it failed: Cancel only stops the app's poll, and a lost
// connection leaves WaveSpeed generating (review wf_9d0e3664-ab7 #2), so those are retried like running ones.
export function queueDeletes(queue, tasks, now) {
  const out = { ...(queue || {}) };
  for (const t of tasks) {
    if (!t?.taskId || out[t.taskId]) continue;
    const running = IN_FLIGHT.has(t.status) || t.error === "Cancelled" || isRecoverableFailure(t, now);
    out[t.taskId] = { at: now, attempts: 0, next: now, running };
  }
  return out;
}

// Ids whose turn has come, in request-sized chunks.
export function dueDeletes(queue, now) {
  const ids = Object.entries(queue || {}).filter(([, e]) => e.next <= now).map(([id]) => id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += WS_DELETE_CHUNK) chunks.push(ids.slice(i, i + WS_DELETE_CHUNK));
  return chunks;
}

// After an answer: deleted ids are done; a skipped one that was finished can never become deletable, so it is done
// too; a skipped one that was running is asked again once it can have finished, a few times at most.
export function settleDeletes(queue, sentIds, deletedIds, now) {
  const out = { ...(queue || {}) };
  const deleted = new Set(deletedIds || []);
  for (const id of sentIds) {
    const e = out[id];
    if (!e) continue;
    if (deleted.has(id) || !e.running) { delete out[id]; continue; }
    const attempts = e.attempts + 1;
    if (attempts >= MAX_RUNNING_ATTEMPTS) delete out[id];
    else out[id] = { ...e, attempts, next: now + RUNNING_RETRY_MS };
  }
  return out;
}

// After a failed request: network trouble, a rate limit or a 5xx backs off and stays; a dead session or a rejected
// key waits without counting an attempt (fixing the key unblocks it); a refusal of the request itself drops the ids.
export function failDeletes(queue, sentIds, error, now) {
  const out = { ...(queue || {}) };
  const action = pollErrorAction(error);
  const keyIssue = action === "stop";
  for (const id of sentIds) {
    const e = out[id];
    if (!e) continue;
    if (action === "fail") { delete out[id]; continue; }
    const attempts = keyIssue ? e.attempts : e.attempts + 1;
    const wait = keyIssue ? 5 * 60 * 1000 : Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 6));
    out[id] = { ...e, attempts, next: now + wait };
  }
  return out;
}

// Ids a live task holds are never sent: that task is not deleted (a restore brought it back, or a lookup paired a
// deleted claimant with a prediction a new generation owns). They are not dropped either, because a view that has not
// caught up may still show a task deleted elsewhere (review wf_ec400a67-988 #5): they wait HELD_RECHECK_MS and are
// checked again, and only after HELD_MAX_MS (every view has caught up; WaveSpeed purges its copy in ~54 h) leave unsent.
export const HELD_RECHECK_MS = 60 * 1000;
const HELD_MAX_MS = 48 * 60 * 60 * 1000;
export function holdHeldIds(queue, heldIds, now) {
  const out = { ...(queue || {}) };
  for (const id of heldIds || []) {
    if (!out[id]) continue;
    if (now - out[id].at > HELD_MAX_MS) delete out[id];
    else out[id] = { ...out[id], next: Math.max(out[id].next, now + HELD_RECHECK_MS) };
  }
  return out;
}
