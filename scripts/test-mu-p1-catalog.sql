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
-- M4 (supabase/migrations/20261023400000_mu_p1_end_dual_accept.sql) is detected by public.set_admin_credentials_rehash
-- being gone. From M4: no-admin-accept (the literal 'admin: only in _verify_session_token, once, in the branch that
-- raises 'session token revoked'; replaces admin-literal-places), frozen-guard-retired (the guard function, both
-- triggers and proxima_auth.m1_seed_snapshot gone; replaces frozen-guard-triggers), m4-drops (set_admin_credentials_rehash
-- gone, the old 2-argument unlock_admin_with_backup_code kept and still callable by anon, authenticated, service_role
-- until after client step C1), and no-table-privilege covers the three remaining tables (the snapshot must be gone).
-- Before M4, m4-drops checks the other way (rehash present, guard and snapshot present). Before 21:06:07 UTC on
-- 2026-10-23 prepend M4's no-clock scratch copy (M4's header):
--   with M4:          node scripts/tools/sql-tx.mjs <M4 or its no-clock copy> --test scripts/test-mu-p1-catalog.sql
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
  -- Browser-callable on purpose after P1, so not 'new since M1': the storage policies' folder check (P4, RLS session,
  -- 20261025100000_mu_p4_storage_folders).
  later constant text[] := array['proxima_auth.my_folders(boolean)', 'proxima_auth.object_folder(text)',
    -- 20261025500000_mu_p5_provider_keys: a browser saves, lists (fingerprints only) and clears its own account's keys
    'public.set_my_provider_key(text,text,text)', 'public.clear_my_provider_key(text,text)', 'public.my_provider_keys(text)'];
  m3_post constant text := 'b9ba44a18b04d17bdf0034b944a57035';   -- M3's issue_session (pg_get_functiondef md5)
  out text := ''; v text; n int; n2 int; v_m3 boolean; v_m4 boolean; v_tabs text[];
begin
  if to_regclass('proxima_auth.users') is null then
    raise exception 'RESULT: ok p1-catalog-skipped (no M1: run with M1 prepended); ';
  end if;
  v_m4 := to_regprocedure('public.set_admin_credentials_rehash(text,text)') is null;
  v_tabs := array['proxima_auth.users','proxima_auth.auth_config','proxima_auth.signin_throttle']
            || case when v_m4 then array[]::text[] else array['proxima_auth.m1_seed_snapshot'] end;
  select string_agg(p.proname, ',') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname <> '_verify_session_token'
     and p.prosrc like '%_verify_session_token(p_session_token)%' and p.prosrc not like '%proxima_auth.current_account%';
  out := out || case when v is null then 'ok semantic; ' else format('FAIL semantic %s; ', left(v, 120)) end;
  select string_agg(p.proname, ',') into v from pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc ~* 'else\s+(\w+\s*:=\s*)?v_subject';
  out := out || case when v is null then 'ok no-fall-through; ' else format('FAIL no-fall-through %s; ', left(v, 120)) end;
  if not v_m4 then
    select string_agg(p.pronamespace::regnamespace || '.' || p.proname, ',') into v from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc like '%''admin:%'
       and (p.pronamespace::regnamespace::text || '.' || p.proname) not in
           ('public._verify_session_token', 'proxima_auth.current_account', 'proxima_auth.session_scope', 'proxima_auth.issue_session');
    out := out || case when v is null then 'ok admin-literal-places; ' else format('FAIL admin-literal-places %s; ', left(v, 120)) end;
  else
    -- no-admin-accept: nothing but the verifier mentions 'admin:, and there only as the explicit revoke.
    select string_agg(p.pronamespace::regnamespace || '.' || p.proname, ',') into v from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'proxima_auth'::regnamespace) and p.prosrc like '%''admin:%'
       and p.oid <> 'public._verify_session_token(text)'::regprocedure;
    select (length(p.prosrc) - length(replace(p.prosrc, '''admin:', ''))) / length('''admin:') = 1
           and p.prosrc ~ $re$elsif v_subject like 'admin:%' then\n(\s*--[^\n]*\n)*\s*raise exception 'session token revoked';$re$
      into v_m3 from pg_proc p where p.oid = 'public._verify_session_token(text)'::regprocedure;
    out := out || case when v is null and v_m3 then 'ok no-admin-accept (M4: only the verifier''s explicit revoke); '
                       else format('FAIL no-admin-accept others=%s verifier-revoke-only=%s; ', left(coalesce(v, 'none'), 100), v_m3) end;
  end if;
  select count(*) into n from unnest(v_tabs) t,
         unnest(array['anon','authenticated','service_role']) g,
         unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr
   where has_table_privilege(g, t, pr);
  select count(*) into n2 from unnest(v_tabs) t
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
     and not (p.oid = any (array(select to_regprocedure(x) from unnest(pre_m1 || later) x where to_regprocedure(x) is not null)));
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
  if not v_m4 then
    out := out || case when n = 2 and n2 = 1 then 'ok frozen-guard-triggers; ' else format('FAIL frozen-guard-triggers triggers=%s fn=%s; ', n, n2) end;
  else
    -- frozen-guard-retired: M4 dropped both triggers, the guard function and the seed snapshot.
    select count(*) into n from pg_trigger tg where tg.tgname in ('app_secrets_m1_frozen', 'app_secrets_m1_frozen_truncate');
    out := out || case when n = 0 and to_regprocedure('proxima_auth.m1_frozen_guard()') is null
                            and to_regclass('proxima_auth.m1_seed_snapshot') is null
      then 'ok frozen-guard-retired (M4); '
      else format('FAIL frozen-guard-retired triggers=%s fn=%s snapshot=%s; ', n, to_regprocedure('proxima_auth.m1_frozen_guard()') is not null,
                  to_regclass('proxima_auth.m1_seed_snapshot') is not null) end;
  end if;
  -- m4-drops: from M4 set_admin_credentials_rehash is gone and the old unlock stays callable (until after client C1);
  -- before M4 the rehash function, the guard and the snapshot are still there.
  select count(*) into n from unnest(array['anon','authenticated','service_role']) g
   where to_regprocedure('public.unlock_admin_with_backup_code(text,text)') is not null
     and has_function_privilege(g, 'public.unlock_admin_with_backup_code(text,text)', 'EXECUTE');
  out := out || case
    when v_m4 and n = 3 then 'ok m4-drops (rehash gone, old unlock kept); '
    when not v_m4 and n = 3 and to_regprocedure('proxima_auth.m1_frozen_guard()') is not null
         and to_regclass('proxima_auth.m1_seed_snapshot') is not null then 'ok m4-drops (pre-M4: nothing dropped yet); '
    else format('FAIL m4-drops m4=%s old-unlock-grants=%s of 3; ', v_m4, n) end;
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
