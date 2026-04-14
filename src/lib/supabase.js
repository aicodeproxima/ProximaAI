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
