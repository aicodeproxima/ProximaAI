// ─── Supabase Cloud Sync Layer ───
// Loads Supabase from CDN at runtime — no npm dependency needed.
// All methods are no-ops until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

let supabase = null;

export function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

export async function initSupabase() {
  if (!isSupabaseConfigured()) return null;
  try {
    // Load Supabase from CDN — avoids npm dependency
    const cdnUrl = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm";
    const mod = await import(/* @vite-ignore */ cdnUrl);
    supabase = mod.createClient(SUPABASE_URL, SUPABASE_KEY);
    return supabase;
  } catch {
    return null;
  }
}

export async function syncHistoryEntry(entry) {
  if (!supabase) return;
  try {
    await supabase.from("generation_history").upsert({
      id: entry.id,
      timestamp: entry.timestamp,
      prompt: entry.prompt,
      neg_prompt: entry.negPrompt || "",
      gen_type: entry.genType,
      models: entry.models,
      resolution: entry.resolution || "",
      duration: entry.duration || null,
      seed: entry.seed || "",
      tasks_json: JSON.stringify(entry.tasks),
      total_cost: entry.totalCost || 0,
    });
  } catch {}
}

export async function syncSetting(key, value) {
  if (!supabase) return;
  try {
    await supabase.from("settings").upsert({ key, value: JSON.stringify(value) });
  } catch {}
}

export async function pullHistory() {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from("generation_history")
      .select("*")
      .order("timestamp", { ascending: false })
      .limit(500);
    return (data || []).map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      prompt: row.prompt,
      negPrompt: row.neg_prompt,
      genType: row.gen_type,
      models: row.models,
      resolution: row.resolution,
      duration: row.duration,
      seed: row.seed,
      tasks: JSON.parse(row.tasks_json || "[]"),
      totalCost: row.total_cost,
    }));
  } catch { return []; }
}
