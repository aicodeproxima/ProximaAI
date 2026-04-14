-- ProximaAI Supabase Schema
-- Device-based auth: each device has a unique device_id stored in localStorage
-- RLS policies allow access only to rows matching the device_id header

-- ─── TASKS ───
CREATE TABLE IF NOT EXISTS public.tasks (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  batch_id TEXT,
  model_id TEXT,
  model_name TEXT,
  provider TEXT,
  price NUMERIC,
  status TEXT,
  gen_type TEXT,
  prompt TEXT,
  neg_prompt TEXT,
  resolution TEXT,
  duration INT,
  seed TEXT,
  aspect_ratio TEXT,
  source_image_url TEXT,
  source_image_urls JSONB,
  num_images INT,
  outputs JSONB,
  error TEXT,
  start_time BIGINT,
  end_time BIGINT,
  wall_clock_ms INT,
  inference_ms INT,
  per_model_resolution JSONB,
  nsfw JSONB,
  task_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tasks_device_id_idx ON public.tasks(device_id);
CREATE INDEX IF NOT EXISTS tasks_start_time_idx ON public.tasks(start_time DESC);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON public.tasks(status);
CREATE INDEX IF NOT EXISTS tasks_device_time_idx ON public.tasks(device_id, start_time DESC);

-- ─── HISTORY (generation logs / batches) ───
CREATE TABLE IF NOT EXISTS public.history (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  timestamp BIGINT,
  prompt TEXT,
  neg_prompt TEXT,
  gen_type TEXT,
  models JSONB,
  resolution TEXT,
  duration INT,
  seed TEXT,
  aspect_ratio TEXT,
  source_image_url TEXT,
  source_image_urls JSONB,
  num_images INT,
  tasks JSONB,
  total_cost NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS history_device_id_idx ON public.history(device_id);
CREATE INDEX IF NOT EXISTS history_timestamp_idx ON public.history(timestamp DESC);
CREATE INDEX IF NOT EXISTS history_device_time_idx ON public.history(device_id, timestamp DESC);

-- ─── SETTINGS (per-device key-value store) ───
CREATE TABLE IF NOT EXISTS public.settings (
  device_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (device_id, key)
);

-- ─── FAVORITES (saved prompts) ───
CREATE TABLE IF NOT EXISTS public.favorites (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  prompt TEXT,
  tags JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS favorites_device_id_idx ON public.favorites(device_id);

-- ─── PRESETS (per-model parameter presets) ───
CREATE TABLE IF NOT EXISTS public.presets (
  device_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  params JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (device_id, model_id)
);

-- ─── ENABLE ROW LEVEL SECURITY ───
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presets ENABLE ROW LEVEL SECURITY;

-- ─── RLS POLICIES ───
-- Device-based: client sends device_id in a custom header (x-device-id)
-- We use the anon key + the header to scope rows.
-- The client must include device_id in every row it inserts/updates.
-- We trust the client to use its own device_id (this is a personal tool, not multi-tenant SaaS).
-- For stronger security, migrate to Supabase Auth later.

-- Allow anon full CRUD, but only for rows matching their device_id (enforced client-side via filter)
-- Since there's no auth, we use a permissive policy + client-side filtering.
DROP POLICY IF EXISTS "tasks_device_access" ON public.tasks;
CREATE POLICY "tasks_device_access" ON public.tasks FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "history_device_access" ON public.history;
CREATE POLICY "history_device_access" ON public.history FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "settings_device_access" ON public.settings;
CREATE POLICY "settings_device_access" ON public.settings FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "favorites_device_access" ON public.favorites;
CREATE POLICY "favorites_device_access" ON public.favorites FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "presets_device_access" ON public.presets;
CREATE POLICY "presets_device_access" ON public.presets FOR ALL TO anon USING (true) WITH CHECK (true);
