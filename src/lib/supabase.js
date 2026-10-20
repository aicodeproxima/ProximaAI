// ─── ProximaAI Supabase Cloud Sync ───
// Loads Supabase from CDN at runtime. Uses a device-scoped model — each device
// gets a random UUID stored in localStorage. All rows are tagged with device_id
// and filtered by it on reads.
//
// Activated automatically when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
// Gracefully no-ops otherwise (local-only mode).

import { sessionToken, isSessionError, reportSessionExpired, isSuperseded } from "./session.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

let supabase = null;
let deviceId = null;

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
    supabase = mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      global: { headers: { "x-device-id": getDeviceId() } },
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
    return (data || []).map(row => ({
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
    }));
  } catch (err) { warnOnce("pullTasks", err); return []; }
}

// Prediction ids of this account's tasks started in [after, before] (ms), on any device: the lost-submit lookup must
// never adopt a prediction another device's task owns (its row may not have reached this device yet). null = the
// read failed (the caller then decides nothing this pass).
export async function pullTaskIdsInWindow(after, before) {
  if (!supabase) return new Set();
  try {
    const { data, error } = await supabase.from("tasks").select("task_id")
      .eq("device_id", getDeviceId()).not("task_id", "is", null)
      .gte("start_time", after).lte("start_time", before).limit(1000);
    if (error) throw error;
    return new Set((data || []).map(r => r.task_id));
  } catch (err) { warnOnce("pullTaskIdsInWindow", err); return null; }
}

export async function deleteTaskRemote(id) {
  if (!supabase) return;
  try {
    await supabase.from("tasks").delete().eq("id", id).eq("device_id", getDeviceId());
  } catch (err) { warnOnce("deleteTaskRemote", err); }
}

// Bulk-delete specific task ids from the cloud, scoped to this device/user.
// Returns { ok } so callers can keep the failed-sync replay queue honest.
export async function deleteTasksRemote(ids) {
  if (!supabase) return { ok: false };
  const list = (ids || []).filter(Boolean);
  if (list.length === 0) return { ok: true };
  try {
    const { error } = await supabase
      .from("tasks")
      .delete()
      .in("id", list)
      .eq("device_id", getDeviceId());
    if (error) { warnOnce("deleteTasksRemote", error); return { ok: false, error: error.message }; }
    return { ok: true };
  } catch (err) { warnOnce("deleteTasksRemote", err); return { ok: false, error: err?.message }; }
}

export async function clearTasksRemote() {
  if (!supabase) return;
  try {
    await supabase.from("tasks").delete().eq("device_id", getDeviceId());
  } catch (err) { warnOnce("clearTasksRemote", err); }
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
    return (data || []).map(row => ({
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
    }));
  } catch (err) { warnOnce("pullHistory", err); return null; }
}

// Bulk-delete specific history (log) ids from the cloud, scoped to this device/user.
export async function deleteHistoryRemote(ids) {
  if (!supabase) return { ok: false };
  const list = (ids || []).filter(Boolean);
  if (list.length === 0) return { ok: true };
  try {
    const { error } = await supabase
      .from("history")
      .delete()
      .in("id", list)
      .eq("device_id", getDeviceId());
    if (error) { warnOnce("deleteHistoryRemote", error); return { ok: false, error: error.message }; }
    return { ok: true };
  } catch (err) { warnOnce("deleteHistoryRemote", err); return { ok: false, error: err?.message }; }
}

export async function clearHistoryRemote() {
  if (!supabase) return;
  try {
    await supabase.from("history").delete().eq("device_id", getDeviceId());
  } catch (err) { warnOnce("clearHistoryRemote", err); }
}

export async function clearSettingsRemote() {
  if (!supabase) return;
  try {
    await supabase.from("settings").delete().eq("device_id", getDeviceId());
  } catch (err) { warnOnce("clearSettingsRemote", err); }
}

export async function clearFavoritesRemote() {
  if (!supabase) return;
  try {
    await supabase.from("favorites").delete().eq("device_id", getDeviceId());
  } catch (err) { warnOnce("clearFavoritesRemote", err); }
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

export async function pullSettings() {
  if (!supabase) return {};
  try {
    const { data } = await supabase
      .from("settings")
      .select("*")
      .eq("device_id", getDeviceId());
    const map = {};
    for (const row of data || []) map[row.key] = row.value;
    return map;
  } catch (err) { warnOnce("pullSettings", err); return {}; }
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
async function pullAllIds(table, kind) {
  const ids = new Set();
  let last = null;
  for (;;) {
    let q = supabase.from(table).select("id").eq("device_id", getDeviceId()).order("id").limit(1000);
    if (kind) q = q.eq("kind", kind);
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return null;
    for (const row of data) ids.add(row.id);
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
    const [taskTombstones, historyTombstones] = await Promise.all([
      pullAllIds("sync_tombstones", "task"), pullAllIds("sync_tombstones", "history"),
    ]);
    return { tasks, history, taskTombstones, historyTombstones };
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

// Live updates: calls onChange for any insert/update/delete on this scope's tasks or history.
// Realtime can't filter DELETE events server-side, so they arrive unfiltered; tasks/history use
// REPLICA IDENTITY FULL (migration 20261020000002) so the old row carries device_id and other
// scopes' deletes are dropped here instead of triggering a full reconcile on every client.
export function subscribeToCloudChanges(onChange) {
  if (!supabase) return () => {};
  const scope = getDeviceId();
  const channel = supabase.channel(`proxima-sync-${scope}`);
  const onDelete = (payload) => {
    const owner = payload?.old?.device_id;
    if (owner && owner !== scope) return;
    onChange(payload);
  };
  for (const table of ["tasks", "history"]) {
    channel
      .on("postgres_changes", { event: "INSERT", schema: "public", table, filter: `device_id=eq.${scope}` }, onChange)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table, filter: `device_id=eq.${scope}` }, onChange)
      .on("postgres_changes", { event: "DELETE", schema: "public", table }, onDelete);
  }
  channel.subscribe();
  return () => { supabase.removeChannel(channel); };
}

// ─── Bulk Pull (for initial sync on login) ───
// Uses Promise.allSettled so one failing fetch doesn't nuke all cloud pulls.

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
    settings: results[2].status === "fulfilled" ? results[2].value : {},
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

export async function deleteArchivedPath(path) {
  if (!supabase || !path) return false;
  try {
    const { error } = await supabase.storage.from(ARCHIVE_BUCKET).remove([path]);
    return !error;
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
// e.g. after a rename or password change on another device.
export async function checkSession() {
  const r = await sessionRpc("get_my_account");
  return !!r?.ok;
}

export async function getMyAccount() {
  return sessionRpc("get_my_account");
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
