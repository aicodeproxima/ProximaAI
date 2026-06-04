-- Phase 2 hotfix #2: add `extensions` to search_path on functions using pgcrypto.
--
-- pgcrypto installs into Supabase's `extensions` schema, not `public`. The
-- previous migration used `SET search_path = public, pg_catalog` which didn't
-- include `extensions`, so digest(), crypt(), gen_salt(), hmac(), and
-- gen_random_bytes() were unresolvable when called from inside these RPCs.
--
-- Smoke test caught it on the verify_admin legacy SHA-256 path:
--   ERROR: 42883: function digest(text, unknown) does not exist
--
-- ALTER FUNCTION ... SET search_path is the lightest fix — no body change.

ALTER FUNCTION public._sign_session_token(text, timestamptz)
  SET search_path = public, extensions, pg_catalog;

ALTER FUNCTION public._verify_session_token(text)
  SET search_path = public, extensions, pg_catalog;

ALTER FUNCTION public.verify_admin(text, text)
  SET search_path = public, extensions, pg_catalog;

ALTER FUNCTION public.set_admin_credentials_rehash(text, text)
  SET search_path = public, extensions, pg_catalog;
