-- Proof for M1's frozen guard and scripts/mu-p1-post-apply-check.sql (docs/P1-AUTH-DESIGN.md §2; review round 17
-- #2/#4/#5). One DO block that always ends in raise exception 'RESULT: ...', so everything rolls back.
--   with M1:     node scripts/tools/sql-tx.mjs supabase/migrations/20261023100000_mu_p1_accounts.sql --test scripts/test-mu-frozen-guard.sql
--   after M1:    node scripts/tools/sql-tx.mjs --test scripts/test-mu-frozen-guard.sql
--   without M1:  the same command prints a skip line (passes).
-- guard-objects: proxima_auth.m1_frozen_guard() is a trigger function with search_path '', not security definer, not
--   executable by PUBLIC, anon, authenticated or service_role; app_secrets_m1_frozen (BEFORE INSERT OR UPDATE OR DELETE,
--   per row) and app_secrets_m1_frozen_truncate (BEFORE TRUNCATE) are on public.app_secrets, call it, and are enabled.
-- check-same-after-m1: the check reads same = true, no changed key, guard 'on'.
-- frozen-refuse-row-writes: each of the 9 frozen keys refuses an insert (ON CONFLICT DO NOTHING too: the trigger runs
--   first), and an update and a delete where its row exists, with errcode 55000 and the guard's message; renaming a key
--   into or out of the set is refused too. frozen-refuse-truncate: TRUNCATE public.app_secrets is refused.
-- others-writable: auto_backups, session_signing_key and a scratch key still take writes.
-- old-body-after-commit: the pre-M1 bodies of verify_admin (wrong password), change_my_password, set_my_account and
--   unlock_admin_with_backup_code (verbatim from M1's capture, created under pg_temp scratch names; the M1 generator
--   asserts the copies) and the still-live old helper _revoke_admin_sessions run after M1, as a call blocked on M1's lock
--   does after the commit: each raises 55000 at its first app_secrets write, and app_secrets and the owner row are
--   unchanged (the call rolls back whole).
-- check-same-after-new-code: a stranger's lockout, unlock_with_backup_code, a sign-in plus password change, a rename and
--   set_my_account (new code, as anon with tokens) each leave the check at same = true with no changed key.
-- No hash, key, code or token is selected or printed; fixtures are cost-4 hashes, '__mu_fg_*' names, documentation
-- addresses and IPs. The live rows are only compared through md5 inside this rolled-back block.
do $t$
declare
  v_check constant text := $q$select c.k = '' and g.n = 2 as same, c.k as changed_keys,
       case when g.n = 2 then 'on' else format('%s of 2 triggers in place', g.n) end as guard
  from (select coalesce(string_agg(x.key, ', ' order by x.key), '') as k
          from unnest(array['admin_username', 'admin_password_hash', 'admin_backup_code_hash', 'admin_email',
                            'admin_email_verified', 'admin_last_verified_at', 'admin_sessions_valid_after',
                            'admin_login_lockout', 'admin_backup_attempts']) x(key)
         where (select md5(a.value::text) from public.app_secrets a where a.key = x.key)
               is distinct from (select m.value_md5 from proxima_auth.m1_seed_snapshot m where m.key = x.key)) c,
       (select count(*) as n
          from pg_trigger t
         where t.tgrelid = 'public.app_secrets'::regclass
           and t.tgfoid = to_regprocedure('proxima_auth.m1_frozen_guard()')
           and t.tgenabled in ('O', 'A')
           -- tgtype 31 = ROW | BEFORE | INSERT | DELETE | UPDATE; 34 = BEFORE | TRUNCATE (per statement)
           and ((t.tgname = 'app_secrets_m1_frozen' and t.tgtype = 31)
                or (t.tgname = 'app_secrets_m1_frozen_truncate' and t.tgtype = 34))) g$q$;
  fk constant text[] := array['admin_username', 'admin_password_hash', 'admin_backup_code_hash', 'admin_email', 'admin_email_verified', 'admin_last_verified_at', 'admin_sessions_valid_after', 'admin_login_lockout', 'admin_backup_attempts'];
  msg constant text := 'app_secrets admin rows are frozen since P1 M1; write proxima_auth.users';
  o_verify constant text := $o$CREATE FUNCTION pg_temp.mu_fg_old_verify_admin(p_username text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_user   text := (select value->>'username' from app_secrets where key = 'admin_username');
  v_bcrypt text := (select value->>'password_hash' from app_secrets where key = 'admin_password_hash');
  v_legacy text := (select value->>'hash' from app_secrets where key = 'admin_password_hash_legacy_sha256');
  v_lock   jsonb;
  v_failed int;
  v_ok     boolean := false;
  v_rehash boolean := false;
  v_exp    timestamptz := now() + interval '12 hours';
begin
  if v_user is null then return json_build_object('ok', false, 'reason', 'not_provisioned'); end if;
  insert into app_secrets (key, value, updated_at) values ('admin_login_lockout', '{"failed":0,"locked":false}', now())
    on conflict (key) do nothing;
  select value into v_lock from app_secrets where key = 'admin_login_lockout' for update;
  if coalesce((v_lock->>'locked')::boolean, false) then
    return json_build_object('ok', false, 'reason', 'locked');
  end if;
  if p_username = v_user and p_password is not null then
    if v_bcrypt is not null and crypt(p_password, v_bcrypt) = v_bcrypt then
      v_ok := true;
    elsif v_legacy is not null and encode(digest(p_password, 'sha256'), 'hex') = v_legacy then
      v_ok := true; v_rehash := true;
    end if;
  end if;
  if not v_ok then
    v_failed := coalesce((v_lock->>'failed')::int, 0) + 1;
    update app_secrets set updated_at = now(),
      value = jsonb_build_object('failed', v_failed, 'locked', v_failed >= 3, 'locked_at', case when v_failed >= 3 then now() end)
      where key = 'admin_login_lockout';
    if v_failed >= 3 then return json_build_object('ok', false, 'reason', 'locked'); end if;
    return json_build_object('ok', false, 'reason', 'invalid', 'attempts_left', 3 - v_failed);
  end if;
  update app_secrets set value = '{"failed":0,"locked":false}', updated_at = now() where key = 'admin_login_lockout';
  return json_build_object('ok', true, 'token', _sign_session_token('admin:' || v_user, v_exp),
    'expires_at', extract(epoch from v_exp)::bigint, 'rehash_required', v_rehash, 'username', v_user);
end $function$
$o$;
  o_change constant text := $o$CREATE FUNCTION pg_temp.mu_fg_old_change_my_password(p_session_token text, p_current_password text, p_new_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_subject text := _verify_session_token(p_session_token); v_auth text;
  v_exp timestamptz := now() + interval '12 hours';
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_new_password is null or length(p_new_password) < 8 then return json_build_object('ok', false, 'reason', 'weak_password'); end if;
  v_auth := _reauth_admin(p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  insert into app_secrets (key, value, updated_at)
    values ('admin_password_hash', jsonb_build_object('password_hash', crypt(p_new_password, gen_salt('bf', 12))), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from app_secrets where key = 'admin_password_hash_legacy_sha256';
  perform _revoke_admin_sessions();
  return json_build_object('ok', true, 'username', substring(v_subject from 7),
    'token', _sign_session_token(v_subject, v_exp), 'expires_at', extract(epoch from v_exp)::bigint);
end $function$
$o$;
  o_setacc constant text := $o$CREATE FUNCTION pg_temp.mu_fg_old_set_my_account(p_session_token text, p_email text DEFAULT NULL::text, p_email_verified boolean DEFAULT NULL::boolean, p_last_verified_at bigint DEFAULT NULL::bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_subject text := _verify_session_token(p_session_token);
begin
  if v_subject not like 'admin:%' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_email is not null then
    insert into app_secrets (key, value, updated_at) values ('admin_email', jsonb_build_object('email', p_email), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_email_verified is not null then
    insert into app_secrets (key, value, updated_at) values ('admin_email_verified', jsonb_build_object('verified', p_email_verified), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if p_last_verified_at is not null then
    insert into app_secrets (key, value, updated_at) values ('admin_last_verified_at', jsonb_build_object('at', p_last_verified_at), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return json_build_object('ok', true);
end $function$
$o$;
  o_unlock constant text := $o$CREATE FUNCTION pg_temp.mu_fg_old_unlock_admin_with_backup_code(p_code text, p_new_password text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_hash text := (select value->>'hash' from app_secrets where key = 'admin_backup_code_hash');
  v_bk   jsonb;
  v_failed int;
  v_until timestamptz;
begin
  if v_hash is null then return json_build_object('ok', false, 'reason', 'no_backup_code'); end if;
  if p_new_password is not null and length(p_new_password) < 8 then
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  insert into app_secrets (key, value, updated_at) values ('admin_backup_attempts', '{"failed":0}', now())
    on conflict (key) do nothing;
  select value into v_bk from app_secrets where key = 'admin_backup_attempts' for update;
  v_until := nullif(v_bk->>'locked_until', '')::timestamptz;
  if v_until is not null and v_until > now() then
    return json_build_object('ok', false, 'reason', 'backup_locked', 'retry_after', ceil(extract(epoch from v_until - now()))::int);
  end if;
  if p_code is null or crypt(trim(p_code), v_hash) <> v_hash then
    v_failed := case when v_until is not null then 0 else coalesce((v_bk->>'failed')::int, 0) end + 1;
    if v_failed >= 5 then
      update app_secrets set updated_at = now(),
        value = jsonb_build_object('failed', 0, 'locked_until', now() + interval '15 minutes') where key = 'admin_backup_attempts';
      return json_build_object('ok', false, 'reason', 'backup_locked', 'retry_after', 900);
    end if;
    update app_secrets set updated_at = now(), value = jsonb_build_object('failed', v_failed) where key = 'admin_backup_attempts';
    return json_build_object('ok', false, 'reason', 'invalid', 'attempts_left', 5 - v_failed);
  end if;
  update app_secrets set value = '{"failed":0}', updated_at = now() where key = 'admin_backup_attempts';
  update app_secrets set value = '{"failed":0,"locked":false}', updated_at = now() where key = 'admin_login_lockout';
  if p_new_password is not null then
    insert into app_secrets (key, value, updated_at)
      values ('admin_password_hash', jsonb_build_object('password_hash', crypt(p_new_password, gen_salt('bf', 12))), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
    delete from app_secrets where key = 'admin_password_hash_legacy_sha256';
  end if;
  perform _revoke_admin_sessions();
  return json_build_object('ok', true, 'password_changed', p_new_password is not null);
end $function$
$o$;
  po constant text := 'mu-fg-owner-pass-01'; po2 constant text := 'mu-fg-owner-pass-02'; po3 constant text := 'mu-fg-owner-pass-03';
  ko constant text := 'mu-fg-owner-code-000001'; nm constant text := '__mu_fg_owner';
  out text := ''; v_same boolean; v_keys text; v_guard text; n int; m int; k text; st text; v_bad text := '';
  v_has boolean; v_rows int := 0; r json; t text; t2 text; t3 text; v_owner text; v_id uuid; v_sec text; v_row text;
  ok boolean; v_lt text;
begin
  if to_regclass('proxima_auth.users') is null then
    raise exception 'RESULT: ok frozen-guard-skipped (no M1: run with M1 prepended, see the header); ';
  end if;
  select u.username, u.id into v_owner, v_id from proxima_auth.users u where u.role = 'owner';

  -- Runs one statement and always rolls it back: 'refused' (the guard), 'done <rows>', or the error's sqlstate.
  create function pg_temp.mu_fg_try(p_sql text, p_msg text) returns text language plpgsql as $f$
  declare v_n int;
  begin
    begin
      execute p_sql;
      get diagnostics v_n = row_count;
      raise exception 'mu-fg-done %', v_n;
    exception
      when sqlstate '55000' then return case when sqlerrm = p_msg then 'refused' else 'other 55000' end;
      when others then return case when sqlerrm like 'mu-fg-done %' then 'done ' || substring(sqlerrm from 12) else 'error ' || sqlstate end;
    end;
  end $f$;

  -- guard-objects
  select count(*) into n from pg_proc p
   where p.oid = to_regprocedure('proxima_auth.m1_frozen_guard()')
     and p.prorettype = 'trigger'::regtype and not p.prosecdef and p.proconfig = array['search_path=""']
     and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE');
  select count(*) into m from pg_trigger tg
   where tg.tgrelid = 'public.app_secrets'::regclass and tg.tgfoid = to_regprocedure('proxima_auth.m1_frozen_guard()')
     and tg.tgenabled = 'O'
     and ((tg.tgname = 'app_secrets_m1_frozen' and tg.tgtype = 31) or (tg.tgname = 'app_secrets_m1_frozen_truncate' and tg.tgtype = 34));
  out := out || case when n = 1 and m = 2 then 'ok guard-objects; ' else format('FAIL guard-objects fn=%s triggers=%s; ', n, m) end;

  -- check-same-after-m1
  execute v_check into v_same, v_keys, v_guard;
  out := out || case when v_same and v_keys = '' and v_guard = 'on' then 'ok check-same-after-m1; '
                     else format('FAIL check-same-after-m1 %s [%s] %s; ', v_same, v_keys, v_guard) end;

  -- frozen-refuse-row-writes
  n := 0;
  foreach k in array fk loop
    v_has := exists (select 1 from public.app_secrets a where a.key = k);
    if v_has then v_rows := v_rows + 1; end if;
    st := pg_temp.mu_fg_try(format('insert into public.app_secrets (key, value, updated_at) values (%L, %L::jsonb, now()) on conflict (key) do nothing', k, '{}'), msg);
    if st = 'refused' then n := n + 1; else v_bad := v_bad || format('ins %s %s, ', k, st); end if;
    st := pg_temp.mu_fg_try(format('insert into public.app_secrets (key, value, updated_at) values (%L, %L::jsonb, now()) on conflict (key) do update set value = excluded.value', k, '{}'), msg);
    if st = 'refused' then n := n + 1; else v_bad := v_bad || format('upsert %s %s, ', k, st); end if;
    st := pg_temp.mu_fg_try(format('update public.app_secrets set updated_at = updated_at where key = %L', k), msg);
    if (v_has and st = 'refused') or (not v_has and st = 'done 0') then n := n + 1; else v_bad := v_bad || format('upd %s %s, ', k, st); end if;
    st := pg_temp.mu_fg_try(format('delete from public.app_secrets where key = %L', k), msg);
    if (v_has and st = 'refused') or (not v_has and st = 'done 0') then n := n + 1; else v_bad := v_bad || format('del %s %s, ', k, st); end if;
  end loop;
  -- a key renamed into the set (session_signing_key always exists) and out of it (admin_username always exists)
  st := pg_temp.mu_fg_try('update public.app_secrets set key = ''admin_last_verified_at'' where key = ''session_signing_key''', msg);
  if st = 'refused' then n := n + 1; else v_bad := v_bad || format('rename-in %s, ', st); end if;
  st := pg_temp.mu_fg_try('update public.app_secrets set key = ''__mu_fg_moved'' where key = ''admin_username''', msg);
  if st = 'refused' then n := n + 1; else v_bad := v_bad || format('rename-out %s, ', st); end if;
  out := out || case when n = 4 * cardinality(fk) + 2 and v_bad = '' and v_rows >= 1
    then format('ok frozen-refuse-row-writes (%s keys, %s rows); ', cardinality(fk), v_rows)
    else format('FAIL frozen-refuse-row-writes %s of %s: %s; ', n, 4 * cardinality(fk) + 2, left(v_bad, 300)) end;

  -- frozen-refuse-truncate (ACCESS EXCLUSIVE for a moment, inside a subtransaction that aborts at once)
  v_lt := current_setting('lock_timeout');
  perform set_config('lock_timeout', '10s', true);
  st := pg_temp.mu_fg_try('truncate public.app_secrets', msg);
  perform set_config('lock_timeout', v_lt, true);
  out := out || case when st = 'refused' then 'ok frozen-refuse-truncate; ' else format('FAIL frozen-refuse-truncate %s; ', st) end;

  -- others-writable
  v_bad := '';
  insert into public.app_secrets (key, value, updated_at) values ('__mu_fg_scratch', '{"x":1}', now());
  st := pg_temp.mu_fg_try('update public.app_secrets set value = ''{"x":2}'' where key = ''__mu_fg_scratch''', msg);
  if st <> 'done 1' then v_bad := v_bad || 'scratch-upd ' || st || ', '; end if;
  st := pg_temp.mu_fg_try('delete from public.app_secrets where key = ''__mu_fg_scratch''', msg);
  if st <> 'done 1' then v_bad := v_bad || 'scratch-del ' || st || ', '; end if;
  st := pg_temp.mu_fg_try('insert into public.app_secrets (key, value, updated_at) values (''__mu_fg_scratch2'', ''{}'', now())', msg);
  if st <> 'done 1' then v_bad := v_bad || 'scratch-ins ' || st || ', '; end if;
  st := pg_temp.mu_fg_try('update public.app_secrets set value = value, updated_at = updated_at where key = ''session_signing_key''', msg);
  if st <> 'done 1' then v_bad := v_bad || 'signing-key ' || st || ', '; end if;
  st := pg_temp.mu_fg_try('insert into public.app_secrets (key, value, updated_at) values (''auto_backups'', ''{"enabled": false}'', now()) on conflict (key) do update set value = public.app_secrets.value', msg);
  if st <> 'done 1' then v_bad := v_bad || 'auto-backups ' || st || ', '; end if;
  delete from public.app_secrets where key = '__mu_fg_scratch';
  out := out || case when v_bad = '' then 'ok others-writable; ' else format('FAIL others-writable %s; ', v_bad) end;

  -- old-body-after-commit
  execute o_verify; execute o_change; execute o_setacc; execute o_unlock;
  select md5(string_agg(a.key || '=' || a.value::text || '@' || a.updated_at::text, ';' order by a.key)) into v_sec from public.app_secrets a;
  select md5(u::text) into v_row from proxima_auth.users u where u.role = 'owner';
  v_bad := ''; n := 0;
  begin
    r := pg_temp.mu_fg_old_verify_admin(v_owner, 'mu-fg-wrong-password-0');
    v_bad := v_bad || 'verify answered ' || coalesce(r->>'reason', 'ok') || ', ';
  exception when others then
    if sqlstate = '55000' and sqlerrm = msg then n := n + 1; else v_bad := v_bad || 'verify ' || sqlstate || ', '; end if;
  end;
  t := public._sign_session_token('admin:' || v_owner, to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint,
         (select u.sessions_valid_after from proxima_auth.users u where u.id = v_id) + 1) + 43200));   -- an owner 'admin:<name>' token, as the old client holds (mint_token gives 'u:' from M3)
  begin
    r := pg_temp.mu_fg_old_change_my_password(t, 'mu-fg-any-current', po2);
    v_bad := v_bad || 'change answered ' || coalesce(r->>'reason', 'ok') || ', ';
  exception when others then
    if sqlstate = '55000' and sqlerrm = msg then n := n + 1; else v_bad := v_bad || 'change ' || sqlstate || ', '; end if;
  end;
  begin
    r := pg_temp.mu_fg_old_set_my_account(t, '__mu_fg@example.invalid', true, 1234567890123);
    v_bad := v_bad || 'setacc answered ' || coalesce(r->>'reason', 'ok') || ', ';
  exception when others then
    if sqlstate = '55000' and sqlerrm = msg then n := n + 1; else v_bad := v_bad || 'setacc ' || sqlstate || ', '; end if;
  end;
  begin
    r := pg_temp.mu_fg_old_unlock_admin_with_backup_code(ko, po2);
    -- with no frozen code row the old body answers before any write: nothing to refuse, nothing written
    if r->>'reason' = 'no_backup_code' and not exists (select 1 from public.app_secrets a where a.key = 'admin_backup_code_hash') then
      n := n + 1;
    else
      v_bad := v_bad || 'unlock answered ' || coalesce(r->>'reason', 'ok') || ', ';
    end if;
  exception when others then
    if sqlstate = '55000' and sqlerrm = msg then n := n + 1; else v_bad := v_bad || 'unlock ' || sqlstate || ', '; end if;
  end;
  begin
    perform public._revoke_admin_sessions();
    v_bad := v_bad || 'revoke ran, ';
  exception when others then
    if sqlstate = '55000' and sqlerrm = msg then n := n + 1; else v_bad := v_bad || 'revoke ' || sqlstate || ', '; end if;
  end;
  ok := (select md5(string_agg(a.key || '=' || a.value::text || '@' || a.updated_at::text, ';' order by a.key)) from public.app_secrets a) = v_sec
        and (select md5(u::text) from proxima_auth.users u where u.role = 'owner') = v_row;
  out := out || case when n = 5 and v_bad = '' and ok then 'ok old-body-after-commit (5 refused, nothing changed); '
                     else format('FAIL old-body-after-commit %s of 5 unchanged=%s %s; ', n, ok, v_bad) end;

  -- check-same-after-new-code
  begin
    perform set_config('request.headers', '{"cf-connecting-ip":"192.0.2.81"}', true);
    update proxima_auth.users set password_hash = extensions.crypt(po, extensions.gen_salt('bf', 4)),
           backup_code_hash = extensions.crypt(ko, extensions.gen_salt('bf', 4)),
           login_failed = 0, login_locked_at = null, backup_failed = 0, backup_locked_until = null
     where id = v_id;
    v_bad := '';
    -- a stranger's lockout
    set local role anon;
    for i in 1..3 loop r := verify_admin(v_owner, 'mu-fg-wrong-password-' || i); end loop;
    reset role;
    ok := (select login_locked_at is not null and login_failed >= 3 from proxima_auth.users where id = v_id);
    execute v_check into v_same, v_keys, v_guard;
    if not (ok and v_same and v_keys = '') then v_bad := v_bad || format('lockout %s %s [%s], ', ok, v_same, v_keys); end if;
    -- the unlock (new 3-argument call), with a new password
    set local role anon;
    r := unlock_with_backup_code(v_owner, ko, po2);
    reset role;
    ok := (r->>'ok')::boolean and (select login_locked_at is null and login_failed = 0 from proxima_auth.users where id = v_id);
    execute v_check into v_same, v_keys, v_guard;
    if not (ok and v_same and v_keys = '') then v_bad := v_bad || format('unlock %s %s [%s], ', ok, v_same, v_keys); end if;
    -- sign-in and a password change
    set local role anon;
    r := verify_admin(v_owner, po2);
    t := r->>'token';
    r := change_my_password(t, po2, po3);
    t2 := r->>'token';
    reset role;
    ok := (r->>'ok')::boolean and (select password_hash = extensions.crypt(po3, password_hash) from proxima_auth.users where id = v_id);
    execute v_check into v_same, v_keys, v_guard;
    if not (ok and v_same and v_keys = '') then v_bad := v_bad || format('pwchange %s %s [%s], ', ok, v_same, v_keys); end if;
    -- a rename
    set local role anon;
    r := rename_my_account(t2, po3, nm);
    t3 := r->>'token';
    reset role;
    ok := (r->>'ok')::boolean and (select username = nm and scope = 'user:' || nm from proxima_auth.users where id = v_id);
    execute v_check into v_same, v_keys, v_guard;
    if not (ok and v_same and v_keys = '') then v_bad := v_bad || format('rename %s %s [%s], ', ok, v_same, v_keys); end if;
    -- an Account change
    set local role anon;
    r := set_my_account(t3, '__mu_fg@example.invalid', true, 1234567890123);
    reset role;
    ok := (r->>'ok')::boolean and (select email = '__mu_fg@example.invalid' from proxima_auth.users where id = v_id);
    execute v_check into v_same, v_keys, v_guard;
    if not (ok and v_same and v_keys = '' and v_guard = 'on') then v_bad := v_bad || format('setacc %s %s [%s] %s, ', ok, v_same, v_keys, v_guard); end if;
    out := out || case when v_bad = '' then 'ok check-same-after-new-code (lockout, unlock, pwchange, rename, setacc); '
                       else format('FAIL check-same-after-new-code %s; ', left(v_bad, 300)) end;
  exception when others then reset role; out := out || format('FAIL check-same-after-new-code %s %s; ', sqlstate, left(sqlerrm, 60)); end;

  raise exception 'RESULT: %', out;
end $t$;
