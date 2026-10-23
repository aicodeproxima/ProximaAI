-- Rollback of supabase/migrations/20261023200000_mu_p1_scope_topic.sql (M2, RLS session; design §7). Kept OUT of
-- supabase/migrations/. One transaction:
--   0) guards: refuse while M3 is live (issue_session no longer signs 'admin:' || ...: the restored session_scope would
--      refuse every 'u:' token and sign every device out), and compare-and-swap against M2's post-apply bodies;
--   1) session_scope and sync_topic recreated from their pre-M2 pg_get_functiondef text, verbatim (captured 2026-10-23
--      from the live database by a script, not retyped);
--   2) post-check: both md5s equal the pre-M2 capture and the grants are unchanged.
--   3) the migration's own schema_migrations record is deleted (a later apply-migration re-applies M2).
-- Order (design §7): M4 -> M3 -> this -> M1b -> M1 (M1's rollback refuses while this migration is live).
-- Proof: scripts/test-mu-scope-topic-rollback.sql.

-- ── 0. Guards ──
do $guard$
declare
  v_post constant jsonb := '{"proxima_auth.session_scope(boolean)":"0e153c08ca88b0e2f7e933d97c451fc8","proxima_auth.sync_topic()":"d477f4ef6736a9322a5a06e6c439e136"}';
  v_bad text;
begin
  if to_regprocedure('proxima_auth.issue_session(uuid)') is not null
     and pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure) !~* $re$'admin:'\s*\|\|$re$ then
    raise exception 'M2 rollback: issue_session no longer signs admin: tokens (M3 is live); roll back M3 first';
  end if;
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_post) e(k, m)
   where to_regprocedure(e.k) is null or md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if v_bad is not null then
    raise exception 'M2 rollback compare-and-swap: body differs from M2''s post-apply text: %', v_bad;
  end if;
end $guard$;

-- ── 1. The pre-M2 bodies, verbatim ──
CREATE OR REPLACE FUNCTION proxima_auth.session_scope(p_required boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_raw text := nullif(current_setting('request.headers', true), '');   -- '' after a RESET on a pooled connection
  v_tok text;
  v_sub text;
begin
  if v_raw is not null then
    begin
      v_tok := nullif(btrim((v_raw::jsonb) ->> 'x-proxima-session'), '');
    exception when others then
      v_tok := null;                                      -- unparsable request.headers = no header
    end;
  end if;
  if v_tok is null then
    if p_required then
      raise exception using errcode = '28000', message = 'session token missing',
        hint = 'send the x-proxima-session header';
    end if;
    return null;                                          -- realtime / cron / headerless reads: no rows, no error
  end if;
  begin
    v_sub := public._verify_session_token(v_tok);         -- exp, HMAC (current|previous key), admin_username, valid_after
  exception when others then
    raise exception using errcode = '28000', message = sqlerrm;
  end;
  if v_sub is null or v_sub not like 'admin:%' then
    raise exception using errcode = '28000', message = 'not admin-scoped';
  end if;
  return 'user:' || substring(v_sub from 7);
end $function$
;

CREATE OR REPLACE FUNCTION proxima_auth.sync_topic()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 'proxima-sync-' || encode(extensions.hmac(
           'sync-ping:'
             || coalesce((select value->>'username' from public.app_secrets where key = 'admin_username'), '')
             || ':'
             || coalesce((select value->>'at' from public.app_secrets where key = 'admin_sessions_valid_after'), '0'),
           (select value->>'key' from public.app_secrets where key = 'session_signing_key'),
           'sha256'), 'hex')
$function$
;

-- ── 2. Post-check: exactly the pre-M2 bodies, grants unchanged ──
do $post$
declare
  v_pre constant jsonb := '{"proxima_auth.session_scope(boolean)":"2ec561e92dcbe45ff5171d3576765a9e","proxima_auth.sync_topic()":"04def7fb9d177998a6c568319f149052"}';
  v_bad text;
begin
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_pre) e(k, m)
   where to_regprocedure(e.k) is null or md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if v_bad is not null then raise exception 'M2 rollback: restored body differs from the pre-M2 capture: %', v_bad; end if;
  if (select p.proacl::text from pg_proc p where p.oid = 'proxima_auth.session_scope(boolean)'::regprocedure)
       is distinct from '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres}'
     or (select p.proacl::text from pg_proc p where p.oid = 'proxima_auth.sync_topic()'::regprocedure)
       is distinct from '{postgres=X/postgres}' then
    raise exception 'M2 rollback: grants changed';
  end if;
end $post$;

-- ── 3. The migration's own record goes with it, in the same transaction: a later apply-migration then
--   re-applies the migration instead of answering "already recorded" (lockdown session's M3 review, 2026-10-23).
delete from supabase_migrations.schema_migrations where version = '20261023200000' and name = 'mu_p1_scope_topic';
