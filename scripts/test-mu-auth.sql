-- Multi-user P1 auth suite (docs/P1-AUTH-DESIGN.md §9.1): member accounts seeded INSIDE this block in
-- proxima_auth.users, tokens minted with proxima_auth.mint_token, every RPC called as the app calls it (anon + token;
-- get_my_wavespeed_key as service_role, like api/ws-proxy.ts).
-- Same harness as test-queued-deletes-db.sql: one DO block that always ends in raise exception 'RESULT: ...', so
-- everything rolls back (fixtures, lockout counters, epochs, throttle rows, the auth_config switch, the owner flows).
--   before P1:  node scripts/tools/sql-tx.mjs --test scripts/test-mu-auth.sql            (must FAIL: no users table)
--   with P1:    node scripts/tools/sql-tx.mjs <M1> [<M2 RLS>] [<M3>] --test scripts/test-mu-auth.sql
--   after P1:   node scripts/tools/sql-tx.mjs --test scripts/test-mu-auth.sql
-- Expected result per stage: design §9.1 (M1 alone: only scope-header-A and owner-u-session-scope fail, both because
-- session_scope refuses u: tokens until M2; M1+M2 onward: all ok, owner-u-session-scope not printed). The owner flows
-- (cases 20b, 21) expect the stage's token: 'admin:<owner name>' before M3, 'u:<owner id>' from M3
-- (supabase/migrations/20261023300000_mu_p1_mint_u_tokens.sql), detected by issue_session's body. 2026-10-23, live
-- M1+M2: `sql-tx --test` 42 ok / 0 FAIL (owner flows admin:); `sql-tx <M3> --test` 42 ok / 0 FAIL (owner flows u:).
-- M4 stage (supabase/migrations/20261023400000_mu_p1_end_dual_accept.sql, detected by set_admin_credentials_rehash
-- being gone; m4-stage-consistent fails a partial M4): every 'admin:' token answers 'session token revoked' (case 14,
-- 20b); u: tokens, sign-in, both unlocks, password change and rename unchanged. Before 2026-10-23 21:06:07 UTC M4's
-- clock check refuses, so run its no-clock scratch copy (the sed line in M4's header). 2026-10-23, live M1+M2+M3:
-- `sql-tx --test` 43 ok / 0 FAIL; `sql-tx <M4 no-clock> --test` 43 ok / 0 FAIL; with only the rehash drop prepended
-- (a partial M4): 40 ok / 3 FAIL (m4-stage-consistent, dual-accept-admin, admin-still-verifies).
-- Fixtures: usernames '__mu_a', '__mu_b', '__mu_c', '__mu_d' (disabled), '__mu_e' (cost-12 hashes, case 7b only); ids
-- 00000000-0000-4000-8000-0000000000a1/b1/c1/d1/e1; task ids 'mu-*'; documentation IPs 192.0.2.x / 198.51.100.x / 203.0.113.x / 2001:db8::/32, one per case so no
-- case trips another's throttle. The owner row is touched only inside this rolled-back block (case 14 moves its epoch
-- and restores it; case 21 gives it a known cost-4 hash and code). No real hash, key, code or token is selected or
-- printed; failure details are cut so the result line stays under sb-query's 2000-char cut.
do $t$
declare
  out text := '';
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  c uuid := '00000000-0000-4000-8000-0000000000c1';
  d uuid := '00000000-0000-4000-8000-0000000000d1';
  sa text := 'user:__mu_a'; sb text := 'user:__mu_b'; sc text := 'user:__mu_c'; sd text := 'user:__mu_d';
  pa text := 'mu-pass-A-0001'; pb text := 'mu-pass-B-0002'; pc text := 'mu-pass-C-0003'; pd text := 'mu-pass-D-0004';
  pa2 text := 'mu-pass-A-0011'; pa3 text := 'mu-pass-A-0111';
  ka text := 'mu-backup-code-A-000001'; kb text := 'mu-backup-code-B-000002'; kd text := 'mu-backup-code-D-000004';
  po text := 'mu-owner-pass-0001'; po2 text := 'mu-owner-pass-0002'; po3 text := 'mu-owner-pass-0003';
  ko text := 'mu-owner-code-000001';
  ta text; tb text; tc text; ta_old text; t text; t2 text; t3 text; v_owner text; v_owner_id uuid; v_own_snap text;
  r json; r2 json; r3 json; r4 json; v_bk uuid; v_ep bigint; v_ep2 bigint; n int; n2 int; s text; v_md5 text;
  ok boolean; v_m4 boolean; v_m3 boolean; v_pfx text; v_otok text;
  ip_t constant text := '{"x-forwarded-for":"203.0.113.7","cf-connecting-ip":"203.0.113.7"}';
  ip_u constant text := '{"x-forwarded-for":"198.51.100.9","cf-connecting-ip":"198.51.100.9"}';
  ip_v constant text := '{"x-forwarded-for":"192.0.2.44","cf-connecting-ip":"192.0.2.44"}';
  ip_w constant text := '{"x-forwarded-for":"192.0.2.45","cf-connecting-ip":"192.0.2.45"}';
  ip_x constant text := '{"x-forwarded-for":"192.0.2.46","cf-connecting-ip":"192.0.2.46"}';
  ip_y constant text := '{"x-forwarded-for":"192.0.2.47","cf-connecting-ip":"192.0.2.47"}';
  ip_g constant text := '{"x-forwarded-for":"192.0.2.48","cf-connecting-ip":"192.0.2.48"}';
  ip_z constant text := '{"x-forwarded-for":"192.0.2.50","cf-connecting-ip":"192.0.2.50"}';
  ip_z2 constant text := '{"x-forwarded-for":"192.0.2.51","cf-connecting-ip":"192.0.2.51"}';
  ip_bad constant text := '{"x-forwarded-for":"not-an-ip","cf-connecting-ip":"not-an-ip"}';
  ip6_1 constant text := '{"cf-connecting-ip":"2001:db8:0:0::1"}';
  ip6_2 constant text := '{"cf-connecting-ip":"2001:db8:0:0::2"}';
  ip6_3 constant text := '{"cf-connecting-ip":"2001:db8:0:0::3"}';
  ip6_4 constant text := '{"cf-connecting-ip":"2001:db8:0:0::4"}';
  ip6_o constant text := '{"cf-connecting-ip":"2001:db8:0:1::1"}';
begin
  -- 0. Seed four member accounts (D disabled; C has no backup code) and their rows (as postgres, like every suite), and
  --    snapshot the real owner row. A missing table fails here and in every case below: the expected result before P1.
  begin
    insert into proxima_auth.users (id, username, role, scope, password_hash, backup_code_hash, sessions_valid_after, disabled_at)
    values (a, '__mu_a', 'member', sa, extensions.crypt(pa, extensions.gen_salt('bf', 4)), extensions.crypt(ka, extensions.gen_salt('bf', 4)), 0, null),
           (b, '__mu_b', 'member', sb, extensions.crypt(pb, extensions.gen_salt('bf', 4)), extensions.crypt(kb, extensions.gen_salt('bf', 4)), 0, null),
           (c, '__mu_c', 'member', sc, extensions.crypt(pc, extensions.gen_salt('bf', 4)), null, 0, null),
           (d, '__mu_d', 'member', sd, extensions.crypt(pd, extensions.gen_salt('bf', 4)), extensions.crypt(kd, extensions.gen_salt('bf', 4)), 0, now());
    insert into tasks (id, device_id, status, start_time, outputs) values
      ('mu-a-1', sa, 'completed', 1000, '[]'), ('mu-b-1', sb, 'completed', 1000, '[]'), ('mu-b-2', sb, 'completed', 1000, '[]');
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot, settings_snapshot)
      values (sb, 'manual', 1, 0, '[{"id":"mu-b-1"}]', '[]', '{}') returning id into v_bk;
    insert into user_secrets (device_id, key, value) values (sb, 'wavespeed_api_key', jsonb_build_object('value', 'mu-test-key-B-0002'));
    update proxima_auth.auth_config set signin_throttle = 'on', throttle_max_failures = 10, throttle_window = interval '15 minutes',
                                        throttle_guard_names = 50;
    select x.id, x.username, md5(row(x.login_failed, x.login_locked_at, x.backup_failed, x.backup_locked_until, x.sessions_valid_after)::text)
      into v_owner_id, v_owner, v_own_snap from proxima_auth.users x where x.role = 'owner';
    ta := proxima_auth.mint_token(a); tb := proxima_auth.mint_token(b); tc := proxima_auth.mint_token(c);
    out := out || case when v_owner_id is not null and v_own_snap is not null then 'ok seed; ' else 'FAIL seed no-owner; ' end;
  exception when others then out := out || format('FAIL seed %s; ', left(sqlerrm, 60)); end;

  -- 0b. Equal locking for every typed name (review #5, the lock-contention timing oracle): verify_admin and
  --     unlock_with_backup_code take the transaction advisory lock hashtextextended('proxima-signin:'||lower(name), 0)
  --     before the account lookup, for an unknown name exactly as for an existing one. None of the four keys is held
  --     before (no earlier case typed these names); each is held by this backend after. Review #9: the IP throttle row
  --     is created and locked by the check at the start of the attempt, so a first-ever right password from a new key
  --     leaves the row in place (IP row -> advisory lock -> account row). The probes' counts on A and B are undone.
  begin
    perform set_config('request.headers', ip_z, true);
    select count(*) into n from unnest(array['__mu_adv_nobody', '__mu_a', '__mu_adv_nobody2', '__mu_b']) x, pg_locks l
     where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1
       and l.classid::bigint = (hashtextextended('proxima-signin:' || lower(x), 0) >> 32) & 4294967295
       and l.objid::bigint = hashtextextended('proxima-signin:' || lower(x), 0) & 4294967295;
    set local role anon;
    r := verify_admin('__mu_adv_nobody', 'whatever-123');
    r2 := verify_admin('__MU_A', 'wrong-password-adv');
    r3 := unlock_with_backup_code('__mu_adv_nobody2', 'whatever-code-000000', null);
    r4 := unlock_with_backup_code('__mu_b', 'not-the-code-adv-0000', null);
    reset role;
    update proxima_auth.users set login_failed = 0 where id = a;
    update proxima_auth.users set backup_failed = 0 where id = b;
    select count(*) into n2 from unnest(array['__mu_adv_nobody', '__mu_a', '__mu_adv_nobody2', '__mu_b']) x
     where exists (select 1 from pg_locks l
                    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1 and l.granted
                      and l.classid::bigint = (hashtextextended('proxima-signin:' || lower(x), 0) >> 32) & 4294967295
                      and l.objid::bigint = hashtextextended('proxima-signin:' || lower(x), 0) & 4294967295);
    out := out || case when n = 0 and n2 = 4 and r->>'reason' = 'invalid' and r2->>'reason' = 'invalid'
                         and r3->>'reason' = 'invalid' and r4->>'reason' = 'invalid'
      then 'ok signin-lock-every-name; ' else format('FAIL signin-lock-every-name before=%s after=%s; ', n, n2) end;
    perform set_config('request.headers', ip_z2, true);
    s := encode(extensions.hmac('192.0.2.51', (select throttle_key from proxima_auth.auth_config), 'sha256'), 'hex');
    n := (select count(*) from proxima_auth.signin_throttle where ip_key = s);
    set local role anon;
    r := verify_admin('__mu_b', pb);
    reset role;
    out := out || case when n = 0 and (r->>'ok')::boolean
                         and exists (select 1 from proxima_auth.signin_throttle where ip_key = s and failures = 0)
      then 'ok throttle-row-first; ' else format('FAIL throttle-row-first before=%s %s; ', n, coalesce(r->>'reason', 'ok')) end;
  exception when others then reset role; out := out || format('FAIL signin-lock-every-name %s; ', left(sqlerrm, 60)); end;

  -- 1. get_my_account returns the account's id, role and scope (and still the fields the Account screen reads). In P1
  --    the one sync topic is the owner's: a member gets sync_topic = null, the owner gets the topic.
  begin
    t := proxima_auth.mint_token(v_owner_id);
    set local role anon;
    r := get_my_account(ta);
    r2 := get_my_account(t);
    reset role;
    out := out || case when (r->>'ok')::boolean and (r->>'id')::uuid = a and r->>'role' = 'member' and r->>'scope' = sa
                         and r->>'username' = '__mu_a' and r::jsonb ?& array['has_backup_code', 'password_is_bcrypt', 'sync_topic']
      then 'ok account-shape; ' else format('FAIL account-shape %s; ', left(r::text, 60)) end;
    out := out || case when (r::jsonb -> 'sync_topic') = 'null'::jsonb and r2->>'sync_topic' is not null and r2->>'role' = 'owner'
      then 'ok topic-owner-only; ' else 'FAIL topic-owner-only; ' end;
  exception when others then reset role; out := out || format('FAIL account-shape %s; ', left(sqlerrm, 60)); end;

  -- 2. The global auto-backups switch is the owner's until P4: a member's get and set are refused with 42501.
  begin
    t := proxima_auth.mint_token(v_owner_id);
    n := 0;
    set local role anon;
    begin perform get_auto_backups(ta); exception when insufficient_privilege then n := n + 1; end;
    begin perform set_auto_backups(ta, false); exception when insufficient_privilege then n := n + 1; end;
    perform get_auto_backups(t);
    reset role;
    out := out || case when n = 2 then 'ok auto-backups-owner-only; ' else format('FAIL auto-backups-owner-only refused=%s; ', n) end;
  exception when others then reset role; out := out || format('FAIL auto-backups-owner-only %s; ', left(sqlerrm, 60)); end;

  -- 3. B signs in: a u:<uuid> token, B's own spelling of the name; the token resolves to B's scope.
  begin
    perform set_config('request.headers', ip_u, true);
    set local role anon;
    r := verify_admin('__mu_b', pb);
    reset role;
    select x.scope into s from proxima_auth.current_account(r->>'token') x;
    out := out || case when (r->>'ok')::boolean and r->>'token' like 'u:' || b || '.%' and r->>'username' = '__mu_b' and s = sb
      then 'ok signin-B; ' else format('FAIL signin-B %s; ', left(coalesce(r->>'reason', s, 'null'), 60)) end;
  exception when others then reset role; out := out || format('FAIL signin-B %s; ', left(sqlerrm, 60)); end;

  -- 4. One generic error: an unknown name, a wrong password and a disabled account's RIGHT password answer the same
  --    bytes; the disabled row is never changed.
  begin
    perform set_config('request.headers', ip_v, true);
    set local role anon;
    r := verify_admin('__mu_nobody', 'whatever-123');
    r2 := verify_admin('__mu_b', 'wrong-password-1');
    r3 := verify_admin('__mu_d', pd);
    reset role;
    update proxima_auth.users set login_failed = 0 where id = b;                       -- undo the probe's count on B
    ok := (select login_failed = 0 and login_locked_at is null and sessions_valid_after = 0 from proxima_auth.users where id = d);
    out := out || case when r::jsonb = r2::jsonb and r::jsonb = r3::jsonb and r->>'reason' = 'invalid'
                         and not (r::jsonb ? 'attempts_left') and ok
      then 'ok generic-error; ' else format('FAIL generic-error %s|%s|%s; ', left(r::text, 20), left(r2::text, 20), left(r3::text, 20)) end;
  exception when others then reset role; out := out || format('FAIL generic-error %s; ', left(sqlerrm, 60)); end;

  -- 5. A's 3 wrong passwords lock only A. While locked, A's right and a wrong password give the same bytes ('invalid':
  --    the lock never confirms a guess); B still signs in; B's counter is 0.
  begin
    perform set_config('request.headers', ip_u, true);
    set local role anon;
    for i in 1..3 loop r := verify_admin('__mu_a', 'wrong-password-' || i); end loop;
    r := verify_admin('__mu_a', pa);
    r3 := verify_admin('__mu_a', 'wrong-password-9');
    r2 := verify_admin('__mu_b', pb);
    reset role;
    select login_failed into n from proxima_auth.users where id = b;
    ok := (select login_locked_at is not null from proxima_auth.users where id = a);
    out := out || case when (r2->>'ok')::boolean and n = 0 and ok and r->>'token' is null
      then 'ok lock-A-only; ' else format('FAIL lock-A-only A=%s B=%s nB=%s; ', r->>'reason', coalesce(r2->>'reason', 'ok'), n) end;
    out := out || case when r::jsonb = r3::jsonb and r->>'reason' = 'invalid'
      then 'ok locked-generic; ' else format('FAIL locked-generic %s|%s; ', left(r::text, 28), left(r3::text, 28)) end;
  exception when others then reset role; out := out || format('FAIL lock-A-only %s; ', left(sqlerrm, 60)); end;

  -- 6. A's backup code unlocks only A (and resets A's password); a wrong code counts on A only; only A's epoch moves.
  begin
    select sessions_valid_after into v_ep from proxima_auth.users where id = b;
    perform set_config('request.headers', ip_u, true);
    set local role anon;
    r := unlock_with_backup_code('__mu_a', 'not-the-code-000000', null);
    r2 := unlock_with_backup_code('__mu_a', ka, pa2);
    reset role;
    select backup_failed into n from proxima_auth.users where id = b;
    select sessions_valid_after into v_ep2 from proxima_auth.users where id = b;
    ok := (select login_locked_at is null and login_failed = 0 and sessions_valid_after > 0 from proxima_auth.users where id = a);
    out := out || case when r->>'reason' = 'invalid' and (r2->>'ok')::boolean and n = 0 and v_ep2 = v_ep and ok
      then 'ok unlock-A-only; ' else format('FAIL unlock-A-only %s %s nB=%s; ', r->>'reason', coalesce(r2->>'reason', 'ok'), n) end;
    begin perform get_my_account(ta); out := out || 'FAIL unlock-revokes-A; ';
    exception when others then out := out || case when sqlerrm ~ 'revoked' then 'ok unlock-revokes-A; ' else format('FAIL unlock-revokes-A %s; ', left(sqlerrm, 40)) end; end;
    r := get_my_account(tb);
    out := out || case when (r->>'ok')::boolean then 'ok unlock-keeps-B; ' else 'FAIL unlock-keeps-B; ' end;
  exception when others then reset role; out := out || format('FAIL unlock-A-only %s; ', left(sqlerrm, 60)); end;

  -- 7. Unlock answers one generic error with one bcrypt each: an unknown name, an account with no code (C), a wrong code
  --    (B) and a disabled account's RIGHT code (D) answer the same bytes; D's row is never changed.
  begin
    perform set_config('request.headers', ip_v, true);
    set local role anon;
    r := unlock_with_backup_code('__mu_nobody', 'whatever-code-000000', null);
    r2 := unlock_with_backup_code('__mu_c', 'whatever-code-000000', null);
    r3 := unlock_with_backup_code('__mu_b', 'not-the-code-B-00000', null);
    r4 := unlock_with_backup_code('__mu_d', kd, null);
    reset role;
    update proxima_auth.users set backup_failed = 0 where id = b;                      -- undo the probe's count on B
    ok := (select backup_failed = 0 and backup_locked_until is null and sessions_valid_after = 0 from proxima_auth.users where id = d);
    out := out || case when r::jsonb = r2::jsonb and r::jsonb = r3::jsonb and r::jsonb = r4::jsonb and r->>'reason' = 'invalid'
                         and not (r::jsonb ? 'attempts_left') and ok
      then 'ok unlock-generic; ' else format('FAIL unlock-generic %s|%s|%s; ', left(r::text, 18), left(r2::text, 18), left(r4::text, 18)) end;
  exception when others then reset role; out := out || format('FAIL unlock-generic %s; ', left(sqlerrm, 60)); end;

  -- 7b. Exactly one bcrypt per attempt for EVERY input (review round 16 #1, the NULL-secret timing oracle): verify_admin
  --     and unlock_with_backup_code called as anon with a NULL and an empty secret on an existing name, a NULL secret
  --     on an unknown name, and a wrong secret on the existing name answer the same body, and every call takes at least
  --     40% of the wrong-secret call's time (one bcrypt at cost 12 is ~0.29 s; a skipped bcrypt takes a few ms).
  --     Fixture '__mu_e' (id ...e1) has cost-12 hashes like the dummy hash and the live owner hashes; its counts are
  --     undone afterwards.
  declare
    e uuid := '00000000-0000-4000-8000-0000000000e1';
    t0 timestamptz; el numeric[]; bodies jsonb[]; lbl text[] := array['va-null', 'va-empty', 'va-unknown-null', 'va-wrong',
                                                                        'ub-null', 'ub-empty', 'ub-unknown-null', 'ub-wrong'];
    bad text := '';
  begin
    insert into proxima_auth.users (id, username, role, scope, password_hash, backup_code_hash, sessions_valid_after)
    values (e, '__mu_e', 'member', 'user:__mu_e', extensions.crypt('mu-pass-E-0005', extensions.gen_salt('bf', 12)),
            extensions.crypt('mu-backup-code-E-000005', extensions.gen_salt('bf', 12)), 0);
    perform set_config('request.headers', '{"x-forwarded-for":"192.0.2.52","cf-connecting-ip":"192.0.2.52"}', true);
    set local role anon;
    t0 := clock_timestamp(); r := verify_admin('__mu_e', null);                 el[1] := extract(epoch from clock_timestamp() - t0); bodies[1] := r::jsonb;
    t0 := clock_timestamp(); r := verify_admin('__mu_e', '');                   el[2] := extract(epoch from clock_timestamp() - t0); bodies[2] := r::jsonb;
    t0 := clock_timestamp(); r := verify_admin('__mu_e_nobody', null);          el[3] := extract(epoch from clock_timestamp() - t0); bodies[3] := r::jsonb;
    t0 := clock_timestamp(); r := verify_admin('__mu_e', 'wrong-password-E1');  el[4] := extract(epoch from clock_timestamp() - t0); bodies[4] := r::jsonb;
    t0 := clock_timestamp(); r := unlock_with_backup_code('__mu_e', null, null);            el[5] := extract(epoch from clock_timestamp() - t0); bodies[5] := r::jsonb;
    t0 := clock_timestamp(); r := unlock_with_backup_code('__mu_e', '', null);              el[6] := extract(epoch from clock_timestamp() - t0); bodies[6] := r::jsonb;
    t0 := clock_timestamp(); r := unlock_with_backup_code('__mu_e_nobody', null, null);     el[7] := extract(epoch from clock_timestamp() - t0); bodies[7] := r::jsonb;
    t0 := clock_timestamp(); r := unlock_with_backup_code('__mu_e', 'not-the-code-E-0000', null); el[8] := extract(epoch from clock_timestamp() - t0); bodies[8] := r::jsonb;
    reset role;
    for i in 1..8 loop
      if bodies[i] is distinct from bodies[case when i <= 4 then 4 else 8 end] or bodies[i]->>'reason' is distinct from 'invalid' then
        bad := bad || lbl[i] || ':body ';
      end if;
      if el[i] < 0.4 * el[case when i <= 4 then 4 else 8 end] then
        bad := bad || format('%s:%sms ', lbl[i], round(el[i] * 1000));
      end if;
    end loop;
    ok := (select login_failed = 3 and login_locked_at is not null and backup_failed = 3 from proxima_auth.users where id = e);
    update proxima_auth.users set login_failed = 0, login_locked_at = null, backup_failed = 0 where id = e;
    out := out || case when bad = '' and ok
      then format('ok one-bcrypt-every-input (va wrong %sms, ub wrong %sms, min %sms); ', round(el[4] * 1000), round(el[8] * 1000),
                  round((select min(x) from unnest(el) x) * 1000))
      else format('FAIL one-bcrypt-every-input %s counted=%s (va wrong %sms, ub wrong %sms); ', bad, ok, round(el[4] * 1000), round(el[8] * 1000)) end;
  exception when others then reset role; out := out || format('FAIL one-bcrypt-every-input %s; ', left(sqlerrm, 60)); end;

  -- 8.A's password change bumps only A's epoch: A's old token is revoked, A's new one works, B's token stays valid.
  begin
    ta_old := proxima_auth.mint_token(a);
    select sessions_valid_after into v_ep from proxima_auth.users where id = b;
    set local role anon;
    r := change_my_password(ta_old, pa2, pa3);
    reset role;
    ta := r->>'token';
    select sessions_valid_after into v_ep2 from proxima_auth.users where id = b;
    out := out || case when (r->>'ok')::boolean and ta like 'u:' || a || '.%' and v_ep2 = v_ep
                         and (get_my_account(ta)->>'ok')::boolean and (get_my_account(tb)->>'ok')::boolean
      then 'ok pwchange-A-only; ' else format('FAIL pwchange-A-only %s; ', left(coalesce(r->>'reason', 'ok'), 40)) end;
    begin perform get_my_account(ta_old); out := out || 'FAIL pwchange-revokes-old; ';
    exception when others then out := out || case when sqlerrm ~ 'revoked' then 'ok pwchange-revokes-old; ' else format('FAIL pwchange-revokes-old %s; ', left(sqlerrm, 40)) end; end;
  exception when others then reset role; out := out || format('FAIL pwchange-A-only %s; ', left(sqlerrm, 60)); end;

  -- 9. Wrong CURRENT passwords in Settings (the re-auth path, locked-first) lock only C; A and B are untouched.
  begin
    set local role anon;
    for i in 1..3 loop r := change_my_password(tc, 'wrong-current-' || i, 'mu-new-pass-C-1'); end loop;
    reset role;
    ok := (select login_locked_at is not null from proxima_auth.users where id = c)
      and (select bool_and(login_locked_at is null and login_failed = 0) from proxima_auth.users where id in (a, b));
    out := out || case when r->>'reason' = 'locked' and ok then 'ok reauth-lock-C-only; '
                       else format('FAIL reauth-lock-C-only %s; ', r->>'reason') end;
  exception when others then reset role; out := out || format('FAIL reauth-lock-C-only %s; ', left(sqlerrm, 60)); end;

  -- 10. A token of A never reads or writes B's scope through the RPCs, including every former fall-through function.
  begin
    select md5(tasks_snapshot::text) into v_md5 from data_backups where id = v_bk;
    select count(*) into n2 from data_backups where username = sa;
    set local role anon;
    r := delete_queued_rows(ta, 'task', array['mu-b-1'], 9e12::bigint);
    r2 := clear_queued_rows(ta, 'task', (extract(epoch from now()) * 1000)::bigint + 1000, array['mu-b-2']);
    perform delete_my_backup_phase2(ta, v_bk);
    select count(*) into n from list_my_backups_phase2(ta, 100) x where x.id = v_bk;
    perform purge_my_backups_of(ta, array['mu-b-1'], '{}'::text[]);
    r3 := restore_my_backup_phase2(ta, v_bk);
    r4 := snapshot_my_data_phase2(ta, 'manual', null);
    perform set_my_wavespeed_key(ta, 'mu-test-key-A-0001');
    reset role;
    out := out || case when (select count(*) from tasks where id in ('mu-b-1', 'mu-b-2') and device_id = sb) = 2
                         and exists (select 1 from data_backups where id = v_bk) and n = 0
                         and (select md5(tasks_snapshot::text) from data_backups where id = v_bk) = v_md5
                         and r3->>'reason' = 'backup_not_found'
                         and (select count(*) from data_backups where username = sa) = n2 + 1
                         and not exists (select 1 from data_backups where username like 'u:%')
                         and exists (select 1 from user_secrets where device_id = sa and key = 'wavespeed_api_key')
                         and not exists (select 1 from user_secrets where device_id like 'u:%')
      then 'ok A-never-touches-B; '
      else format('FAIL A-never-touches-B del=%s clr=%s list=%s rst=%s; ', r->>'deleted', r2->>'deleted', n, left(coalesce(r3->>'reason', 'ok'), 20)) end;
  exception when others then reset role; out := out || format('FAIL A-never-touches-B %s; ', left(sqlerrm, 60)); end;

  -- 11. B's WaveSpeed key, read the way the proxy reads it (service_role), is B's own; anon still cannot call the read.
  begin
    set local role service_role;
    s := get_my_wavespeed_key(tb);
    reset role;
    out := out || case when md5(coalesce(s, '')) = md5('mu-test-key-B-0002')
                         and not has_function_privilege('anon', 'public.get_my_wavespeed_key'::regproc, 'execute')
      then 'ok wavespeed-B-own; ' else 'FAIL wavespeed-B-own; ' end;
  exception when others then reset role; out := out || format('FAIL wavespeed-B-own %s; ', left(sqlerrm, 60)); end;

  -- 12. A's token with B's id swapped in is refused (the signature covers the subject).
  begin
    t := replace(ta, a::text, b::text);
    begin perform get_my_account(t); out := out || 'FAIL forged-subject; ';
    exception when others then out := out || case when sqlerrm ~ 'invalid signature' then 'ok forged-subject; ' else format('FAIL forged-subject %s; ', left(sqlerrm, 40)) end; end;
  end;

  -- 13. The RLS session's dual-format session_scope (its own migration, M2): A's token in the header scopes to A.
  begin
    perform set_config('request.headers', json_build_object('x-proxima-session', ta)::text, true);
    s := proxima_auth.session_scope(true);
    perform set_config('request.headers', ip_u, true);
    out := out || case when s = sa then 'ok scope-header-A; ' else format('FAIL scope-header-A %s; ', left(coalesce(s, 'null'), 40)) end;
  exception when others then out := out || format('FAIL scope-header-A %s; ', left(sqlerrm, 60)); end;

  -- 14. Dual-accept window: an 'admin:<owner>' token keeps working (role owner, the owner's scope); 'admin:' never maps
  --     to a member; an owner token issued before the owner's epoch is revoked (epoch moved, then put back). From M4
  --     (supabase/migrations/20261023400000_mu_p1_end_dual_accept.sql) EVERY 'admin:' token answers exactly
  --     'session token revoked': the owner's name issued now or 6 h ago (both valid before M4), a member's name, an
  --     empty name; through the verifier, get_my_account (as anon) and session_scope (28000). m4-stage-consistent: M4's
  --     three marks (set_admin_credentials_rehash gone, current_account without its 'admin: branch, the verifier
  --     revoking a fresh owner 'admin:' token) are all present or all absent; a partial M4 fails.
  begin
    v_m4 := not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'set_admin_credentials_rehash');
    select sessions_valid_after into v_ep from proxima_auth.users where id = v_owner_id;
    t := _sign_session_token('admin:' || v_owner, now() + interval '12 hours 5 minutes');
    begin perform _verify_session_token(t); s := 'accepted'; exception when others then s := sqlerrm; end;
    n := (v_m4::int) + (position('''admin:' in pg_get_functiondef('proxima_auth.current_account(text)'::regprocedure)) = 0)::int
         + (s = 'session token revoked')::int;
    out := out || case when n in (0, 3) then format('ok m4-stage-consistent (m4=%s); ', v_m4)
                       else format('FAIL m4-stage-consistent %s of 3 M4 marks (rehash-gone=%s verifier=%s); ', n, v_m4, left(s, 30)) end;
    if v_m4 then
      ok := true; v_md5 := ''; t3 := current_setting('request.headers', true);
      foreach s in array array['admin:' || v_owner || '|0', 'admin:' || v_owner || '|-21600', 'admin:__mu_a|0', 'admin:|0'] loop
        t2 := _sign_session_token(split_part(s, '|', 1), to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint
                + split_part(s, '|', 2)::bigint, v_ep + 1) + 43200));
        begin perform _verify_session_token(t2); v_md5 := v_md5 || 'verify-accepted '; ok := false;
        exception when others then if sqlerrm <> 'session token revoked' then ok := false; v_md5 := v_md5 || 'verify ' || left(sqlerrm, 20) || ' '; end if; end;
        begin
          set local role anon;
          r := get_my_account(t2);
          reset role;
          ok := false; v_md5 := v_md5 || 'account-answered ';
        exception when others then reset role;
          if sqlerrm <> 'session token revoked' then ok := false; v_md5 := v_md5 || 'account ' || left(sqlerrm, 20) || ' '; end if;
        end;
        perform set_config('request.headers', json_build_object('x-proxima-session', t2)::text, true);
        begin perform proxima_auth.session_scope(true); ok := false; v_md5 := v_md5 || 'scope-accepted ';
        exception when others then
          if not (sqlstate = '28000' and sqlerrm = 'session token revoked') then ok := false; v_md5 := v_md5 || 'scope ' || sqlstate || ' '; end if;
        end;
        perform set_config('request.headers', coalesce(t3, ''), true);
      end loop;
      -- the owner's own 'u:' token is unaffected
      r := get_my_account(proxima_auth.mint_token(v_owner_id));
      ok := ok and (r->>'id')::uuid = v_owner_id and r->>'role' = 'owner';
      r := json_build_object('m4', v_md5);
    else
      r := get_my_account(t);
      ok := (r->>'ok')::boolean and (r->>'id')::uuid = v_owner_id and r->>'role' = 'owner' and r->>'scope' = 'user:' || v_owner;
      begin perform get_my_account(_sign_session_token('admin:__mu_a', now() + interval '12 hours 5 minutes')); ok := false;
      exception when others then ok := ok and sqlerrm ~ 'revoked'; end;
      update proxima_auth.users set sessions_valid_after = extract(epoch from now())::bigint + 600 where id = v_owner_id;
      begin perform get_my_account(t); ok := false;
      exception when others then ok := ok and sqlerrm ~ 'revoked'; end;
      update proxima_auth.users set sessions_valid_after = v_ep where id = v_owner_id;
    end if;
    out := out || case when ok then format('ok dual-accept-admin (%s); ', case when v_m4 then 'M4: every admin: revoked' else 'window open' end)
                       else format('FAIL dual-accept-admin m4=%s %s; ', v_m4, left(coalesce(r::text, ''), 80)) end;
  exception when others then reset role; out := out || format('FAIL dual-accept-admin %s; ', left(sqlerrm, 60)); end;

  -- 15. Per-IP throttle (limit lowered to 3). From a blocked IP the password is still checked: B's right password signs
  --     in, a wrong one answers 'throttled' AND counts on B as from anywhere (main-session decision replacing review
  --     #22's "never counts": the 3-try lock stays the guessing limit). Another IP signs B in. IPv6 is keyed by its /64.
  --     No header, or one that does not cast to inet, is never throttled. The shared-key guard (lowered to 3 names)
  --     drops the mode to 'observe'. Limits and mode are restored at the end.
  begin
    update proxima_auth.auth_config set throttle_max_failures = 3;
    perform set_config('request.headers', ip_t, true);
    set local role anon;
    for i in 1..3 loop r := verify_admin('__mu_ghost' || i, 'whatever-123'); end loop;
    r := verify_admin('__mu_b', pb);
    r2 := verify_admin('__mu_b', 'wrong-password-t');
    reset role;
    select login_failed into n from proxima_auth.users where id = b;   -- the wrong one from the blocked IP counted on B
    set local role anon;
    perform set_config('request.headers', ip_w, true);
    r3 := verify_admin('__mu_b', pb);
    reset role;
    out := out || case when (r->>'ok')::boolean and r2->>'reason' = 'throttled' and r2->>'token' is null and (r3->>'ok')::boolean and n = 1
      then 'ok ip-throttle; ' else format('FAIL ip-throttle %s %s nB=%s; ', coalesce(r->>'reason', 'ok'), r2->>'reason', n) end;

    set local role anon;
    perform set_config('request.headers', ip6_1, true); r := verify_admin('__mu_ghost4', 'whatever-123');
    perform set_config('request.headers', ip6_2, true); r := verify_admin('__mu_ghost5', 'whatever-123');
    perform set_config('request.headers', ip6_3, true); r := verify_admin('__mu_ghost6', 'whatever-123');
    perform set_config('request.headers', ip6_4, true); r := verify_admin('__mu_ghost7', 'whatever-123');
    perform set_config('request.headers', ip6_o, true); r2 := verify_admin('__mu_ghost8', 'whatever-123');
    reset role;
    out := out || case when r->>'reason' = 'throttled' and r2->>'reason' = 'invalid'
      then 'ok ipv6-per-64; ' else format('FAIL ipv6-per-64 %s %s; ', r->>'reason', r2->>'reason') end;

    perform set_config('request.headers', '{}', true);
    set local role anon;
    for i in 1..4 loop r := verify_admin('__mu_ghost' || i, 'whatever-123'); end loop;
    reset role;
    out := out || case when r->>'reason' = 'invalid' then 'ok no-ip-no-throttle; ' else format('FAIL no-ip-no-throttle %s; ', r->>'reason') end;

    perform set_config('request.headers', ip_bad, true);
    set local role anon;
    for i in 1..4 loop r := verify_admin('__mu_ghost' || i, 'whatever-123'); end loop;
    reset role;
    out := out || case when r->>'reason' = 'invalid' then 'ok bad-ip-no-throttle; ' else format('FAIL bad-ip-no-throttle %s; ', r->>'reason') end;

    update proxima_auth.auth_config set throttle_max_failures = 10, throttle_guard_names = 3;
    perform set_config('request.headers', ip_g, true);
    set local role anon;
    for i in 1..4 loop r := verify_admin('__mu_guard' || i, 'whatever-123'); end loop;
    reset role;
    select signin_throttle into s from proxima_auth.auth_config;
    out := out || case when s = 'observe' then 'ok shared-key-guard; ' else format('FAIL shared-key-guard mode=%s; ', s) end;
    update proxima_auth.auth_config set signin_throttle = 'on', throttle_max_failures = 10, throttle_guard_names = 50;
  exception when others then reset role; out := out || format('FAIL ip-throttle %s; ', left(sqlerrm, 60)); end;

  -- 16. A renames: a name taken by B (any case) is refused; a free one moves only A's rows and keeps scope in step;
  --     B's token and rows are untouched. After 5 taken answers in the hour, A's next try answers 'rate_limited' even for
  --     a free name; the limit is A's alone (B's try still gets 'username_taken').
  begin
    -- A row of A's to move (case 10's clear_queued_rows cleared every A row that existed when it was queued).
    insert into tasks (id, device_id, status, start_time, outputs) values ('mu-a-r', sa, 'completed', 1000, '[]');
    perform set_config('request.headers', ip_u, true);
    set local role anon;
    r := rename_my_account(ta, pa3, '__MU_B');
    r2 := rename_my_account(ta, pa3, '__mu_a2');
    reset role;
    t2 := r2->>'token';
    out := out || case when r->>'reason' = 'username_taken' and (r2->>'ok')::boolean
                         and (select scope = 'user:__mu_a2' and username = '__mu_a2' from proxima_auth.users where id = a)
                         and exists (select 1 from tasks where id = 'mu-a-r' and device_id = 'user:__mu_a2')
                         and (select count(*) from tasks where id in ('mu-b-1', 'mu-b-2') and device_id = sb) = 2
                         and (get_my_account(tb)->>'ok')::boolean and get_my_account(t2)->>'scope' = 'user:__mu_a2'
      then 'ok rename-A-only; ' else format('FAIL rename-A-only %s %s; ', r->>'reason', coalesce(r2->>'reason', 'ok')) end;
    set local role anon;
    for i in 1..4 loop r := rename_my_account(t2, pa3, '__mu_b'); end loop;
    r3 := rename_my_account(t2, pa3, '__mu_free_name');
    r4 := rename_my_account(tb, pb, '__MU_A2');
    reset role;
    out := out || case when r->>'reason' = 'username_taken' and r3->>'reason' = 'rate_limited' and r4->>'reason' = 'username_taken'
                         and (select username from proxima_auth.users where id = a) = '__mu_a2'
      then 'ok rename-rate-limit; ' else format('FAIL rename-rate-limit %s %s %s; ', r->>'reason', r3->>'reason', r4->>'reason') end;
  exception when others then reset role; out := out || format('FAIL rename-A-only %s; ', left(sqlerrm, 60)); end;

  -- 17. A disabled account's tokens stop at once; the others keep working.
  begin
    update proxima_auth.users set disabled_at = now() where id = c;
    begin perform get_my_account(tc); out := out || 'FAIL disabled-C; ';
    exception when others then
      out := out || case when sqlerrm ~ 'revoked' and (get_my_account(tb)->>'ok')::boolean then 'ok disabled-C; '
                         else format('FAIL disabled-C %s; ', left(sqlerrm, 40)) end; end;
  exception when others then out := out || format('FAIL disabled-C %s; ', left(sqlerrm, 60)); end;

  -- 18. The backup pause is per account: 5 wrong codes pause A; during the pause A's right and a wrong code answer the
  --     same bytes and nothing unlocks; B's right code still unlocks B.
  begin
    select sessions_valid_after into v_ep from proxima_auth.users where id = a;
    perform set_config('request.headers', ip_x, true);
    set local role anon;
    for i in 1..5 loop r := unlock_with_backup_code('__mu_a2', 'not-the-code-' || i || '-000000', null); end loop;
    r := unlock_with_backup_code('__mu_a2', ka, null);
    r2 := unlock_with_backup_code('__mu_a2', 'not-the-code-9-000000', null);
    r3 := unlock_with_backup_code('__mu_b', kb, null);
    reset role;
    ok := (select backup_locked_until > now() and sessions_valid_after = v_ep from proxima_auth.users where id = a);
    out := out || case when ok and (r3->>'ok')::boolean
                         and (select backup_failed = 0 and backup_locked_until is null from proxima_auth.users where id = b)
      then 'ok backup-pause-A-only; ' else format('FAIL backup-pause-A-only B=%s; ', coalesce(r3->>'reason', 'ok')) end;
    out := out || case when r::jsonb = r2::jsonb and r->>'reason' = 'invalid' and ok
      then 'ok pause-generic; ' else format('FAIL pause-generic %s|%s; ', left(r::text, 28), left(r2::text, 28)) end;
  exception when others then reset role; out := out || format('FAIL backup-pause-A-only %s; ', left(sqlerrm, 60)); end;

  -- 19. The verifier fails closed: a validly signed subject that is neither 'u:' nor 'admin:' is malformed.
  begin
    n := 0;
    begin perform get_my_account(_sign_session_token('user:__mu_a', now() + interval '5 minutes'));
    exception when others then if sqlerrm ~ 'malformed session token' then n := n + 1; end if; end;
    begin perform get_my_account(_sign_session_token('zz:x', now() + interval '5 minutes'));
    exception when others then if sqlerrm ~ 'malformed session token' then n := n + 1; end if; end;
    out := out || case when n = 2 then 'ok other-subject-malformed; ' else format('FAIL other-subject-malformed %s; ', n) end;
  exception when others then out := out || format('FAIL other-subject-malformed %s; ', left(sqlerrm, 60)); end;

  -- 20. Nothing the members did moved the real owner row's counters or epoch.
  begin
    select md5(row(x.login_failed, x.login_locked_at, x.backup_failed, x.backup_locked_until, x.sessions_valid_after)::text)
      into s from proxima_auth.users x where x.role = 'owner';
    out := out || case when s = v_own_snap then 'ok owner-untouched; ' else 'FAIL owner-untouched; ' end;
  exception when others then out := out || format('FAIL owner-untouched %s; ', left(sqlerrm, 60)); end;

  -- 20b. M3 (supabase/migrations/20261023300000_mu_p1_mint_u_tokens.sql): mint_token(owner id) gives 'u:<owner id>'
  --      from M3 ('admin:<owner name>' before it). A 'u:' token for the owner (minted from M3; signed as M3 signs it
  --      before) gives the owner's scope through session_scope and the owner's id, role, scope and sync topic through
  --      get_my_account, the same topic as an 'admin:' token. An 'admin:<owner>' token issued before M3 (signed as the
  --      pre-M3 issue_session did) keeps verifying as the owner until M4 (revoked from M4).
  begin
    -- M3 is live when issue_session has M3's post-apply body or no longer signs 'admin:' || ... (the catalog gate's test).
    select md5(x) = 'b9ba44a18b04d17bdf0034b944a57035' or x !~* $re$'admin:'\s*\|\|$re$ into v_m3
      from pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure) x;
    v_pfx := case when v_m3 then 'u:' || v_owner_id || '.' else 'admin:' || v_owner || '.' end;
    t := proxima_auth.mint_token(v_owner_id);
    out := out || case when left(t, length(v_pfx)) = v_pfx then format('ok mint-u-owner (m3=%s); ', v_m3)
                       else format('FAIL mint-u-owner m3=%s got %s; ', v_m3, split_part(t, ':', 1)) end;
    v_otok := case when v_m3 then t else _sign_session_token('u:' || v_owner_id,
                to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint,
                                      (select sessions_valid_after from proxima_auth.users where id = v_owner_id) + 1) + 43200)) end;
    t2 := _sign_session_token('admin:' || v_owner,
            to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint,
                                  (select sessions_valid_after from proxima_auth.users where id = v_owner_id) + 1) + 43200));
    -- session_scope on the owner's u: token in its own block: before M2 it refuses every u: token ('not admin-scoped',
    -- 28000), reported as `FAIL owner-u-session-scope` (expected at the M1-alone stage, design §9.1); the label is
    -- printed only then, and the checks below still run. From M2 it resolves and owner-u-scope-topic checks the scope.
    perform set_config('request.headers', json_build_object('x-proxima-session', v_otok)::text, true);
    begin
      s := proxima_auth.session_scope(true);
      ok := true;
    exception when others then
      ok := false;
      out := out || format('FAIL owner-u-session-scope %s; ', left(sqlerrm, 40));
    end;
    perform set_config('request.headers', ip_y, true);
    set local role anon;
    r := get_my_account(v_otok);
    reset role;
    out := out || case when (not ok or s = 'user:' || v_owner) and (r->>'id')::uuid = v_owner_id and r->>'role' = 'owner'
                         and r->>'scope' = 'user:' || v_owner and r->>'sync_topic' is not null
                         and r->>'sync_topic' = proxima_auth.sync_topic()
      then 'ok owner-u-scope-topic; ' else format('FAIL owner-u-scope-topic %s %s; ', left(coalesce(s, 'null'), 30), r->>'role') end;
    v_m4 := not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'set_admin_credentials_rehash');
    begin
      set local role anon;
      r2 := get_my_account(t2);
      reset role;
      ok := not v_m4 and (r2->>'id')::uuid = v_owner_id and r2->>'role' = 'owner' and r2->>'sync_topic' = r->>'sync_topic';
    exception when others then reset role; ok := v_m4 and sqlerrm ~ 'revoked'; end;
    out := out || case when ok then format('ok admin-still-verifies (m4=%s); ', v_m4) else format('FAIL admin-still-verifies m4=%s; ', v_m4) end;
  exception when others then reset role; out := out || format('FAIL mint-u-owner %s; ', left(sqlerrm, 60)); end;

  -- 21. The owner's own flows, in every stage (admin:<name> tokens before M3, u:<id> after): sign-in, password change
  --     and rename each return a token get_my_account accepts as the owner, and revoke the one before. pg_sleep(0.6)
  --     before each bump makes the call cross a second boundary (the token must not be born revoked). The old 2-arg
  --     unlock acts on the owner row only. The owner row gets a known cost-4 hash and code inside this rolled-back block.
  begin
    perform set_config('request.headers', ip_y, true);
    update proxima_auth.users set password_hash = extensions.crypt(po, extensions.gen_salt('bf', 4)),
           backup_code_hash = extensions.crypt(ko, extensions.gen_salt('bf', 4)),
           login_failed = 0, login_locked_at = null, backup_failed = 0, backup_locked_until = null
     where id = v_owner_id;
    set local role anon;
    r := verify_admin(v_owner, po);
    reset role;
    t := r->>'token';
    r2 := get_my_account(t);
    -- From M3 every owner flow returns 'u:<owner id>'; before M3 'admin:<owner name>' (v_pfx, case 20b).
    out := out || case when (r->>'ok')::boolean and left(t, length(v_pfx)) = v_pfx
                         and (r2->>'id')::uuid = v_owner_id and r2->>'role' = 'owner'
      then format('ok owner-signin (%s); ', split_part(t, ':', 1))
      else format('FAIL owner-signin %s %s; ', left(coalesce(r->>'reason', 'ok'), 40), split_part(coalesce(t, ''), ':', 1)) end;

    perform pg_sleep(0.6);
    set local role anon;
    r := change_my_password(t, po, po2);
    reset role;
    t2 := r->>'token';
    ok := (r->>'ok')::boolean and (get_my_account(t2)->>'id')::uuid = v_owner_id and left(t2, length(v_pfx)) = v_pfx;
    begin perform get_my_account(t); ok := false;
    exception when others then ok := ok and sqlerrm ~ 'revoked'; end;
    out := out || case when ok then 'ok owner-pwchange; ' else format('FAIL owner-pwchange %s; ', left(coalesce(r->>'reason', 'ok'), 40)) end;

    perform pg_sleep(0.6);
    set local role anon;
    r := rename_my_account(t2, po2, '__mu_owner_tmp');
    reset role;
    t3 := r->>'token';
    r2 := get_my_account(t3);
    ok := (r->>'ok')::boolean and (r2->>'id')::uuid = v_owner_id and r2->>'role' = 'owner'
          and r2->>'username' = '__mu_owner_tmp' and r2->>'scope' = 'user:__mu_owner_tmp'
          and left(t3, length(case when v_m3 then v_pfx else 'admin:__mu_owner_tmp.' end))
              = case when v_m3 then v_pfx else 'admin:__mu_owner_tmp.' end;
    begin perform get_my_account(t2); ok := false;
    exception when others then ok := ok and sqlerrm ~ 'revoked'; end;
    out := out || case when ok then 'ok owner-rename; ' else format('FAIL owner-rename %s; ', left(coalesce(r->>'reason', 'ok'), 40)) end;

    if to_regprocedure('public.unlock_admin_with_backup_code(text,text)') is null then
      out := out || 'ok owner-old-unlock (dropped at M4); ';
    else
      update proxima_auth.users set login_failed = 3, login_locked_at = now() where id = v_owner_id;
      select sessions_valid_after into v_ep from proxima_auth.users where id = v_owner_id;
      select sessions_valid_after into v_ep2 from proxima_auth.users where id = b;
      perform pg_sleep(0.6);
      set local role anon;
      r := unlock_admin_with_backup_code(ko, po3);
      reset role;
      ok := (r->>'ok')::boolean
            and (select login_locked_at is null and login_failed = 0 and password_hash = extensions.crypt(po3, password_hash)
                        and sessions_valid_after > v_ep from proxima_auth.users where id = v_owner_id)
            and (select sessions_valid_after from proxima_auth.users where id = b) = v_ep2;
      begin perform get_my_account(t3); ok := false;
      exception when others then ok := ok and sqlerrm ~ 'revoked'; end;
      out := out || case when ok then 'ok owner-old-unlock; ' else format('FAIL owner-old-unlock %s; ', left(coalesce(r->>'reason', 'ok'), 40)) end;
    end if;
  exception when others then reset role; out := out || format('FAIL owner-signin %s; ', left(sqlerrm, 60)); end;

  raise exception 'RESULT: %', out;
end $t$;
