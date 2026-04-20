// ─── ProximaAI Supabase Cloud Sync ───
// Loads Supabase from CDN at runtime. Uses a device-scoped model — each device
// gets a random UUID stored in localStorage. All rows are tagged with device_id
// and filtered by it on reads.
//
// Activated automatically when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
// Gracefully no-ops otherwise (local-only mode).

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

let supabase = null;
let deviceId = null;

export function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

export function getDeviceId() {
  // Use logged-in username as scope key — enables cross-device data sync
  try {
    const user = localStorage.getItem("proximaai-user");
    if (user) return `user:${user}`;
  } catch {}
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

// ─── Task Sync ───

export async function syncTask(task) {
  if (!supabase || !task?.id) return;
  try {
    await supabase.from("tasks").upsert({
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
    }, { onConflict: "id" });
  } catch {}
}

// Batch version — single upsert for multiple tasks at once
export async function syncTasksBatch(tasks) {
  if (!supabase || !tasks?.length) return;
  try {
    const rows = tasks.filter(t => t?.id).map(task => ({
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
    }));
    if (rows.length > 0) {
      await supabase.from("tasks").upsert(rows, { onConflict: "id" });
    }
  } catch {}
}

export async function pullTasks(limit = 500) {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("device_id", getDeviceId())
      .in("status", ["completed", "failed"])
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
  } catch { return []; }
}

export async function deleteTaskRemote(id) {
  if (!supabase) return;
  try {
    await supabase.from("tasks").delete().eq("id", id).eq("device_id", getDeviceId());
  } catch {}
}

export async function clearTasksRemote() {
  if (!supabase) return;
  try {
    await supabase.from("tasks").delete().eq("device_id", getDeviceId());
  } catch {}
}

// ─── History Sync ───

export async function syncHistoryEntry(entry) {
  if (!supabase || !entry?.id) return;
  try {
    await supabase.from("history").upsert({
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
    }, { onConflict: "id" });
  } catch {}
}

export async function pullHistory(limit = 500) {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("history")
      .select("*")
      .eq("device_id", getDeviceId())
      .order("timestamp", { ascending: false })
      .limit(limit);
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
  } catch { return []; }
}

export async function clearHistoryRemote() {
  if (!supabase) return;
  try {
    await supabase.from("history").delete().eq("device_id", getDeviceId());
  } catch {}
}

export async function clearSettingsRemote() {
  if (!supabase) return;
  try {
    await supabase.from("settings").delete().eq("device_id", getDeviceId());
  } catch {}
}

export async function clearFavoritesRemote() {
  if (!supabase) return;
  try {
    await supabase.from("favorites").delete().eq("device_id", getDeviceId());
  } catch {}
}

// ─── Settings Sync ───

export async function syncSetting(key, value) {
  if (!supabase) return;
  try {
    await supabase.from("settings").upsert({
      device_id: getDeviceId(),
      key,
      value,
      updated_at: new Date().toISOString(),
    });
  } catch {}
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
  } catch { return {}; }
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
  } catch {}
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
  } catch { return []; }
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
    history: results[1].status === "fulfilled" ? results[1].value : [],
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

// ─── Backups: rolling snapshots of a user's full data, manual or auto ───
// Stored in data_backups table. Auto-backups run via pg_cron every 2 days.
// Manual backups happen before destructive actions (Clear Outputs / Reset Everything).

export async function createBackup(type = "manual", note = null) {
  if (!supabase) return { ok: false, error: "Cloud not configured" };
  const username = getDeviceId();
  try {
    // Pull current state to embed into the snapshot
    const [tasksRes, historyRes, settingsRes, favoritesRes] = await Promise.allSettled([
      supabase.from("tasks").select("*").eq("device_id", username).order("start_time", { ascending: false }).limit(500),
      supabase.from("history").select("*").eq("device_id", username).order("timestamp", { ascending: false }).limit(1000),
      supabase.from("settings").select("key,value").eq("device_id", username),
      supabase.from("favorites").select("*").eq("device_id", username),
    ]);
    const tasks = tasksRes.status === "fulfilled" ? (tasksRes.value.data || []) : [];
    const history = historyRes.status === "fulfilled" ? (historyRes.value.data || []) : [];
    const settingsRows = settingsRes.status === "fulfilled" ? (settingsRes.value.data || []) : [];
    const favorites = favoritesRes.status === "fulfilled" ? (favoritesRes.value.data || []) : [];
    const settingsObj = {};
    for (const row of settingsRows) settingsObj[row.key] = row.value;

    const { data, error } = await supabase.from("data_backups").insert({
      username, backup_type: type, note,
      task_count: tasks.length, history_count: history.length,
      tasks_snapshot: tasks, history_snapshot: history,
      settings_snapshot: settingsObj, favorites_snapshot: favorites,
    }).select("id,created_at").single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data.id, createdAt: data.created_at };
  } catch (e) { return { ok: false, error: e.message || "Backup failed" }; }
}

export async function listBackups(limit = 20) {
  if (!supabase) return [];
  const username = getDeviceId();
  try {
    const { data, error } = await supabase
      .from("data_backups")
      .select("id, backup_type, task_count, history_count, note, created_at")
      .eq("username", username)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch { return []; }
}

export async function getBackup(id) {
  if (!supabase) return null;
  const username = getDeviceId();
  try {
    const { data, error } = await supabase
      .from("data_backups").select("*")
      .eq("id", id).eq("username", username).single();
    if (error) return null;
    return data;
  } catch { return null; }
}

export async function restoreBackup(id) {
  if (!supabase) return { ok: false, error: "Cloud not configured" };
  const backup = await getBackup(id);
  if (!backup) return { ok: false, error: "Backup not found" };
  const username = getDeviceId();
  try {
    // Snapshot current state first (safety net) so restore is undoable
    await createBackup("pre-restore", `Before restoring ${new Date(backup.created_at).toLocaleString()}`);

    // Wipe current and replace from snapshot
    await supabase.from("tasks").delete().eq("device_id", username);
    await supabase.from("history").delete().eq("device_id", username);
    await supabase.from("settings").delete().eq("device_id", username);
    await supabase.from("favorites").delete().eq("device_id", username);

    const tasks = backup.tasks_snapshot || [];
    const history = backup.history_snapshot || [];
    const settingsObj = backup.settings_snapshot || {};
    const favorites = backup.favorites_snapshot || [];

    if (tasks.length > 0) await supabase.from("tasks").upsert(tasks, { onConflict: "id" });
    if (history.length > 0) await supabase.from("history").upsert(history, { onConflict: "id" });
    const settingRows = Object.entries(settingsObj).map(([key, value]) => ({
      device_id: username, key, value, updated_at: new Date().toISOString(),
    }));
    if (settingRows.length > 0) await supabase.from("settings").upsert(settingRows, { onConflict: "device_id,key" });
    if (favorites.length > 0) await supabase.from("favorites").upsert(favorites, { onConflict: "id" });

    return { ok: true, tasks: tasks.length, history: history.length };
  } catch (e) { return { ok: false, error: e.message || "Restore failed" }; }
}

export async function deleteBackup(id) {
  if (!supabase) return false;
  const username = getDeviceId();
  try {
    const { error } = await supabase.from("data_backups").delete().eq("id", id).eq("username", username);
    return !error;
  } catch { return false; }
}

// ─── Account Credentials (globally stored, not device-scoped) ───
// Stored in `settings` table with device_id="_account" so they sync across all devices

const ACCOUNT_SCOPE = "_account";

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function getStoredCredentials() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("settings").select("key,value").eq("device_id", ACCOUNT_SCOPE);
    if (error || !data) return null;
    const result = {};
    for (const row of data) result[row.key] = row.value;
    return Object.keys(result).length > 0 ? result : null;
  } catch { return null; }
}

export async function verifyCredentials(username, password) {
  const stored = await getStoredCredentials();
  if (!stored) {
    // No stored creds — fallback to hardcoded admin/admin for initial setup
    return username === "admin" && password === "admin";
  }
  if (stored.username !== username) return false;
  const hash = await sha256Hex(password);
  return stored.password_hash === hash;
}

export async function saveCredentials({ username, password, email, emailVerified, lastVerifiedAt }) {
  if (!supabase) return false;
  try {
    const rows = [];
    const ts = new Date().toISOString();
    if (username !== undefined) rows.push({ device_id: ACCOUNT_SCOPE, key: "username", value: username, updated_at: ts });
    if (password !== undefined) rows.push({ device_id: ACCOUNT_SCOPE, key: "password_hash", value: await sha256Hex(password), updated_at: ts });
    if (email !== undefined) rows.push({ device_id: ACCOUNT_SCOPE, key: "email", value: email, updated_at: ts });
    if (emailVerified !== undefined) rows.push({ device_id: ACCOUNT_SCOPE, key: "email_verified", value: String(emailVerified), updated_at: ts });
    if (lastVerifiedAt !== undefined) rows.push({ device_id: ACCOUNT_SCOPE, key: "last_verified_at", value: String(lastVerifiedAt), updated_at: ts });
    if (rows.length === 0) return true;
    const { error } = await supabase.from("settings").upsert(rows, { onConflict: "device_id,key" });
    return !error;
  } catch { return false; }
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
    try { await supabase.auth.signOut(); } catch {}
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || "Verification failed" }; }
}
