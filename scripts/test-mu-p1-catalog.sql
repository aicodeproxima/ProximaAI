-- Multi-user P1 catalog gates (docs/P1-AUTH-DESIGN.md §9.2; review #10), checked in from the ad-hoc gates of the M1
-- build. Catalog reads only; the block always ends in raise exception 'RESULT: ...', so nothing persists.
--   without M1:  node scripts/tools/sql-tx.mjs --test scripts/test-mu-p1-catalog.sql            (a skip line; passes)
--   with M1:     node scripts/tools/sql-tx.mjs <M1> [<M2>] --test scripts/test-mu-p1-catalog.sql  (all ok)
--   after M1:    node scripts/tools/sql-tx.mjs --test scripts/test-mu-p1-catalog.sql            (all ok)
-- Gates: semantic (a public function that verifies p_session_token also resolves the account through current_account);
-- no fall-through (no body matches else ... v_subject, any case); the 'admin:' literal only in _verify_session_token,
-- current_account, session_scope and issue_session; the proxima_auth helpers (M1's frozen guard function included)
-- executable by postgres only; M1's frozen-guard triggers on public.app_secrets present and enabled; no table
-- privilege for anon, authenticated or service_role on the four proxima_auth tables (users, auth_config,
-- signin_throttle and M1's seed snapshot m1_seed_snapshot, review round 16 #2), each with row security on; no new P1 function executable
-- through PUBLIC; the new unlock granted like verify_admin (anon, authenticated, service_role); the throttle not 'on'
-- (M1 sets 'observe' and rate limits stay off by default; M1b's commit drops that line); and, against the pre-M1 list
-- embedded below (captured live 2026-10-23, schemas public and proxima_auth, identical for anon and authenticated),
-- the only function newly executable by anon or authenticated is public.unlock_with_backup_code(text,text,text).
-- When a later reviewed migration adds a browser-callable function, add it to that list in the same commit. M3's
-- precondition block reuses these checks.
-- no-admin-mint (design §3, §9.2; M3 = supabase/migrations/20261023300000_mu_p1_mint_u_tokens.sql): once M3 is live,
-- no body in public or proxima_auth matches (?i)'admin:'\s*\|\| ; before M3 the only match is issue_session (the
-- owner's 'admin:'||username branch). M3 is detected by issue_session's body: its reviewed post-apply md5, or no
-- 'admin:' || in it. Both states pass:
--   live without M3:  node scripts/tools/sql-tx.mjs --test scripts/test-mu-p1-catalog.sql               (no-admin-mint pre-M3)
--   with M3:          node scripts/tools/sql-tx.mjs <M3> --test scripts/test-mu-p1-catalog.sql          (no-admin-mint M3 live)
do $g$
declare
  pre_m1 constant text[] := array[
    'public._history_is_open(jsonb)', 'public._outputs_archived(jsonb)', 'public._settings_marker_server_only()',
    'public._settings_stamp_updated_at()', 'public.change_my_password(text,text,text)',
    'public.clear_queued_rows(text,text,bigint,text[])', 'public.delete_my_backup_phase2(text,uuid)',
    'public.delete_queued_rows(text,text,text[],bigint)', 'public.generations_live(text,text[])',
    'public.get_auto_backups(text)', 'public.get_my_account(text)', 'public.list_my_backups_phase2(text,integer)',
    'public.paths_in_use(text,text[])', 'proxima_auth.session_scope(boolean)',
    'public.purge_my_backups_of(text,text[],text[])', 'public.rename_my_account(text,text,text)',
    'public.reset_queued_rows(text,bigint,text[],text[],bigint)', 'public.restore_my_backup_phase2(text,uuid)',
    'public.server_time_ms(text)', 'public.set_admin_backup_code(text,text,text)',
    'public.set_admin_credentials_rehash(text,text)', 'public.set_auto_backups(text,boolean)',
    'public.set_my_account(text,text,boolean,bigint)', 'public.set_my_wavespeed_key(text,text)',
    'public.snapshot_my_data_phase2(text,text,text)', 'public.unlock_admin_with_backup_code(text,text)',
    'public.upsert_queued_history(text,jsonb,bigint)', 'public.verify_admin(text,text)'];
  m3_post constant text := 'b9ba44a18b04d17bdf0034b944a57035';   -- M3's issue_session (pg_get_functiondef md5)
  out text := ''; v text; n int; n2 int; v_m3 boolean;
begin
  if to_regclass('proxima_auth.users') is null then
    raise exception 'RESULT: ok p1-catalog-skipped (no M1: run with M1 prepended); ';
  end if;
  select string_agg(p.proname, ',') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname <> '_verify_session_token'
     and p.prosrc like '%_verify_session_token(p_session_token)%' and p.prosrc not like '%proxima_auth.current_account%';
  out := out || case when v is null then 'ok semantic; ' else format('FAIL semantic %s; ', left(v, 120)) end;
  select string_agg(p.proname, ',') into v from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc ~* 'else\s+(\w+\s*:=\s*)?v_subject';
  out := out || case when v is null then 'ok no-fall-through; ' else format('FAIL no-fall-through %s; ', left(v, 120)) end;
  select string_agg(p.pronamespace::regnamespace || '.' || p.proname, ',') into v from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc like '%''admin:%'
     and (p.pronamespace::regnamespace::text || '.' || p.proname) not in
         ('public._verify_session_token', 'proxima_auth.current_account', 'proxima_auth.session_scope', 'proxima_auth.issue_session');
  out := out || case when v is null then 'ok admin-literal-places; ' else format('FAIL admin-literal-places %s; ', left(v, 120)) end;
  select count(*) into n from unnest(array['proxima_auth.users','proxima_auth.auth_config','proxima_auth.signin_throttle',
                                           'proxima_auth.m1_seed_snapshot']) t,
         unnest(array['anon','authenticated','service_role']) g,
         unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr
   where has_table_privilege(g, t, pr);
  select count(*) into n2 from unnest(array['proxima_auth.users','proxima_auth.auth_config','proxima_auth.signin_throttle',
                                            'proxima_auth.m1_seed_snapshot']) t
   where not coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass(t)), false);
  out := out || case when n = 0 and n2 = 0 then 'ok no-table-privilege; ' else format('FAIL no-table-privilege %s rls-off=%s; ', n, n2) end;
  select string_agg(p.oid::regprocedure::text || ':' || g, ',') into v
    from pg_proc p, unnest(array['anon','authenticated','service_role']) g
   where p.oid in (to_regprocedure('proxima_auth.current_account(text)'), to_regprocedure('proxima_auth.issue_session(uuid)'),
                   to_regprocedure('proxima_auth.mint_token(uuid)'), to_regprocedure('proxima_auth._reauth(uuid,text)'),
                   to_regprocedure('proxima_auth._revoke_sessions(uuid)'), to_regprocedure('proxima_auth._throttle(text,boolean)'),
                   to_regprocedure('proxima_auth.m1_frozen_guard()'))
     and has_function_privilege(g, p.oid, 'EXECUTE');
  out := out || case when v is null then 'ok helpers-postgres-only; ' else format('FAIL helpers-postgres-only %s; ', left(v, 120)) end;
  select count(*) into n from pg_proc p, aclexplode(p.proacl) a
   where p.oid in (to_regprocedure('proxima_auth.current_account(text)'), to_regprocedure('proxima_auth.issue_session(uuid)'),
                   to_regprocedure('proxima_auth.mint_token(uuid)'), to_regprocedure('proxima_auth._reauth(uuid,text)'),
                   to_regprocedure('proxima_auth._revoke_sessions(uuid)'), to_regprocedure('proxima_auth._throttle(text,boolean)'),
                   to_regprocedure('public.unlock_with_backup_code(text,text,text)'), to_regprocedure('proxima_auth.m1_frozen_guard()'))
     and a.grantee = 0;
  out := out || case when n = 0 then 'ok no-public-execute; ' else format('FAIL no-public-execute %s; ', n) end;
  select count(*) into n from unnest(array['anon','authenticated','service_role']) g
   where has_function_privilege(g, 'public.unlock_with_backup_code(text,text,text)', 'EXECUTE')
     and has_function_privilege(g, 'public.verify_admin(text,text)', 'EXECUTE');
  out := out || case when n = 3 then 'ok unlock-grants-like-verify-admin; ' else format('FAIL unlock-grants-like-verify-admin %s of 3; ', n) end;
  select string_agg(distinct p.oid::regprocedure::text, ',') into v
    from pg_proc p, unnest(array['anon','authenticated']) g
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace)
     and has_function_privilege(g, p.oid, 'EXECUTE')
     and not (p.oid = any (array(select to_regprocedure(x) from unnest(pre_m1) x where to_regprocedure(x) is not null)));
  out := out || case when v in ('unlock_with_backup_code(text,text,text)', 'public.unlock_with_backup_code(text,text,text)')
    then 'ok only-unlock-newly-browser-callable; '
    else format('FAIL only-unlock-newly-browser-callable %s; ', left(coalesce(v, 'none'), 160)) end;
  -- M1's frozen guard (review round 17): an owner-only trigger function (checked above), and both triggers on
  -- public.app_secrets present, calling it, enabled: per row before insert/update/delete (tgtype 31) and before truncate (34).
  select count(*) into n from pg_trigger tg
   where tg.tgrelid = 'public.app_secrets'::regclass and tg.tgfoid = to_regprocedure('proxima_auth.m1_frozen_guard()')
     and tg.tgenabled in ('O', 'A')
     and ((tg.tgname = 'app_secrets_m1_frozen' and tg.tgtype = 31) or (tg.tgname = 'app_secrets_m1_frozen_truncate' and tg.tgtype = 34));
  select count(*) into n2 from pg_proc p
   where p.oid = to_regprocedure('proxima_auth.m1_frozen_guard()') and p.prorettype = 'trigger'::regtype
     and p.proconfig = array['search_path=""'];
  out := out || case when n = 2 and n2 = 1 then 'ok frozen-guard-triggers; ' else format('FAIL frozen-guard-triggers triggers=%s fn=%s; ', n, n2) end;
  select (select c.signin_throttle from proxima_auth.auth_config c) into v;
  out := out || case when v in ('observe', 'off') then format('ok throttle-not-on (%s); ', v) else format('FAIL throttle-not-on %s; ', v) end;
  -- no-admin-mint: from M3 nothing mints 'admin:'; before M3 only issue_session does.
  select md5(d) = m3_post or d !~* $re$'admin:'\s*\|\|$re$ into v_m3
    from pg_get_functiondef(to_regprocedure('proxima_auth.issue_session(uuid)')) d;
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc ~* $re$'admin:'\s*\|\|$re$;
  out := out || case
    when v_m3 is null then 'FAIL no-admin-mint issue_session missing; '
    when v_m3 and v is null then 'ok no-admin-mint (M3 live); '
    when not v_m3 and v = 'proxima_auth.issue_session(uuid)' then 'ok no-admin-mint (pre-M3: issue_session only); '
    else format('FAIL no-admin-mint m3=%s %s; ', v_m3, left(coalesce(v, 'none'), 120)) end;
  raise exception 'RESULT: %', out;
end $g$;
