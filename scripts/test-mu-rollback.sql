-- Rollback proof for supabase/migrations/20261023100000_mu_p1_accounts.sql (design §7, the M1-only part; the M2/M3 legs
-- and "M1's rollback refuses while M2 is live" belong to the full P1 proof with the RLS session's M2).
-- This ONE file runs six times in ONE sql-tx run (everything rolled back); a temp table carries the phase:
--   T=scripts/test-mu-rollback.sql M1=supabase/migrations/20261023100000_mu_p1_accounts.sql
--   RB=supabase/rollback/20261023100000_mu_p1_accounts.rollback.sql
--   (full run: see the end of this header)
-- step 0 (before M1): capture every body M1 replaces (pg_get_functiondef), its ACL and every app_secrets row.
-- step 1 (after M1 + rollback, nothing changed in between): bodies equal the capture (_verify_session_token equals the
--        capture plus the documented guard line), ACLs equal, no P1 object remains (M1's frozen guard included: the
--        function and both app_secrets triggers), app_secrets byte-identical (values and updated_at), so the frozen rows
--        are exactly what they were before M1.
-- step 2 (after M1 again; its compare-and-swap accepts the guarded verifier): the frozen guard is on (a frozen-row write
--        is refused with 55000); then mutate as the app would, as the owner: a rename, a password change, a new backup
--        code, set_my_account(email, verified, last_verified_at), and 2 wrong passwords. The owner row gets a known
--        cost-4 hash first (inside this rolled-back run).
-- step 3 (after the second rollback, which drops the guard before its copy-back): bodies and ACLs equal again; the
--        changes survived in app_secrets: the restored
--        verify_admin signs in with the new password under the new name; a token issued before the password change is
--        revoked and the token the change returned is valid; the lockout reads 2; email, email_verified and
--        last_verified_at read back as set; the new backup code matches; 'u:' tokens are refused; auto_backups and the
--        signing key are untouched; the rollback held proxima_auth.users in EXCLUSIVE mode (review #1).
-- step 4 (after M1 a third time): M4's drops, as M4 makes them (review round 18 #2): both guard triggers, then
--        proxima_auth.m1_frozen_guard(), then proxima_auth.m1_seed_snapshot; M4's rollback does not recreate them.
--        Then an owner-row change (email, one failed sign-in) for the copy-back to carry.
-- step 5 (after the third rollback, which must run without the guard and the snapshot): bodies and ACLs equal again,
--        no P1 object remains, the untouched rows are untouched, and the owner-row change reached app_secrets.
-- Migration record (review m3crit #1/#3): M1's rollback deletes M1's own supabase_migrations.schema_migrations row
-- (version 20261023100000, name mu_p1_accounts) in its transaction, so a later re-apply through apply-migration.mjs
-- really applies. Steps 2 and 4 insert that record as apply-migration.mjs writes it (sql-tx records nothing); steps 1,
-- 3 and 5 require it gone and every other record still there (counted at step 0).
-- Step 0 also checks every captured body against the pre-M1 md5s recorded when M1 was authored (m1-gen pre.json).
-- No hash, key, code or token is printed.
-- Before M1 was applied:
--   node scripts/tools/sql-tx.mjs $T $M1 $RB $T $M1 $T $RB $T $M1 $T $RB --test $T
-- With M1 + M2 live (from 2026-10-23; M3 not live): M2's rollback, then M1's, restore the pre-M1 state before step 0
-- (and the first M1 rollback deletes the live M1 record, which step 1 then finds gone). The verifier the rollback
-- restores carries its one guard line, so step 0 strips that line once from its capture before the pre-M1 md5 check;
-- steps 1, 3 and 5 still compare against capture + exactly one guard line.
--   RB2=supabase/rollback/20261023200000_mu_p1_scope_topic.rollback.sql
--   node scripts/tools/sql-tx.mjs $RB2 $RB $T $M1 $RB $T $M1 $T $RB $T $M1 $T $RB --test $T
do $t$
declare
  fns constant text[] := array['public._verify_session_token(text)', 'public.verify_admin(text,text)',
    'public.unlock_admin_with_backup_code(text,text)', 'public.change_my_password(text,text,text)',
    'public.rename_my_account(text,text,text)', 'public.set_admin_backup_code(text,text,text)',
    'public.set_admin_credentials_rehash(text,text)', 'public.get_my_account(text)',
    'public.set_my_account(text,text,boolean,bigint)', 'public.get_my_wavespeed_key(text)',
    'public.set_my_wavespeed_key(text,text)', 'public.get_auto_backups(text)', 'public.set_auto_backups(text,boolean)',
    'public._rows_keep_owner()', 'public.clear_queued_rows(text,text,bigint,text[])',
    'public.delete_queued_rows(text,text,text[],bigint)', 'public.generations_live(text,text[])',
    'public.paths_in_use(text,text[])', 'public.reset_queued_rows(text,bigint,text[],text[],bigint)',
    'public.upsert_queued_history(text,jsonb,bigint)', 'public.server_time_ms(text)',
    'public.list_my_backups_phase2(text,integer)', 'public.delete_my_backup_phase2(text,uuid)',
    'public.purge_my_backups_of(text,text[],text[])', 'public.restore_my_backup_phase2(text,uuid)',
    'public.snapshot_my_data_phase2(text,text,text)'];
  new_fns constant text[] := array['proxima_auth.current_account(text)', 'proxima_auth.issue_session(uuid)',
    'proxima_auth.mint_token(uuid)', 'proxima_auth._revoke_sessions(uuid)', 'proxima_auth._reauth(uuid,text)',
    'proxima_auth._throttle(text,boolean)', 'public.unlock_with_backup_code(text,text,text)'];
  anchor constant text := '  if not v_ok then raise exception ''invalid signature''; end if;' || chr(10);
  guard constant text := '  if v_subject like ''u:%'' then raise exception ''session token revoked''; end if;   -- P1 rollback: u: holders sign in again' || chr(10);
  po constant text := 'mu-rb-owner-pass-01'; po2 constant text := 'mu-rb-owner-pass-02';
  ko constant text := 'mu-rb-owner-code-000001'; nm constant text := '__mu_rb_owner';
  pre_md5 constant jsonb := '{
    "public._verify_session_token(text)": "e5279a955d40ad5e83f616b9a715751d",
    "public.verify_admin(text,text)": "0ea5e49fdd8440021b862e2da76fbd90",
    "public.unlock_admin_with_backup_code(text,text)": "a6b33ca4e27c159ef0aec43d12809fc5",
    "public.change_my_password(text,text,text)": "7c6bd6b17d859c13357c9950c8bcc6bf",
    "public.rename_my_account(text,text,text)": "df83b48dc188d008b12e5a2e5cda81c3",
    "public.set_admin_backup_code(text,text,text)": "5c42c965870e83e61751b1ecea849af2",
    "public.set_admin_credentials_rehash(text,text)": "501e7685d07b71bba360926f5864b9c4",
    "public.get_my_account(text)": "dc00344c10838600ebee66106faf712a",
    "public.set_my_account(text,text,boolean,bigint)": "eb62f0446fb21f97b88bbfe250bdcfb3",
    "public.get_my_wavespeed_key(text)": "afcb2ee65397fa0159d7717208763771",
    "public.set_my_wavespeed_key(text,text)": "c0f8c0e5ca8a82095c038a3bc101cb63",
    "public.get_auto_backups(text)": "df3ed54f683bcb444e1efc1ae1a70aa7",
    "public.set_auto_backups(text,boolean)": "6dcd3e1b5b770de671fc58e680154a86",
    "public._rows_keep_owner()": "bcac6e054cc7c5f4bede6c55ec7c4b6f",
    "public.clear_queued_rows(text,text,bigint,text[])": "1048b01fb8c46633043506b5c742faba",
    "public.delete_queued_rows(text,text,text[],bigint)": "6055ffdde8572b6d7a51f951bda1ee0d",
    "public.generations_live(text,text[])": "867288f2fa843c3b609a3c116f491790",
    "public.paths_in_use(text,text[])": "113a9a0cfde369f2133f009bedb65719",
    "public.reset_queued_rows(text,bigint,text[],text[],bigint)": "28477808ca92d36e8ee1b21929c47152",
    "public.upsert_queued_history(text,jsonb,bigint)": "d71124ec3a60dda4b6267cbd8af9d989",
    "public.server_time_ms(text)": "0833546769db65af467e5807045a9289",
    "public.list_my_backups_phase2(text,integer)": "e78a4d245728f0fac1eb91339a0d4a2a",
    "public.delete_my_backup_phase2(text,uuid)": "5b663629c5a574c58351273d2ba445fa",
    "public.purge_my_backups_of(text,text[],text[])": "5cd2680f21b2c92c2d9196192b19426e",
    "public.restore_my_backup_phase2(text,uuid)": "303cd3180bc59e113a33f79c6b02d4d2",
    "public.snapshot_my_data_phase2(text,text,text)": "cb00c6db451a0499fb2d4f82343ec474"
  }';
  m1_ver constant text := '20261023100000'; m1_name constant text := 'mu_p1_accounts';
  v_step int; out text := ''; v_bad text; n int; n2 int; r json; t0 text; t1 text; t_before text; t2 text; v_id uuid; ok boolean;
begin
  if to_regclass('pg_temp.mu_rb_state') is null then
    -- step 0: the capture, before M1.
    create temp table mu_rb_state (step int, acc text, tok_before text, tok_after text, users_oid oid, rec_others int) on commit drop;
    create temp table mu_rb_fn (sig text primary key, def text, acl text) on commit drop;
    create temp table mu_rb_sec (key text primary key, value jsonb, updated_at timestamptz) on commit drop;
    insert into mu_rb_fn
      select x, pg_get_functiondef(to_regprocedure(x)),
             (select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a)
        from unnest(fns) x join pg_proc p on p.oid = to_regprocedure(x);
    get diagnostics n = row_count;
    -- Live form (M1 rolled back just before this step): the restored verifier carries the rollback's guard line once.
    update mu_rb_fn set def = replace(def, anchor || guard, anchor)
     where sig = 'public._verify_session_token(text)' and position(anchor || guard in def) > 0;
    get diagnostics n2 = row_count;
    -- Every captured body is the pre-M1 text recorded when M1 was authored.
    select string_agg(f.sig, ',') into v_bad from mu_rb_fn f where md5(f.def) is distinct from pre_md5->>f.sig;
    insert into mu_rb_sec select s.key, s.value, s.updated_at from public.app_secrets s;
    insert into mu_rb_state values (1, case when n = cardinality(fns) then 'ok capture; ' else format('FAIL capture %s of %s; ', n, cardinality(fns)) end
      || case when v_bad is null and (select count(*) from mu_rb_fn) = (select count(*) from jsonb_object_keys(pre_md5))
              then format('ok capture-is-pre-m1 (guard line stripped: %s); ', n2 = 1)
              else format('FAIL capture-is-pre-m1 %s; ', left(v_bad, 120)) end
      || case when not exists (select 1 from supabase_migrations.schema_migrations where version = m1_ver)
              then 'ok own-record-absent-0; ' else 'FAIL own-record-absent-0; ' end,
      null, null, null, (select count(*) from supabase_migrations.schema_migrations where version <> m1_ver));
    return;
  end if;

  select s.step, s.acc into v_step, out from mu_rb_state s;

  if v_step in (1, 3, 5) then
    -- Bodies and ACLs equal the capture; the verifier equals capture + the one guard line.
    select string_agg(f.sig, ',') into v_bad from mu_rb_fn f
      left join pg_proc p on p.oid = to_regprocedure(f.sig)
     where p.oid is null
        or pg_get_functiondef(p.oid) is distinct from
           case when f.sig = 'public._verify_session_token(text)' then replace(f.def, anchor, anchor || guard) else f.def end
        or (select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a) is distinct from f.acl;
    out := out || case when v_bad is null and (select count(*) from mu_rb_fn where sig = 'public._verify_session_token(text)'
                                                and position(anchor in def) > 0) = 1
      then format('ok bodies-acl-restored-%s; ', v_step) else format('FAIL bodies-acl-restored-%s %s; ', v_step, left(v_bad, 120)) end;
    -- No P1 object remains.
    select count(*) into n from unnest(new_fns) x where to_regprocedure(x) is not null;
    out := out || case when n = 0 and to_regclass('proxima_auth.users') is null and to_regclass('proxima_auth.auth_config') is null
                         and to_regclass('proxima_auth.signin_throttle') is null and to_regtype('proxima_auth.account') is null
                         and to_regclass('proxima_auth.m1_seed_snapshot') is null
                         and to_regprocedure('proxima_auth.m1_frozen_guard()') is null
                         and not exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.app_secrets'::regclass
                                            and tg.tgname in ('app_secrets_m1_frozen', 'app_secrets_m1_frozen_truncate'))
      then format('ok no-p1-object-%s; ', v_step) else format('FAIL no-p1-object-%s funcs=%s; ', v_step, n) end;
    -- The rows P1 never owns are untouched.
    select count(*) into n from mu_rb_sec c join public.app_secrets s using (key)
     where c.key in ('auto_backups', 'session_signing_key') and s.value = c.value and s.updated_at = c.updated_at;
    out := out || case when n = 2 then format('ok untouched-rows-%s; ', v_step) else format('FAIL untouched-rows-%s %s; ', v_step, n) end;
    -- The rollback deleted M1's own migration record and no other.
    out := out || case when not exists (select 1 from supabase_migrations.schema_migrations where version = m1_ver)
                         and (select count(*) from supabase_migrations.schema_migrations where version <> m1_ver)
                             = (select rec_others from mu_rb_state)
      then format('ok own-record-deleted-%s; ', v_step) else format('FAIL own-record-deleted-%s; ', v_step) end;
  end if;

  if v_step in (2, 4) then
    -- M1 is live again: its record as apply-migration.mjs writes it (buildApplyScript: version, name, statements).
    insert into supabase_migrations.schema_migrations (version, name, statements)
      values (m1_ver, m1_name, array['-- test-mu-rollback stand-in for the M1 text'])
      on conflict (version) do nothing;   -- a record the previous rollback left is already reported as FAIL
  end if;

  if v_step = 1 then
    -- Nothing changed between M1 and its rollback: app_secrets is byte-identical (no copy-back write at all).
    select count(*) into n from (
      (select key, value, updated_at from mu_rb_sec except select key, value, updated_at from public.app_secrets)
      union all
      (select key, value, updated_at from public.app_secrets except select key, value, updated_at from mu_rb_sec)) d;
    out := out || case when n = 0 then 'ok app-secrets-identical; ' else format('FAIL app-secrets-identical %s rows differ; ', n) end;
    update mu_rb_state set step = 2, acc = out;
    return;
  end if;

  if v_step = 2 then
    -- M1 is live again (its compare-and-swap accepted the guarded verifier). Its frozen guard refuses a frozen-row write
    -- (so the copy-back in the next rollback only works because that rollback drops the guard first).
    begin
      update public.app_secrets set updated_at = updated_at where key = 'admin_username';
      out := out || 'FAIL frozen-guard-on-in-p1 (write went through); ';
    exception when sqlstate '55000' then out := out || 'ok frozen-guard-on-in-p1; ';
              when others then out := out || format('FAIL frozen-guard-on-in-p1 %s; ', sqlstate);
    end;
    -- Mutate as the owner would.
    begin
      perform set_config('request.headers', '{}', true);
      select id into v_id from proxima_auth.users where role = 'owner';
      update proxima_auth.users set password_hash = extensions.crypt(po, extensions.gen_salt('bf', 4)),
             login_failed = 0, login_locked_at = null where id = v_id;
      t0 := proxima_auth.mint_token(v_id);
      set local role anon;
      r := rename_my_account(t0, po, nm);
      reset role;
      t1 := r->>'token';
      ok := (r->>'ok')::boolean;
      t_before := proxima_auth.mint_token(v_id);                     -- issued before the password change
      set local role anon;
      r := change_my_password(t1, po, po2);
      t2 := r->>'token';
      ok := ok and (r->>'ok')::boolean;
      r := set_admin_backup_code(t2, po2, ko);
      ok := ok and (r->>'ok')::boolean;
      r := set_my_account(t2, '__mu_rb@example.invalid', true, 1234567890123);
      ok := ok and (r->>'ok')::boolean;
      r := verify_admin(nm, 'wrong-password-1');
      r := verify_admin(nm, 'wrong-password-2');
      reset role;
      ok := ok and (select login_failed = 2 from proxima_auth.users where id = v_id);
      out := out || case when ok then 'ok mutate; ' else 'FAIL mutate; ' end;
    exception when others then reset role; out := out || format('FAIL mutate %s; ', left(sqlerrm, 60)); end;
    update mu_rb_state set step = 3, acc = out, tok_before = t_before, tok_after = t2,
           users_oid = to_regclass('proxima_auth.users')::oid;
    return;
  end if;

  if v_step = 4 then
    -- M1 is live a third time. M4's drops (triggers before the function, then the snapshot); M4's rollback does not
    -- recreate them, so M1's rollback must run without them (review round 18 #2).
    begin
      drop trigger app_secrets_m1_frozen on public.app_secrets;
      drop trigger app_secrets_m1_frozen_truncate on public.app_secrets;
      drop function proxima_auth.m1_frozen_guard();
      drop table proxima_auth.m1_seed_snapshot;
      update proxima_auth.users set email = '__mu_rb4@example.invalid', login_failed = 1, login_locked_at = null
       where role = 'owner';
      get diagnostics n = row_count;
      out := out || case when n = 1 and to_regprocedure('proxima_auth.m1_frozen_guard()') is null
                           and to_regclass('proxima_auth.m1_seed_snapshot') is null
        then 'ok m4-drops-guard-and-snapshot; ' else 'FAIL m4-drops-guard-and-snapshot; ' end;
    exception when others then out := out || format('FAIL m4-drops-guard-and-snapshot %s; ', left(sqlerrm, 60)); end;
    update mu_rb_state set step = 5, acc = out;
    return;
  end if;

  if v_step = 5 then
    -- The rollback ran without the guard and the snapshot, and still copied the owner row back.
    out := out || case when (select value->>'email' from public.app_secrets where key = 'admin_email') = '__mu_rb4@example.invalid'
                         and (select (value->>'failed')::int = 1 and not coalesce((value->>'locked')::boolean, false)
                                from public.app_secrets where key = 'admin_login_lockout')
      then 'ok rollback-after-m4-copied-back; ' else 'FAIL rollback-after-m4-copied-back; ' end;
    raise exception 'RESULT: %', out;
  end if;

  -- step 3: after the second rollback, the in-P1 changes survived in app_secrets and the restored code uses them.
  select s.tok_before, s.tok_after into t_before, t2 from mu_rb_state s;
  -- Review #1: the rollback held proxima_auth.users in EXCLUSIVE mode (new-code writers blocked) before its copy-back.
  -- Nothing else in M1, this file or the rollback takes that mode, and the dropped table's locks stay until the end.
  out := out || case when exists (select 1 from pg_locks l, mu_rb_state s
                                   where l.locktype = 'relation' and l.relation = s.users_oid and l.mode = 'ExclusiveLock'
                                     and l.pid = pg_backend_pid() and l.granted)
    then 'ok rollback-locks-users; ' else 'FAIL rollback-locks-users; ' end;
  begin
    out := out || case when (select value->>'username' from public.app_secrets where key = 'admin_username') = nm
      then 'ok name-copied; ' else 'FAIL name-copied; ' end;
    out := out || case when (select (value->>'failed')::int = 2 and not coalesce((value->>'locked')::boolean, false)
                               from public.app_secrets where key = 'admin_login_lockout')
      then 'ok lockout-reads-2; ' else 'FAIL lockout-reads-2; ' end;
    out := out || case when (select value->>'hash' = extensions.crypt(ko, value->>'hash') from public.app_secrets where key = 'admin_backup_code_hash')
      then 'ok code-copied; ' else 'FAIL code-copied; ' end;
    set local role anon;
    r := get_my_account(t2);                                          -- the token the password change returned
    reset role;
    out := out || case when (r->>'ok')::boolean and r->>'username' = nm and r->>'email' = '__mu_rb@example.invalid'
                         and (r->>'email_verified')::boolean and (r->>'last_verified_at')::bigint = 1234567890123
      then 'ok change-token-valid-email-copied; ' else format('FAIL change-token-valid-email-copied %s; ', left(coalesce(r->>'reason', 'ok'), 30)) end;
    begin perform get_my_account(t_before); out := out || 'FAIL token-before-change-revoked; ';
    exception when others then out := out || case when sqlerrm ~ 'revoked' then 'ok token-before-change-revoked; '
                                                  else format('FAIL token-before-change-revoked %s; ', left(sqlerrm, 40)) end; end;
    begin perform _verify_session_token(_sign_session_token('u:' || gen_random_uuid()::text, now() + interval '1 hour'));
          out := out || 'FAIL u-token-refused; ';
    exception when others then out := out || case when sqlerrm ~ 'revoked' then 'ok u-token-refused; '
                                                  else format('FAIL u-token-refused %s; ', left(sqlerrm, 40)) end; end;
    set local role anon;
    r := verify_admin(nm, po2);                                       -- last: a right password resets the lockout
    reset role;
    -- (The restored verify_admin mints with now(), the start of this one transaction, which is before the epoch the
    -- in-P1 bumps set, so its token cannot be used inside this run; outside it, now() is the call's own time.)
    out := out || case when (r->>'ok')::boolean and r->>'username' = nm and left(r->>'token', length(nm) + 7) = 'admin:' || nm || '.'
                         and (select (value->>'failed')::int = 0 from public.app_secrets where key = 'admin_login_lockout')
      then 'ok signin-new-password-new-name; ' else format('FAIL signin-new-password-new-name %s; ', left(coalesce(r->>'reason', 'ok'), 30)) end;
  exception when others then reset role; out := out || format('FAIL after-rollback %s; ', left(sqlerrm, 60)); end;
  update mu_rb_state set step = 4, acc = out;
end $t$;
