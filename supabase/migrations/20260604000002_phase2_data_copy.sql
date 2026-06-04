-- Phase 2 one-time data copy (additive, idempotent).
-- Populates app_secrets and user_secrets from existing settings rows so the new
-- RPC surface in 20260604000001_phase2_2_app_user_secrets.sql can be tested
-- without modifying the existing settings rows yet.
--
-- Per security plan §F.3.1 and §F.2.3:
--   * `settings._account` rows STAY put for now; Migration B (a later file)
--     deletes them only after Phase 2.1 Deploy 2b confirms verify_admin works.
--   * `settings.apiKey` rows STAY put for now; Phase 2.3 cleanup deletes them
--     after the Edge function reads from user_secrets and we've verified 0 hits
--     on the fallback path for ≥48 h.
--
-- All inserts are ON CONFLICT DO NOTHING. Safe to re-run.

-- 1. Provision session signing key (HMAC-SHA256 key used by _sign/_verify_session_token).
--    Generate fresh if absent. The actual key value also needs to be mirrored to
--    the Vercel Edge function env (SESSION_SIGNING_KEY) — see F.1.5 and the
--    pre-flight checklist. After provisioning, the operator must copy the value
--    OUT of app_secrets and INTO Vercel env, then NEVER again.
INSERT INTO public.app_secrets (key, value)
  VALUES (
    'session_signing_key',
    jsonb_build_object(
      'key', encode(gen_random_bytes(32), 'hex'),
      'created_at', now()
    )
  )
ON CONFLICT (key) DO NOTHING;

-- 2. Copy admin username from settings._account into app_secrets.
--    Function `verify_admin` reads `value->>'username'`, so the value must be a
--    JSON OBJECT { "username": "..." }, not a bare JSON string. Smoke test
--    on branch caught this shape mismatch.
INSERT INTO public.app_secrets (key, value)
  SELECT 'admin_username', jsonb_build_object('username', value->>0)
    FROM public.settings
    WHERE device_id = '_account' AND key = 'username'
ON CONFLICT (key) DO NOTHING;

-- 3. Copy legacy SHA-256 password hash into app_secrets under the LEGACY key.
--    NOTE: we INTENTIONALLY do NOT populate 'admin_password_hash' here.
--    Leaving it absent causes verify_admin to walk Path 2 (legacy fallback)
--    on first login, which triggers the auto-rehash to bcrypt via
--    set_admin_credentials_rehash. See plan §2.2.2 and §F.2.4.
INSERT INTO public.app_secrets (key, value)
  SELECT
    'admin_password_hash_legacy_sha256',
    jsonb_build_object('hash', value->>0)
    FROM public.settings
    WHERE device_id = '_account' AND key = 'password_hash'
ON CONFLICT (key) DO NOTHING;

-- 4. Copy admin email + email_verified for completeness (used by Phase 3 auth migration).
--    Wrap in jsonb_build_object so future readers can do value->>'email' etc.
INSERT INTO public.app_secrets (key, value)
  SELECT 'admin_email', jsonb_build_object('email', value->>0)
    FROM public.settings
    WHERE device_id = '_account' AND key = 'email'
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_secrets (key, value)
  SELECT 'admin_email_verified', jsonb_build_object('verified', value->>0)
    FROM public.settings
    WHERE device_id = '_account' AND key = 'email_verified'
ON CONFLICT (key) DO NOTHING;

-- 5. Copy per-user WaveSpeed keys from settings into user_secrets.
--    Function `get_my_wavespeed_key` reads `value->>'value'`, so the shape is
--    { "value": "<api_key>" }. set_my_wavespeed_key writes this shape too.
INSERT INTO public.user_secrets (device_id, key, value)
  SELECT
    device_id,
    'wavespeed_api_key',
    jsonb_build_object('value', value->>0)
    FROM public.settings
    WHERE key = 'apiKey'
ON CONFLICT (device_id, key) DO NOTHING;
