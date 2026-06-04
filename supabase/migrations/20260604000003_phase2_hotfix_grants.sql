-- Phase 2 hotfix: tighten EXECUTE grants on internal helpers.
--
-- The previous migration used `REVOKE EXECUTE ... FROM PUBLIC` but Supabase's
-- default schema setup grants EXECUTE on every public function to anon,
-- authenticated, and service_role explicitly. Revoking from PUBLIC doesn't
-- strip those explicit grants. Smoke test against pg_proc.proacl revealed
-- _sign_session_token was callable by anon — anon could forge any token.
--
-- This file revokes from all non-service roles explicitly, then re-grants
-- to service_role only. Per F.2.2.

REVOKE EXECUTE ON FUNCTION public._sign_session_token(text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sign_session_token(text, timestamptz) TO service_role;

REVOKE EXECUTE ON FUNCTION public._verify_session_token(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._verify_session_token(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_my_wavespeed_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_wavespeed_key(text) TO service_role;
