-- Phase 2.2 + 2.3 + 2.4 Migration A — creates the secret storage and the RPC surface
-- that the new Edge function and client will call.
--
-- Per security plan sections §2.2, §2.3, §2.4 and the meticulous review in §F:
--   * F.2.2 — sign/verify_session_token must be REVOKE FROM PUBLIC, GRANT TO service_role only
--   * F.3.3 — set_my_wavespeed_key initially granted to anon (Phase 2); Phase 3 RLS flip revokes
--   * F.4.2 — restore_my_backup_phase2 runs in a single transaction with SQL EXCEPTION fallback
--   * F.7.3 — backfill_user_id (Phase 3) will be REVOKE FROM PUBLIC, GRANT TO service_role only
--
-- Idempotent: every CREATE uses IF NOT EXISTS or CREATE OR REPLACE. Safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── SECRET STORAGE ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.app_secrets (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;
-- No policies granted. Default-deny for anon. Service role + SECURITY DEFINER RPCs only.

CREATE TABLE IF NOT EXISTS public.user_secrets (
  device_id   text NOT NULL,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- user_id column reserved for Phase 3 auth migration; nullable for now.
  user_id     uuid,
  PRIMARY KEY (device_id, key)
);
ALTER TABLE public.user_secrets ENABLE ROW LEVEL SECURITY;
-- No policies granted. Default-deny.

-- ─── SESSION TOKEN HELPERS (service_role only) ─────────────────────────────
-- Token format: "<subject>.<exp_epoch>.<hex_hmac>"
-- HMAC key lives in app_secrets.session_signing_key (provisioned by the data-copy migration).
-- Per F.2.2: REVOKE FROM PUBLIC + GRANT TO service_role only.

CREATE OR REPLACE FUNCTION public._sign_session_token(
  p_subject text,
  p_expires timestamptz
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_key text;
  v_exp bigint;
  v_msg text;
  v_sig text;
BEGIN
  SELECT value->>'key' INTO v_key FROM app_secrets WHERE key = 'session_signing_key';
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'session_signing_key not provisioned';
  END IF;
  v_exp := EXTRACT(EPOCH FROM p_expires)::bigint;
  v_msg := p_subject || '.' || v_exp::text;
  v_sig := encode(hmac(v_msg, v_key, 'sha256'), 'hex');
  RETURN v_msg || '.' || v_sig;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._sign_session_token(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._sign_session_token(text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public._verify_session_token(
  p_token text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_parts text[];
  v_subject text;
  v_exp bigint;
  v_sig text;
  v_msg text;
  v_key text;
  v_key_prev text;
  v_expected text;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'invalid session token';
  END IF;
  v_parts := string_to_array(p_token, '.');
  IF array_length(v_parts, 1) <> 3 THEN
    RAISE EXCEPTION 'malformed session token';
  END IF;
  v_subject := v_parts[1];
  BEGIN
    v_exp := v_parts[2]::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'malformed exp';
  END;
  v_sig := v_parts[3];
  v_msg := v_subject || '.' || v_exp::text;

  IF v_exp < EXTRACT(EPOCH FROM now())::bigint THEN
    RAISE EXCEPTION 'session token expired';
  END IF;

  -- Try current signing key first
  SELECT value->>'key' INTO v_key FROM app_secrets WHERE key = 'session_signing_key';
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'session_signing_key not provisioned';
  END IF;
  v_expected := encode(hmac(v_msg, v_key, 'sha256'), 'hex');
  IF v_expected = v_sig THEN
    RETURN v_subject;
  END IF;

  -- Fallback to previous signing key (12h grace window for rotation; F.1.5)
  SELECT value->>'key' INTO v_key_prev FROM app_secrets WHERE key = 'session_signing_key_previous';
  IF v_key_prev IS NOT NULL THEN
    v_expected := encode(hmac(v_msg, v_key_prev, 'sha256'), 'hex');
    IF v_expected = v_sig THEN
      RETURN v_subject;
    END IF;
  END IF;

  RAISE EXCEPTION 'invalid signature';
END;
$$;
REVOKE EXECUTE ON FUNCTION public._verify_session_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._verify_session_token(text) TO service_role;

-- ─── ADMIN AUTH (dual-path verify, auto-rehash) ────────────────────────────
-- Per security plan §2.2.2 and F.2.1/F.2.4:
--   Path 1: bcrypt hash exists → use crypt() to verify.
--   Path 2: bcrypt NULL, legacy SHA-256 exists → match candidate against legacy.
--           Return rehash_required=true; client immediately calls rehash RPC.

CREATE OR REPLACE FUNCTION public.verify_admin(
  p_username text,
  p_password text
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_stored_username text;
  v_stored_bcrypt   text;
  v_stored_legacy   text;
  v_candidate_sha   text;
  v_token           text;
  v_exp             timestamptz := now() + interval '12 hours';
BEGIN
  SELECT value->>'username'              INTO v_stored_username FROM app_secrets WHERE key = 'admin_username';
  SELECT value->>'password_hash'         INTO v_stored_bcrypt   FROM app_secrets WHERE key = 'admin_password_hash';
  SELECT value->>'hash'                  INTO v_stored_legacy   FROM app_secrets WHERE key = 'admin_password_hash_legacy_sha256';

  IF v_stored_username IS NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'not_provisioned');
  END IF;
  IF v_stored_username <> p_username THEN
    RETURN json_build_object('ok', false, 'reason', 'invalid');
  END IF;

  -- Path 1: bcrypt
  IF v_stored_bcrypt IS NOT NULL THEN
    IF v_stored_bcrypt = crypt(p_password, v_stored_bcrypt) THEN
      v_token := public._sign_session_token('admin:' || v_stored_username, v_exp);
      RETURN json_build_object(
        'ok', true,
        'token', v_token,
        'expires_at', EXTRACT(EPOCH FROM v_exp)::bigint,
        'rehash_required', false
      );
    END IF;
    -- bcrypt mismatch — fall through to legacy in case mid-migration
  END IF;

  -- Path 2: legacy SHA-256 (salt-less). Client hashed in browser as
  -- await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p))
  -- then hex-encoded.
  IF v_stored_legacy IS NOT NULL THEN
    v_candidate_sha := encode(digest(p_password, 'sha256'), 'hex');
    IF v_candidate_sha = v_stored_legacy THEN
      v_token := public._sign_session_token('admin:' || v_stored_username, v_exp);
      RETURN json_build_object(
        'ok', true,
        'token', v_token,
        'expires_at', EXTRACT(EPOCH FROM v_exp)::bigint,
        'rehash_required', true
      );
    END IF;
  END IF;

  RETURN json_build_object('ok', false, 'reason', 'invalid');
END;
$$;
GRANT EXECUTE ON FUNCTION public.verify_admin(text, text) TO anon;

CREATE OR REPLACE FUNCTION public.set_admin_credentials_rehash(
  p_session_token  text,
  p_plain_password text
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_username text;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  IF v_subject NOT LIKE 'admin:%' THEN
    RAISE EXCEPTION 'session is not admin-scoped';
  END IF;
  v_username := substring(v_subject FROM 7);  -- strip 'admin:' prefix

  -- Atomic upgrade: write bcrypt, drop legacy
  INSERT INTO app_secrets (key, value)
    VALUES ('admin_password_hash',
            jsonb_build_object('password_hash', crypt(p_plain_password, gen_salt('bf', 12))))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  DELETE FROM app_secrets WHERE key = 'admin_password_hash_legacy_sha256';

  RETURN json_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_admin_credentials_rehash(text, text) TO anon;

-- ─── PER-USER WAVESPEED KEY ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_wavespeed_key(
  p_session_token text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_device_id text;
  v_key text;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  -- subject is "admin:<username>" in Phase 2; Phase 3 will be the auth.uid()
  IF v_subject LIKE 'admin:%' THEN
    v_device_id := 'user:' || substring(v_subject FROM 7);
  ELSE
    v_device_id := v_subject;
  END IF;
  SELECT value->>'value' INTO v_key
    FROM user_secrets
    WHERE device_id = v_device_id AND key = 'wavespeed_api_key';
  RETURN v_key;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_wavespeed_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_wavespeed_key(text) TO service_role;

CREATE OR REPLACE FUNCTION public.set_my_wavespeed_key(
  p_session_token text,
  p_key text
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_device_id text;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) < 8 THEN
    RAISE EXCEPTION 'WaveSpeed key looks invalid (too short)';
  END IF;
  v_subject := public._verify_session_token(p_session_token);
  IF v_subject LIKE 'admin:%' THEN
    v_device_id := 'user:' || substring(v_subject FROM 7);
  ELSE
    v_device_id := v_subject;
  END IF;
  INSERT INTO user_secrets (device_id, key, value)
    VALUES (v_device_id, 'wavespeed_api_key', jsonb_build_object('value', p_key))
  ON CONFLICT (device_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();
  RETURN json_build_object('ok', true, 'device_id', v_device_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_my_wavespeed_key(text, text) TO anon;

-- ─── DATA_BACKUPS RPC PAIR (Phase 2.4 lockdown prerequisite) ──────────────
-- Per F.4.1: deploy RPCs first, then drop the open policy on data_backups in Phase 2.4.

CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(
  p_session_token text,
  p_type          text,
  p_note          text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_username text;
  v_id uuid := gen_random_uuid();
  v_tasks  jsonb;
  v_hist   jsonb;
  v_set    jsonb;
  v_fav    jsonb;
  v_ct     int;
  v_ch     int;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    INTO v_tasks
    FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t;
  SELECT COALESCE(jsonb_agg(row_to_json(h)), '[]'::jsonb)
    INTO v_hist
    FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_set
    FROM settings WHERE device_id = v_username;
  SELECT COALESCE(jsonb_agg(row_to_json(f)), '[]'::jsonb)
    INTO v_fav
    FROM favorites WHERE device_id = v_username;

  SELECT count(*) INTO v_ct FROM tasks WHERE device_id = v_username;
  SELECT count(*) INTO v_ch FROM history WHERE device_id = v_username;

  INSERT INTO data_backups (
    id, username, backup_type, task_count, history_count,
    settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot, note
  ) VALUES (
    v_id, v_username, p_type, v_ct, v_ch,
    v_set, v_fav, v_tasks, v_hist, p_note
  );

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.snapshot_my_data_phase2(text, text, text) TO anon;

CREATE OR REPLACE FUNCTION public.list_my_backups_phase2(
  p_session_token text,
  p_limit         int DEFAULT 20
) RETURNS SETOF data_backups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_username text;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;
  RETURN QUERY
    SELECT b.* FROM data_backups b
    WHERE b.username = v_username
    ORDER BY b.created_at DESC
    LIMIT p_limit;
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_my_backups_phase2(text, int) TO anon;

CREATE OR REPLACE FUNCTION public.restore_my_backup_phase2(
  p_session_token text,
  p_backup_id     uuid
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_username text;
  v_backup record;
  v_restored_tasks int := 0;
  v_restored_history int := 0;
  v_restored_favorites int := 0;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;

  SELECT * INTO v_backup FROM data_backups WHERE id = p_backup_id AND username = v_username;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'backup_not_found');
  END IF;

  -- Take a safety snapshot of current state before destructive restore (F.4.2).
  INSERT INTO data_backups (id, username, backup_type, task_count, history_count,
                            settings_snapshot, favorites_snapshot, tasks_snapshot,
                            history_snapshot, note)
  SELECT gen_random_uuid(), v_username, 'pre-restore',
         (SELECT count(*) FROM tasks WHERE device_id = v_username),
         (SELECT count(*) FROM history WHERE device_id = v_username),
         COALESCE((SELECT jsonb_object_agg(key, value) FROM settings WHERE device_id = v_username), '{}'::jsonb),
         COALESCE((SELECT jsonb_agg(row_to_json(f)) FROM favorites WHERE device_id = v_username), '[]'::jsonb),
         COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb),
         COALESCE((SELECT jsonb_agg(row_to_json(h)) FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb),
         'auto safety snapshot before restoring backup ' || p_backup_id::text;

  -- Atomic destructive restore. The whole function runs in one transaction
  -- because Supabase Management API wraps each query in BEGIN/COMMIT.
  DELETE FROM tasks WHERE device_id = v_username;
  DELETE FROM history WHERE device_id = v_username;
  DELETE FROM favorites WHERE device_id = v_username;
  -- Preserve apiKey in case the snapshot has stale data; restore other settings.
  DELETE FROM settings WHERE device_id = v_username AND key <> 'apiKey';

  -- Restore. jsonb_populate_recordset coerces snapshot rows to typed records.
  INSERT INTO tasks
    SELECT * FROM jsonb_populate_recordset(NULL::tasks, v_backup.tasks_snapshot);
  GET DIAGNOSTICS v_restored_tasks = ROW_COUNT;

  INSERT INTO history
    SELECT * FROM jsonb_populate_recordset(NULL::history, v_backup.history_snapshot);
  GET DIAGNOSTICS v_restored_history = ROW_COUNT;

  INSERT INTO favorites
    SELECT * FROM jsonb_populate_recordset(NULL::favorites, v_backup.favorites_snapshot);
  GET DIAGNOSTICS v_restored_favorites = ROW_COUNT;

  -- Settings stored as {key: value} object in the snapshot; expand to rows.
  INSERT INTO settings (device_id, key, value)
    SELECT v_username, k.key, k.value
      FROM jsonb_each(v_backup.settings_snapshot) k
      WHERE k.key <> 'apiKey'
    ON CONFLICT (device_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now();

  RETURN json_build_object(
    'ok', true,
    'tasks_restored', v_restored_tasks,
    'history_restored', v_restored_history,
    'favorites_restored', v_restored_favorites
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'reason', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION public.restore_my_backup_phase2(text, uuid) TO anon;

CREATE OR REPLACE FUNCTION public.delete_my_backup_phase2(
  p_session_token text,
  p_backup_id     uuid
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subject text;
  v_username text;
  v_deleted int;
BEGIN
  v_subject := public._verify_session_token(p_session_token);
  v_username := CASE WHEN v_subject LIKE 'admin:%' THEN 'user:' || substring(v_subject FROM 7) ELSE v_subject END;
  DELETE FROM data_backups WHERE id = p_backup_id AND username = v_username;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN json_build_object('ok', true, 'deleted_rows', v_deleted);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_my_backup_phase2(text, uuid) TO anon;
