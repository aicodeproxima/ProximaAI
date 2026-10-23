// ─── ProximaAI Supabase Cloud Sync ───
// Loads Supabase from CDN at runtime. Uses a device-scoped model — each device
// gets a random UUID stored in localStorage. All rows are tagged with device_id
// and filtered by it on reads.
//
// Activated automatically when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
// Gracefully no-ops otherwise (local-only mode).

import { sessionToken, isSessionError, reportSessionExpired, isSuperseded, withSessionHeader } from "./session.js";
import { removedPaths } from "./storageRemove.js";
import { createSyncPing } from "./syncPing.js";
import { withServerClock, serverNow } from "./serverClock.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

let supabase = null;
let deviceId = null;

// While the page is going away (pagehide), a settings write keeps going after it unloads: the browser's Generate-form
// hold publication, which tells the other device this tab's form let go of its uploads (review round 3). Only settings
// writes: keepalive bodies share a 64 KB budget.
let pageExiting = false;
export function setPageExiting(on) { pageExiting = !!on; }
export const withExitKeepalive = (f) => (input, init) =>
  pageExiting && String(typeof input === "string" ? input : input?.url ?? input).includes("/rest/v1/settings")
    ? f(input, { ...(init || {}), keepalive: true }) : f(input, init);

// ─── Logging helper — rate-limited per site (F.6.1) ────────────────────────
// Cooldown of 60s per call-site so a flapping path doesn't flood the console.
// Phase 4 Order 12 routes these to Sentry; for now console only.
const _warnedRecently = new Map();
function warnOnce(siteKey, err) {
  const now = Date.now();
  const last = _warnedRecently.get(siteKey) || 0;
  if (now - last < 60000) return;
  _warnedRecently.set(siteKey, now);
  const msg = err?.message || err?.error?.message || String(err);
  console.warn(`[supabase:${siteKey}] ${msg}`);
}

export function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

export function getDeviceId() {
  // Use logged-in username as scope key — enables cross-device data sync
  try {
    const user = localStorage.getItem("proximaai-user");
    if (user) return `user:${user}`;
  } catch {}  // intentional: SSR/privacy mode — fall through to device-id path
  // Fallback: random device ID for anonymous/pre-login sessions
  if (deviceId) return deviceId;
  try {
    let id = localStorage.getItem("proximaai-device-id");
    if (!id) {
      id = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem("proximaai-device-id", id);
    }
    deviceId = id;
    return id;
  } catch {
    return "anonymous";
  }
}

// Reset cached device ID — call after login/logout so next getDeviceId() re-reads
export function resetDeviceIdCache() {
  deviceId = null;
}

export async function initSupabase() {
  if (!isSupabaseConfigured()) return null;
  if (supabase) return supabase;
  try {
    const cdnUrl = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm";
    const mod = await import(/* @vite-ignore */ cdnUrl);
    // Every REST and Storage request carries the session token (session.js withSessionHeader): the row policies admit
    // only requests whose token the server verifies. fetch is captured here, as supabase-js did by default.
    supabase = mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      global: { headers: { "x-device-id": getDeviceId() },
        // withServerClock: each response's Date header keeps this device's estimate of the server clock (serverClock.js).
        fetch: withServerClock(withExitKeepalive(withSessionHeader(globalThis.fetch.bind(globalThis), { baseUrl: SUPABASE_URL }))) },
    });
    return supabase;
  } catch {
    return null;
  }
}

// Record the timestamp of any successful cloud write. Used by Settings to display
// "Last cloud sync". Throttled to avoid localStorage churn.
let _lastSyncWrite = 0;
export function touchSync() {
  const now = Date.now();
  if (now - _lastSyncWrite < 500) return;
  _lastSyncWrite = now;
  try { localStorage.setItem("proximaai_last_sync_at", String(now)); } catch {}  // intentional: quota errors handled by failed-sync queue
}

// ─── Task Sync ───

// Uploads resolve only on a confirmed write and throw otherwise, so callers keep the row in the
// failed-sync queue. (They used to resolve on error, which dropped the row from the queue and left
// it on this device only — and cross-device sync would then treat it as deleted elsewhere.)
function requireClient() {
  if (supabase) return true;
  if (!isSupabaseConfigured()) return false; // local-only install: nothing to sync
  throw new Error("Cloud sync is not initialized");
}

export function taskToRow(task) {
  return {
    id: task.id,
    device_id: getDeviceId(),
    batch_id: task.batchId ?? null,
    model_id: task.modelId ?? null,
    model_name: task.modelName ?? null,
    provider: task.provider ?? null,
    price: task.price ?? 0,
    status: task.status ?? null,
    gen_type: task.genType ?? null,
    prompt: task.prompt ?? null,
    neg_prompt: task.negPrompt ?? null,
    resolution: task.resolution ?? null,
    duration: task.duration ?? null,
    seed: task.seed ?? null,
    aspect_ratio: task.aspectRatio ?? null,
    source_image_url: task.sourceImageUrl ?? null,
    source_image_urls: task.sourceImageUrls ?? [],
    // The other uploaded inputs travel too, so a delete anywhere finds their files (migration 20261022190000).
    end_frame_url: task.endFrameUrl ?? null,
    source_audio_url: task.sourceAudioUrl ?? null,
    source_video_url: task.sourceVideoUrl ?? null,
    ref_video_url: task.refVideoUrl ?? null,
    num_images: task.numImages ?? 1,
    outputs: task.outputs ?? [],
    error: task.error ?? null,
    start_time: task.startTime ?? null,
    end_time: task.endTime ?? null,
    wall_clock_ms: task.wallClockMs ?? 0,
    inference_ms: task.inferenceMs ?? 0,
    per_model_resolution: task.perModelResolution ?? null,
    nsfw: task.nsfw ?? null,
    task_id: task.taskId ?? null,
  };
}

export async function syncTask(task) {
  if (!task?.id || !requireClient()) return;
  try {
    const r = await supabase.from("tasks").upsert(taskToRow(task), { onConflict: "id" });
    if (r.error) throw r.error;
    touchSync();
  } catch (err) { warnOnce("syncTask", err); throw err; }
}

// Batch version — single upsert for multiple tasks at once
export async function syncTasksBatch(tasks) {
  if (!tasks?.length || !requireClient()) return;
  try {
    const rows = tasks.filter(t => t?.id).map(taskToRow);
    if (rows.length > 0) {
      const r = await supabase.from("tasks").upsert(rows, { onConflict: "id" });
      if (r.error) throw r.error;
      touchSync();
    }
  } catch (err) { warnOnce("syncTasksBatch", err); throw err; }
}

// A cloud tasks row as the app's task object (pullTasks, pullAllForPurge).
const rowToTask = (row) => ({
  id: row.id,
  batchId: row.batch_id,
  modelId: row.model_id,
  modelName: row.model_name,
  provider: row.provider,
  price: row.price ?? 0,
  status: row.status,
  genType: row.gen_type,
  prompt: row.prompt,
  negPrompt: row.neg_prompt,
  resolution: row.resolution,
  duration: row.duration,
  seed: row.seed,
  aspectRatio: row.aspect_ratio,
  sourceImageUrl: row.source_image_url,
  sourceImageUrls: row.source_image_urls ?? [],
  endFrameUrl: row.end_frame_url ?? null,
  sourceAudioUrl: row.source_audio_url ?? null,
  sourceVideoUrl: row.source_video_url ?? null,
  refVideoUrl: row.ref_video_url ?? null,
  numImages: row.num_images ?? 1,
  outputs: row.outputs ?? [],
  error: row.error,
  startTime: row.start_time,
  endTime: row.end_time,
  wallClockMs: row.wall_clock_ms ?? 0,
  inferenceMs: row.inference_ms ?? 0,
  perModelResolution: row.per_model_resolution ?? null,
  nsfw: row.nsfw ?? null,
  taskId: row.task_id ?? null,
});

export async function pullTasks(limit = 500) {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("device_id", getDeviceId())
      .in("status", ["completed", "failed", "processing"]) // running rows: another device may be frozen mid-generation
      .order("start_time", { ascending: false })
      .limit(limit);
    return (data || []).map(rowToTask);
  } catch (err) { warnOnce("pullTasks", err); return []; }
}

// This account's task rows started in [after, before] (ms), on any device, as {id, modelId, startTime, taskId}: the
// lost-submit lookup never adopts a prediction another device's task owns (its row may not have reached this device
// yet), and a deleted claimant's prediction is deleted only when no other row of its model started in its window, even
// one still waiting for its id (review wf_ec400a67-988 #10). null = the read failed (the caller then decides nothing).
export async function pullTaskStartsInWindow(after, before) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from("tasks").select("id,model_id,start_time,task_id")
      .eq("device_id", getDeviceId()).gte("start_time", after).lte("start_time", before).limit(1000);
    if (error) throw error;
    return (data || []).map(r => ({ id: r.id, modelId: r.model_id, startTime: r.start_time, taskId: r.task_id ?? null }));
  } catch (err) { warnOnce("pullTaskStartsInWindow", err); return null; }
}

// Every delete or clear of this account's rows goes through a restore-checked server function (delete_queued_rows,
// clear_queued_rows). The plain scoped deletes are gone (review round 9): Reset's settings clear, the last one in use,
// deleted the restore marker and wiped a restore that landed after the checked clears.

// Through delete_queued_rows (review round 6): the server records a user tombstone even for a generation without a tasks
// row (History-only, e.g. after a restore), so other devices drop it from History too. `queuedAt`: the action's own queue
// time (queueDeleteIntents), so a restore between queueing and sending voids it (review round 7); now when absent.
// { ok, voided, deleted }: ok only when every id was deleted; voided ids were kept by a restore and must not be purged.
export async function deleteTasksRemote(ids, queuedAt = serverNow()) {
  const r = await deleteQueuedRemote("task", ids, queuedAt);
  return { ok: r.ok && !r.voided.length, voided: r.voided, deleted: r.deleted, ...(r.ok ? {} : { error: "delete_queued_rows failed" }) };
}

// A replayed delete intent (queued earlier, still pending): the server refuses it when a restore committed after
// `queuedAt` (server-time ms, serverClock.js), atomically with the delete (delete_queued_rows, review round 4). Chunks of
// 100; each chunk's ids come back voided or deleted. { ok: false } when any chunk failed (its intents stay queued).
export async function deleteQueuedRemote(kind, ids, queuedAt) {
  const list = (ids || []).filter(Boolean);
  const out = { ok: true, voided: [], deleted: [] };
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const r = await sessionRpc("delete_queued_rows", { p_kind: kind, p_ids: chunk, p_queued_at: Math.floor(queuedAt || 0) });
      (r?.voided ? out.voided : out.deleted).push(...chunk);
    } catch (err) { warnOnce("deleteQueuedRemote", err); out.ok = false; }
  }
  if (out.deleted.length) touchSync();
  return out;
}

// ─── History Sync ───

export function historyToRow(entry) {
  return {
    id: entry.id,
    device_id: getDeviceId(),
    timestamp: entry.timestamp ?? Date.now(),
    prompt: entry.prompt ?? null,
    neg_prompt: entry.negPrompt ?? null,
    gen_type: entry.genType ?? null,
    models: entry.models ?? [],
    resolution: entry.resolution ?? null,
    duration: entry.duration ?? null,
    seed: entry.seed ?? null,
    aspect_ratio: entry.aspectRatio ?? null,
    source_image_url: entry.sourceImageUrl ?? null,
    source_image_urls: entry.sourceImageUrls ?? [],
    num_images: entry.numImages ?? 1,
    tasks: entry.tasks ?? [],
    total_cost: entry.totalCost ?? 0,
  };
}

export async function syncHistoryEntry(entry) {
  if (!entry?.id || !requireClient()) return;
  try {
    const r = await supabase.from("history").upsert(historyToRow(entry), { onConflict: "id" });
    if (r.error) throw r.error;
    touchSync();
  } catch (err) { warnOnce("syncHistoryEntry", err); throw err; }
}

// null when the read failed (an empty History and a failed read used to look the same: [] either way).
// A cloud history row as the app's log entry (pullHistory, pullAllForPurge).
const rowToLog = (row) => ({
  id: row.id,
  timestamp: row.timestamp,
  prompt: row.prompt,
  negPrompt: row.neg_prompt,
  genType: row.gen_type,
  models: row.models || [],
  resolution: row.resolution,
  duration: row.duration,
  seed: row.seed,
  aspectRatio: row.aspect_ratio,
  sourceImageUrl: row.source_image_url,
  sourceImageUrls: row.source_image_urls || [],
  numImages: row.num_images || 1,
  tasks: row.tasks || [],
  totalCost: row.total_cost,
});

export async function pullHistory(limit = 500) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("history")
      .select("*")
      .eq("device_id", getDeviceId())
      .order("timestamp", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(rowToLog);
  } catch (err) { warnOnce("pullHistory", err); return null; }
}

// History (log) deletes go through delete_queued_rows too, at the action's queue time (review round 8): a restore that
// landed after it voids them. { ok, voided, deleted } as deleteTasksRemote; chunks of 100 (deleteQueuedRemote).
export async function deleteHistoryRemote(ids, queuedAt = serverNow()) {
  const r = await deleteQueuedRemote("history", ids, queuedAt);
  return { ok: r.ok && !r.voided.length, voided: r.voided, deleted: r.deleted, ...(r.ok ? {} : { error: "delete_queued_rows failed" }) };
}

// The server's own clock in ms (server_time_ms, review round 11): Clear Outputs / Reset take their snapshot from it, not
// from this device's estimate. null when it cannot be read; the caller then clears nothing.
export async function serverTimeRemote() {
  try {
    const r = await sessionRpc("server_time_ms", {});
    if (r == null || r === "") return null;
    const t = Number(r);
    return Number.isFinite(t) ? t : null;
  } catch (err) { warnOnce("serverTimeRemote", err); return null; }
}

// Clear Logs / Clear Outputs / Reset: every row of one kind of this account, through clear_queued_rows at the action's
// queue time (review round 8): voided when a restore landed after it; for tasks the server also strips their History.
// Kinds task, history, settings (the restore marker and form holds stay) and favorites. A clear takes the rows that
// existed when it was queued plus `ids`, the ones this device knew (review round 9): a row another device created
// later stays, and a named generation without a row that History holds gets a user tombstone.
export async function clearQueuedRemote(kind, queuedAt, ids) {
  try {
    const args = { p_kind: kind, p_queued_at: Math.floor(queuedAt || 0) };
    if (ids) args.p_ids = [...new Set(ids.filter(Boolean))];
    const r = await sessionRpc("clear_queued_rows", args);
    return { ok: !!r?.ok && !r?.voided, voided: !!r?.voided, deleted: r?.deleted ?? 0 };
  } catch (err) { warnOnce("clearQueuedRemote", err); return { ok: false, voided: false, deleted: 0 }; }
}

// Reset Everything: History, generations, settings and favorites of this account through reset_queued_rows, in one
// transaction under one restore check (review round 10: four separate calls could be half-voided by a restore landing
// between them). `queuedAt` is the snapshot time taken before the purge read; `taskIds` / `historyIds` the ids this
// device knew. `prefsAt` (review round 11): the exact snapshot that bounds settings and favorites (nothing else purges
// them, so no slack); left out, the server uses queuedAt. { ok, voided, deleted: { history, task, settings, favorites } | null }.
export async function resetQueuedRemote(queuedAt, taskIds, historyIds, prefsAt) {
  const uniq = (ids) => [...new Set((ids || []).filter(Boolean))];
  try {
    const args = { p_queued_at: Math.floor(queuedAt || 0), p_task_ids: uniq(taskIds), p_history_ids: uniq(historyIds) };
    if (Number.isFinite(prefsAt)) args.p_prefs_at = Math.floor(prefsAt);
    const r = await sessionRpc("reset_queued_rows", args);
    return { ok: !!r?.ok && !r?.voided, voided: !!r?.voided, deleted: r?.deleted ?? null };
  } catch (err) { warnOnce("resetQueuedRemote", err); return { ok: false, voided: false, deleted: null }; }
}

// A delete's History rewrites (entries losing items without an id; the server strips the items with one itself) go
// through upsert_queued_history at the delete's queue time (review round 9): a restore that landed after it voids them,
// as it voids the delete. 100 per call. { ok, voided: ids, upserted: ids }.
export async function upsertQueuedHistory(entries, queuedAt) {
  const list = (entries || []).filter(e => e?.id);
  const out = { ok: true, voided: [], upserted: [] };
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const r = await sessionRpc("upsert_queued_history", { p_entries: chunk.map(historyToRow), p_queued_at: Math.floor(queuedAt || 0) });
      (r?.voided ? out.voided : out.upserted).push(...chunk.map(e => e.id));
    } catch (err) { warnOnce("upsertQueuedHistory", err); out.ok = false; }
  }
  if (out.upserted.length) touchSync();
  return out;
}

// ─── Settings Sync ───

export async function syncSetting(key, value, deviceScope = getDeviceId()) {
  // Local-only installations have nothing to sync. A configured client that has
  // not initialized yet is a real failure so the caller's retry queue stays intact.
  if (!supabase) {
    if (!isSupabaseConfigured()) return { ok: true, localOnly: true };
    throw new Error("Cloud sync is not initialized");
  }
  try {
    const r = await supabase.from("settings").upsert({
      device_id: deviceScope,
      key,
      value,
      updated_at: new Date().toISOString(),
    });
    if (r.error) throw r.error;
    touchSync();
    return { ok: true };
  } catch (err) {
    warnOnce("syncSetting", err);
    throw err;
  }
}

// null when the read failed or was refused: "unknown", never "no settings" (the restore check, storage.js restoreGuard,
// would otherwise see no restore and replay delete intents a restore voided; review round 3).
export async function pullSettings() {
  if (!supabase) return {};
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("*")
      .eq("device_id", getDeviceId());
    if (error) throw error;
    const map = {};
    for (const row of data || []) map[row.key] = row.value;
    return map;
  } catch (err) { warnOnce("pullSettings", err); return null; }
}

// ─── Favorites Sync ───

export async function syncFavorite(fav) {
  if (!supabase) return;
  try {
    await supabase.from("favorites").upsert({
      id: fav.id,
      device_id: getDeviceId(),
      prompt: fav.prompt || null,
      tags: fav.tags || [],
    });
  } catch (err) { warnOnce("syncFavorite", err); }
}

export async function pullFavorites() {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("favorites")
      .select("*")
      .eq("device_id", getDeviceId())
      .order("created_at", { ascending: false });
    return (data || []).map(row => ({
      id: row.id,
      prompt: row.prompt,
      tags: row.tags || [],
      createdAt: row.created_at,
    }));
  } catch (err) { warnOnce("pullFavorites", err); return []; }
}

// ─── Cross-device sync support ───

// Every id in a table for this scope (optionally narrowed by `kind`), keyset-paged past PostgREST's
// 1000-row cap (keyset, not offsets, so a concurrent delete can't shift rows out of an unread page).
// A failed read returns null — never an empty set — so a network blip can't look like "everything
// was deleted" or "nothing was ever uploaded".
// `byRestore`: also collect the ids of tombstones a restore wrote (sync_tombstones.by_restore), which are not deletes.
async function pullAllIds(table, kind, byRestore = null) {
  const ids = new Set();
  let last = null;
  for (;;) {
    let q = supabase.from(table).select(byRestore ? "id,by_restore" : "id").eq("device_id", getDeviceId()).order("id").limit(1000);
    if (kind) q = q.eq("kind", kind);
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return null;
    for (const row of data) { ids.add(row.id); if (byRestore && row.by_restore === true) byRestore.add(row.id); }
    if (data.length < 1000) return ids;
    last = data[data.length - 1].id;
  }
}

// The cloud's ids plus the server's record of deleted ids (sync_tombstones, kept by DB triggers).
// Tombstones are read strictly AFTER the ids: a delete committing between the two reads then shows up
// as a tombstone (→ remove) instead of looking like a never-uploaded row (→ re-upload = undo the delete).
export async function pullCloudIds() {
  if (!supabase) return null;
  try {
    const [tasks, history] = await Promise.all([pullAllIds("tasks"), pullAllIds("history")]);
    // Tasks a restore removed are reported apart (taskRestoreRemoved): they leave this device, but their History items
    // stay (review round 5).
    const taskRestoreRemoved = new Set();
    const [taskTombstones, historyTombstones] = await Promise.all([
      pullAllIds("sync_tombstones", "task", taskRestoreRemoved), pullAllIds("sync_tombstones", "history"),
    ]);
    return { tasks, history, taskTombstones, historyTombstones, taskRestoreRemoved: taskTombstones ? taskRestoreRemoved : null };
  } catch (err) { warnOnce("pullCloudIds", err); return null; }
}

// Batch upload of history entries (sync uploads local-only rows the cloud never received).
export async function syncHistoryBatch(entries) {
  if (!entries?.length || !requireClient()) return;
  try {
    const rows = entries.filter(e => e?.id).map(historyToRow);
    if (rows.length > 0) {
      const r = await supabase.from("history").upsert(rows, { onConflict: "id" });
      if (r.error) throw r.error;
      touchSync();
    }
  } catch (err) { warnOnce("syncHistoryBatch", err); throw err; }
}

// Live updates: calls onChange when the database pings this account's secret topic after a change to tasks or history
// (syncPing.js). The topic arrives with every get_my_account answer (checkSession runs before each reconcile), so the
// channel opens after the first reconcile and follows rotations.
const syncPing = createSyncPing(() => supabase);
export function subscribeToCloudChanges(onChange) {
  if (!supabase) return () => {};
  return syncPing.subscribe(() => onChange());
}

// ─── Bulk Pull (for initial sync on login) ───
// Uses Promise.allSettled so one failing fetch doesn't nuke all cloud pulls.

// Every task and History row of this account (any status, every page), for Clear Outputs / Reset Everything: their
// purge (WaveSpeed copies, files, History) must cover rows beyond the 500 the app loads (review wf_ec400a67-988 #3).
// Keyset-paged by id like pullAllIds. null when any page fails: the caller then clears nothing.
export async function pullAllForPurge() {
  if (!supabase) return null;
  const all = async (table, map) => {
    const out = [];
    for (let last = null; ;) {
      let q = supabase.from(table).select("*").eq("device_id", getDeviceId()).order("id").limit(1000);
      if (last !== null) q = q.gt("id", last);
      const { data, error } = await q;
      if (error || !Array.isArray(data)) return null;
      out.push(...data.map(map));
      if (data.length < 1000) return out;
      last = data[data.length - 1].id;
    }
  };
  try {
    // Tasks rows and History entries carry their row's created_at: Clear Outputs / Reset skip the ones created after
    // their snapshot time (review rounds 10 and 12).
    const tasks = await all("tasks", (row) => ({ ...rowToTask(row), createdAt: row.created_at }));
    const history = tasks && await all("history", (row) => ({ ...rowToLog(row), createdAt: row.created_at }));
    return tasks && history ? { tasks, history } : null;
  } catch (err) { warnOnce("pullAllForPurge", err); return null; }
}

export async function pullAllRemoteData() {
  if (!supabase) return null;
  const results = await Promise.allSettled([
    pullTasks(500),
    pullHistory(1000),
    pullSettings(),
    pullFavorites(),
  ]);
  return {
    tasks: results[0].status === "fulfilled" ? results[0].value : [],
    history: results[1].status === "fulfilled" && Array.isArray(results[1].value) ? results[1].value : [],
    // Whether History really answered: entries are finished locally only after a pass that saw the cloud's copies.
    historyOk: results[1].status === "fulfilled" && Array.isArray(results[1].value),
    settings: results[2].status === "fulfilled" ? results[2].value : null,   // null = unreadable (pullSettings)
    favorites: results[3].status === "fulfilled" ? results[3].value : [],
  };
}

// ─── Cloud Archive: store actual image/video bytes in Supabase Storage ───
// WaveSpeed CDN URLs expire ~24h. If archive is enabled, we fetch each
// output, upload the bytes to `generations` bucket, and swap the URL on
// the task to the permanent Supabase Storage URL.

const ARCHIVE_BUCKET = "generations";

export async function archiveUrl(url, { taskId, index = 0 } = {}) {
  if (!supabase) return { ok: false, error: "Cloud not configured" };
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { ok: false, error: `Fetch failed ${resp.status}` };
    const blob = await resp.blob();
    // Infer extension from content-type (video/mp4 -> mp4, image/png -> png)
    const ct = blob.type || resp.headers.get("content-type") || "application/octet-stream";
    const ext = (ct.split("/")[1] || "bin").split(";")[0];
    const username = getDeviceId().replace(/[^a-zA-Z0-9_-]/g, "_");
    const id = taskId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    const path = `${username}/${id}-${index}.${ext}`;
    const { error } = await supabase.storage.from(ARCHIVE_BUCKET).upload(path, blob, {
      contentType: ct, upsert: true, cacheControl: "31536000",
    });
    if (error) return { ok: false, error: error.message };
    const { data: pub } = supabase.storage.from(ARCHIVE_BUCKET).getPublicUrl(path);
    return { ok: true, url: pub.publicUrl, path, size: blob.size, contentType: ct };
  } catch (e) { return { ok: false, error: e.message || "Archive failed" }; }
}

// true only when the server confirms it deleted this file (storageRemove.js): a refused or already-gone path answers 200
// with an empty list, which used to read as success.
export async function deleteArchivedPath(path) {
  if (!supabase || !path) return false;
  try {
    const { data, error } = await supabase.storage.from(ARCHIVE_BUCKET).remove([path]);
    return !error && removedPaths([path], data).has(path);
  } catch { return false; }
}

// Returns current cloud storage usage for the logged-in user (bytes + file count)
export async function getArchiveStats() {
  if (!supabase) return { bytes: 0, count: 0 };
  const username = getDeviceId().replace(/[^a-zA-Z0-9_-]/g, "_");
  try {
    const { data, error } = await supabase.storage.from(ARCHIVE_BUCKET).list(username, { limit: 1000 });
    if (error || !data) return { bytes: 0, count: 0 };
    const bytes = data.reduce((s, f) => s + (f.metadata?.size || 0), 0);
    return { bytes, count: data.length };
  } catch { return { bytes: 0, count: 0 }; }
}

// ─── Server calls that need the signed-in session ───
// Each RPC re-checks the session token server-side. A token failure signs this device out (the caller
// still gets the error); other failures are returned to the caller as-is.
async function sessionRpc(fn, args = {}) {
  await initSupabase();
  if (!supabase) throw new Error("Cloud not configured");
  const token = sessionToken();
  if (!token) { reportSessionExpired(); throw new Error("Session expired — sign in again"); }
  const { data, error } = await supabase.rpc(fn, { p_session_token: token, ...args });
  if (error) {
    if (isSessionError(error)) {
      if (isSuperseded(token)) return sessionRpc(fn, args); // token replaced mid-flight: retry once with the new one
      reportSessionExpired(token);
    }
    throw error;
  }
  return data;
}

// ─── Input media uploads (source images, end frames, audio, driving video) ───
// Public bucket path uploads/<scope>/<uuid>.<ext>; WaveSpeed fetches the file by its public URL.
export async function uploadInputFile(file) {
  await initSupabase();
  if (!supabase) throw new Error("Cloud not configured");
  const ct = file.type || "application/octet-stream";
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(file.name || "")?.[1];
  const ext = (fromName || (ct.split("/")[1] || "bin").split(";")[0]).toLowerCase();
  const scope = getDeviceId().replace(/[^a-zA-Z0-9_-]/g, "_");
  const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const path = `uploads/${scope}/${id}.${ext}`;
  const { error } = await supabase.storage.from(ARCHIVE_BUCKET).upload(path, file, { contentType: ct, cacheControl: "31536000" });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return supabase.storage.from(ARCHIVE_BUCKET).getPublicUrl(path).data.publicUrl;
}

// ─── Backups: rolling snapshots of a user's full data, manual or auto ───
// Stored in data_backups (not readable by the browser); every call goes through token-checked RPCs.
// Auto-backups run via pg_cron every 2 days. Manual backups happen before destructive actions.

export async function createBackup(type = "manual", note = null) {
  try {
    const r = await sessionRpc("snapshot_my_data_phase2", { p_type: type, p_note: note });
    return r?.ok ? { ok: true, id: r.id } : { ok: false, error: r?.reason || "Backup failed" };
  } catch (e) { return { ok: false, error: e.message || "Backup failed" }; }
}

export async function listBackups(limit = 20) {
  try {
    return (await sessionRpc("list_my_backups_phase2", { p_limit: limit })) || [];
  } catch { return []; }
}

// The server takes its own pre-restore safety snapshot, then replaces tasks, history, favorites and
// settings in one transaction (all or nothing).
export async function restoreBackup(id) {
  try {
    const r = await sessionRpc("restore_my_backup_phase2", { p_backup_id: id });
    if (!r?.ok) return { ok: false, error: r?.reason === "backup_not_found" ? "Backup not found" : (r?.reason || "Restore failed") };
    return { ok: true, tasks: r.tasks_restored, history: r.history_restored };
  } catch (e) { return { ok: false, error: e.message || "Restore failed" }; }
}

export async function deleteBackup(id) {
  try {
    const r = await sessionRpc("delete_my_backup_phase2", { p_backup_id: id });
    return !!r?.ok && r.deleted_rows > 0;
  } catch { return false; }
}

// The "Automatic backups" switch (migration 20261021171500; off by default). While off, the 2-day job, the app's
// pre-* snapshots and the restore's safety snapshot take no copy, so a delete leaves nothing recoverable. null = unknown
// (read failed): callers must treat that as "do not assume a backup exists".
// The Generate-form holds every browser of this account published (settings rows form-inputs:<browser>, review
// wf_ec400a67-988 #6). null when the read failed: the file queue then keeps uploads waiting.
export async function pullFormHolds() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("settings").select("key,value").eq("device_id", getDeviceId()).like("key", "form-inputs:%");
    if (error || !Array.isArray(data)) return null;
    return data.map(r => r.value);
  } catch (err) { warnOnce("pullFormHolds", err); return null; }
}

// Which of these bucket paths a tasks or History row of this account still references, on any device and however old
// (review wf_ec400a67-988 #7): the file-delete queue never deletes one of them. null when the server could not answer.
export async function pathsInUseRemote(paths) {
  try {
    const r = await sessionRpc("paths_in_use", { p_paths: paths });
    return new Set(Array.isArray(r) ? r : []);
  } catch { return null; }
}

// Which of these WaveSpeed prediction ids a tasks row of this account still holds, on any device (review round 4): the
// WaveSpeed delete queue never sends one of them (a restore brought its row back, or another device kept it). Answers
// prediction id -> the holding row's id, so a row this device is deleting does not hold its own prediction back (review
// round 5). Chunks of 100. null when the cloud could not answer: then nothing is sent this pass.
export async function predictionsInUseRemote(ids) {
  const list = (ids || []).filter(Boolean);
  const out = new Map();
  if (!list.length) return out;
  try {
    if (!requireClient()) return out;
    for (let i = 0; i < list.length; i += 100) {
      const { data, error } = await supabase.from("tasks").select("id,task_id").eq("device_id", getDeviceId()).in("task_id", list.slice(i, i + 100));
      if (error || !Array.isArray(data)) return null;
      for (const r of data) if (r?.task_id) out.set(r.task_id, r.id);
    }
    return out;
  } catch (err) { warnOnce("predictionsInUseRemote", err); return null; }
}

// Which of these generation ids are live by the liveness rule (review round 6): a tasks row of the account, or an item
// of a live History entry with no user tombstone (a generation a restore brought back History-only). Chunks of 200. null
// when the server could not answer: then the WaveSpeed queue sends nothing this pass.
export async function generationsLiveRemote(ids) {
  const list = (ids || []).filter(Boolean);
  const out = new Set();
  try {
    for (let i = 0; i < list.length; i += 200) {
      const r = await sessionRpc("generations_live", { p_ids: list.slice(i, i + 200) });
      for (const id of Array.isArray(r) ? r : []) out.add(id);
    }
    return out;
  } catch (err) { warnOnce("generationsLiveRemote", err); return null; }
}

// The four input URLs of these tasks' cloud rows, whatever their age (inputBackfill, review round 4: the sync pulls only
// the newest 500, and the rows that need the backfill are the oldest). Chunks of 100. null when the read failed.
export async function pullTaskInputs(ids) {
  const list = (ids || []).filter(Boolean);
  const out = [];
  try {
    if (!list.length || !requireClient()) return out;
    for (let i = 0; i < list.length; i += 100) {
      const { data, error } = await supabase.from("tasks").select("id,end_frame_url,source_audio_url,source_video_url,ref_video_url")
        .eq("device_id", getDeviceId()).in("id", list.slice(i, i + 100));
      if (error || !Array.isArray(data)) return null;
      for (const r of data) out.push({ id: r.id, endFrameUrl: r.end_frame_url ?? null, sourceAudioUrl: r.source_audio_url ?? null,
        sourceVideoUrl: r.source_video_url ?? null, refVideoUrl: r.ref_video_url ?? null });
    }
    return out;
  } catch (err) { warnOnce("pullTaskInputs", err); return null; }
}

// Task B13a (review round 26 #2): which of these generation ids have a tasks row in this account's scope now (any age),
// through the session client (one scoped select of ids, chunks of 100). Clear Outputs reads it right after a successful
// clear: only its unnamed History-only ids whose row the server left in place are "assumed" confirms. null when the read
// failed.
export async function taskRowsPresentRemote(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  const out = new Set();
  try {
    if (!list.length) return out;
    if (!requireClient()) return null;
    for (let i = 0; i < list.length; i += 100) {
      const { data, error } = await supabase.from("tasks").select("id").eq("device_id", getDeviceId()).in("id", list.slice(i, i + 100));
      if (error || !Array.isArray(data)) return null;
      for (const r of data) if (r?.id) out.add(r.id);
    }
    return out;
  } catch (err) { warnOnce("taskRowsPresentRemote", err); return null; }
}

// The input URLs older rows lack (syncReconcile.js inputBackfill, review round 3): one narrow update per row, only those
// columns, only in this account's scope. { ok: false } when any was refused; the next pass derives them again.
export async function backfillTaskInputs(rows) {
  if (!rows?.length || !requireClient()) return { ok: true };
  let ok = true;
  for (const { id, ...cols } of rows) {
    try {
      const r = await supabase.from("tasks").update(cols).eq("id", id).eq("device_id", getDeviceId());
      if (r.error) { ok = false; warnOnce("backfillTaskInputs", r.error); }
    } catch (err) { ok = false; warnOnce("backfillTaskInputs", err); }
  }
  return { ok };
}

export async function getAutoBackups() {
  try { return !!(await sessionRpc("get_auto_backups")); } catch { return null; }
}
export async function setAutoBackups(enabled) {
  return !!(await sessionRpc("set_auto_backups", { p_enabled: !!enabled }));
}
// Removes deleted generations (task ids), their History entries (log ids) and their items from existing backups.
export async function purgeMyBackupsOf(taskIds, logIds) {
  const r = await sessionRpc("purge_my_backups_of", { p_task_ids: taskIds || [], p_log_ids: logIds || [] });
  if (!r?.ok) throw new Error("Backup purge failed");
  return r;
}

// ─── Sign-in and account (server-side; bcrypt; 3 failed sign-ins lock it until a backup code unlocks) ───

// Returns the server's answer: { ok, token, expires_at, username, rehash_required } or
// { ok:false, reason: "invalid" (attempts_left) | "locked" | "not_provisioned" }. Throws only when the
// server can't be reached, so a network failure is never shown as a wrong password.
export async function signIn(username, password) {
  await initSupabase();
  if (!supabase) throw new Error("Cloud not configured");
  const { data, error } = await supabase.rpc("verify_admin", { p_username: username, p_password: password });
  if (error) throw error;
  if (data?.ok && data.rehash_required) {
    // Legacy sha256 password: store it as bcrypt now. The server only accepts the same password here.
    supabase.rpc("set_admin_credentials_rehash", { p_session_token: data.token, p_plain_password: password }).then(() => {}, () => {});
  }
  return data || { ok: false, reason: "invalid" };
}

export async function unlockWithBackupCode(code, newPassword = null) {
  await initSupabase();
  if (!supabase) throw new Error("Cloud not configured");
  const { data, error } = await supabase.rpc("unlock_admin_with_backup_code", { p_code: code, p_new_password: newPassword || null });
  if (error) throw error;
  return data || { ok: false, reason: "invalid" };
}

// A token-checked no-op. Throws (and signs this device out) once the server stops accepting the session —
// e.g. after a rename or password change on another device. Its answer also carries the live-update topic.
export async function checkSession() {
  const r = await sessionRpc("get_my_account");
  syncPing.setTopic(r?.sync_topic);
  return !!r?.ok;
}

export async function getMyAccount() {
  const r = await sessionRpc("get_my_account");
  syncPing.setTopic(r?.sync_topic);
  return r;
}

export async function setMyAccount({ email, emailVerified, lastVerifiedAt }) {
  const r = await sessionRpc("set_my_account", {
    p_email: email ?? null,
    p_email_verified: emailVerified ?? null,
    p_last_verified_at: lastVerifiedAt == null ? null : Number(lastVerifiedAt),
  });
  return !!r?.ok;
}

// The three below re-check the current password server-side; a wrong one counts toward the lockout.
export async function changeMyPassword(currentPassword, newPassword) {
  return sessionRpc("change_my_password", { p_current_password: currentPassword, p_new_password: newPassword });
}

export async function renameMyAccount(currentPassword, newUsername) {
  return sessionRpc("rename_my_account", { p_current_password: currentPassword, p_new_username: newUsername });
}

export async function setBackupCode(currentPassword, code) {
  return sessionRpc("set_admin_backup_code", { p_current_password: currentPassword, p_code: code });
}

// The WaveSpeed key is written to the server's protected store and never kept in the browser.
export async function saveWavespeedKey(key) {
  const r = await sessionRpc("set_my_wavespeed_key", { p_key: key });
  return !!r?.ok;
}

// ─── Email OTP via Supabase Auth ───
// Uses supabase.auth.signInWithOtp + verifyOtp to send/verify 6-digit email codes.
// We discard the resulting auth session — we just use it for email verification.

export async function sendEmailOtp(email) {
  if (!supabase) return { ok: false, error: "Cloud sync not configured" };
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true }
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || "Failed to send code" }; }
}

export async function verifyEmailOtp(email, token) {
  if (!supabase) return { ok: false, error: "Cloud sync not configured" };
  try {
    const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
    if (error) return { ok: false, error: error.message };
    // Immediately sign out from Supabase Auth — we use our own auth system
    try { await supabase.auth.signOut(); } catch {}  // intentional: we use our own auth; signOut failure is benign
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || "Verification failed" }; }
}
