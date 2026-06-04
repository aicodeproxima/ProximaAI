-- Phase 2.5: Declare `data_backups` table to match the existing live shape.
--
-- This table has been in production since at least 2026-04-20 (oldest auto-2day
-- backup row) but is not declared in any committed migration. This file is the
-- schema-drift fix per security plan §2.5 and §F.5.1.
--
-- Shape pulled from production via the Supabase Management API on 2026-06-04
-- by querying information_schema.columns and pg_indexes against the live project
-- `vhznmpxlcjbdzntmfvvy`. Match must be exact; mismatch would create a divergence
-- between this migration's declared table and the existing rows.
--
-- All operations idempotent (`IF NOT EXISTS`). Safe to run on the live project
-- as well as on the staging branch.

CREATE TABLE IF NOT EXISTS public.data_backups (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  username              text          NOT NULL,
  backup_type           text          NOT NULL DEFAULT 'auto'::text,
  task_count            integer       DEFAULT 0,
  history_count         integer       DEFAULT 0,
  settings_snapshot     jsonb         DEFAULT '{}'::jsonb,
  favorites_snapshot    jsonb         DEFAULT '[]'::jsonb,
  tasks_snapshot        jsonb         DEFAULT '[]'::jsonb,
  history_snapshot      jsonb         DEFAULT '[]'::jsonb,
  note                  text,
  created_at            timestamp with time zone DEFAULT now()
);

-- Index for the by-user, newest-first query pattern used by listBackups() in
-- src/lib/supabase.js. Confirmed present in live production via pg_indexes.
CREATE INDEX IF NOT EXISTS idx_data_backups_user_created
  ON public.data_backups USING btree (username, created_at DESC);

-- RLS is enabled in production but the policies are wide open (CRITICAL-5 in the
-- audit). Phase 2.4 will drop the anon-all policy in favor of RPC-only writes.
-- This migration just enables RLS (idempotent) and re-declares the existing
-- policies so the migration is a faithful snapshot of current state.
ALTER TABLE public.data_backups ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'data_backups'
      AND policyname = 'Anon all data_backups'
  ) THEN
    CREATE POLICY "Anon all data_backups" ON public.data_backups
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'data_backups'
      AND policyname = 'Service role full data_backups'
  ) THEN
    CREATE POLICY "Service role full data_backups" ON public.data_backups
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END
$$;
