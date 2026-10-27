-- Tests for supabase/migrations/20261027100000_signin_history.sql: every sign-in, unlock, join and password re-entry
-- leaves exactly the event it should, and ONLY the owner reads them, for every account (owner 2026-10-27: "I will be able
-- to see sign-in history for all accounts. And no one else can see them"; members see none, not even their own), through
-- list_signins; a log row never decides a sign-in; repeats (successes too) fold into one counted row; floods are capped
-- per account and class (failures, successes, lock moments) and per kind for no account, and counted on a 'suppressed',
-- 'suppressed_ok' or 'suppressed_lock' row; events older than 90 days go.
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261027100000_signin_history.sql --test scripts/test-signin-history-db.sql
-- One DO block, always rolled back by sql-tx. Fixtures: a test owner (the owner role moved onto it in this transaction
-- only), members with and without a backup code, a disabled member, a deleted one and one without a password, with known
-- passwords. Calls run as anon with the request headers a browser sends; cases use separate client addresses wherever a
-- fold could join their rows. now() is one instant in a transaction, so every window holds every row: H14-H18 test the
-- 10-minute and 1-hour windows by BACKDATING rows, with a row's start (at) apart from its latest repeat (last_at) wherever
-- the window must run from the start (reviews wf_d4f75a17-159 and wf_79964fbc-e0a). Rows a case seeds after its v_from
-- carry client 'seed' and are left out of the event strings; rows seeded before its v_from are outside them anyway.
-- Events are compared as exact ordered strings 'kind:outcome[:T if throttled][xN if repeated]' (pg_temp.ev / pg_temp.evn),
-- so a wrong outcome, a missing or doubled call, or a wrong throttled flag fails the case (review wf_22e47bf1-fa6 M4).
-- Never prints a token, code or password.
-- Mutation check: gsh-mutants.mjs in the artifacts folder (run one at a time); results in the line below.
-- MUTANTS (2026-10-27, final run 13:05-15:22 UTC): 246 of 248 fail this file (every log call's line mutants plus 115
-- hand-written ones on the fold and its start anchor, mixed, caps per class and the reauth budget, windows, counted
-- rows and their source, plan mode, grants, and the reader's fields, filters and paging). The two that pass are equivalent:
-- dropping list_signins' own disabled-owner check (proxima_auth.current_account already refuses a disabled account's
-- token), and granting it to anon only (Supabase's default privileges grant every new public function to authenticated).
-- Runs that apply the migration must not overlap (each creates the table; the migration's 2 s lock_timeout cancels the
-- one that waits): a "55P03 ... pg_type_typname_nsp_index" or "error before RESULT" is contention, not a result.
do $t$
declare
  out text := ''; ok boolean; j json; j2 json; j3 json; n int; n2 int; v_from bigint; got text; got2 text; got3 text;
  o uuid; m uuid; d uuid; dl uuid; np uuid; k uuid; joined uuid; o_tk text; m_tk text; code text; code2 text; v_open boolean; v_mode text;
  v_src text; v_def text; v_def2 text; jg json; ids bigint[]; ids2 bigint[]; v_n bigint;
  k_name constant text := '__sh_k_' || txid_current();
  o_name constant text := '__sh_o_' || txid_current();
  m_name constant text := '__sh_m_' || txid_current();
  d_name constant text := '__sh_d_' || txid_current();
  dl_name constant text := '__sh_x_' || txid_current();
  np_name constant text := '__sh_n_' || txid_current();
  j_name constant text := '__sh_j_' || txid_current();
  pw constant text := 'history-pass-0001';
  pw2 constant text := 'history-pass-0002';
  pw3 constant text := 'history-pass-0003';
  ua_text constant text := 'TestAgent/1.0 (Linux; Android 14)';
  guard constant text := 'supabase-js-web/2.45.0 proxima-rls/1 sess/0 proxima-guard/1';
  oldb constant text := 'supabase-js-web/2.45.0 proxima-rls/1 sess/0';
begin
  begin
    execute $x$create function pg_temp.hdr(p_ip text, p_client text, p_ua text default 'TestAgent/1.0 (Linux; Android 14)',
                                           p_session text default null) returns text language sql as
      $f$ select json_strip_nulls(json_build_object('cf-connecting-ip', p_ip, 'user-agent', p_ua, 'x-client-info', p_client,
                                                    'x-proxima-session', p_session))::text $f$$x$;
    execute $x$create function pg_temp.ev(p_from bigint, p_acc uuid) returns text language sql as
      $f$ select coalesce(string_agg(e.kind || ':' || e.outcome || case when e.throttled then ':T' else '' end
                                      || case when e.repeats > 1 then 'x' || e.repeats else '' end, ',' order by e.id), '')
            from proxima_auth.signin_events e where e.id > p_from and e.account_id = p_acc
             and e.client is distinct from 'seed' $f$$x$;
    execute $x$create function pg_temp.evn(p_from bigint, p_kind text) returns text language sql as
      $f$ select coalesce(string_agg(e.kind || ':' || e.outcome || case when e.throttled then ':T' else '' end
                                      || case when e.repeats > 1 then 'x' || e.repeats else '' end, ',' order by e.id), '')
            from proxima_auth.signin_events e where e.id > p_from and e.account_id is null and e.kind = p_kind
             and e.client is distinct from 'seed' $f$$x$;
    execute $x$create function pg_temp.maxid() returns bigint language sql as
      $f$ select coalesce(max(e.id), 0) from proxima_auth.signin_events e $f$$x$;
    execute $x$create function pg_temp.net(p_ip text) returns text language sql as
      $f$ select left(encode(extensions.hmac(p_ip, c.throttle_key, 'sha256'), 'hex'), 8) from proxima_auth.auth_config c where c.id $f$$x$;
    select c.members_open, c.signin_throttle, c.ip_source into v_open, v_mode, v_src from proxima_auth.auth_config c where c.id;
    update proxima_auth.auth_config set members_open = false where id;
    update proxima_auth.users set role = 'member' where role = 'owner';
    insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash)
      values (o_name, 'owner', 'user:' || o_name, extensions.crypt(pw, extensions.gen_salt('bf', 4)),
              extensions.crypt('backup-code-0001', extensions.gen_salt('bf', 4))) returning id into o;
    insert into proxima_auth.users (username, role, scope, password_hash)
      values (m_name, 'member', 'user:' || m_name, extensions.crypt(pw, extensions.gen_salt('bf', 4))) returning id into m;
    insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash, disabled_at)
      values (d_name, 'member', 'user:' || d_name, extensions.crypt(pw, extensions.gen_salt('bf', 4)),
              extensions.crypt('backup-code-0009', extensions.gen_salt('bf', 4)), now()) returning id into d;
    insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash, deleted_at)
      values (dl_name, 'member', 'user:' || dl_name, extensions.crypt(pw, extensions.gen_salt('bf', 4)),
              extensions.crypt('backup-code-0005', extensions.gen_salt('bf', 4)), now()) returning id into dl;
    insert into proxima_auth.users (username, role, scope)
      values (np_name, 'member', 'user:' || np_name) returning id into np;
    insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash)
      values (k_name, 'member', 'user:' || k_name, extensions.crypt(pw, extensions.gen_salt('bf', 4)),
              extensions.crypt('backup-code-0003', extensions.gen_salt('bf', 4))) returning id into k;
    out := out || 'ok seed; ';
  exception when others then out := out || format('FAIL seed %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- H1. Sign-in: success, two wrong passwords (one row, x2), the third (it locks), an attempt while locked, an unknown
  --     name (no account); with the browser, the app marker and the network's keyed code.
  begin
    v_from := pg_temp.maxid();
    got := pg_temp.hdr('198.51.100.51', guard);
    set local role anon;
    perform set_config('request.headers', got, true);
    perform public.verify_admin(o_name, pw);
    perform public.verify_admin(o_name, 'wrong-1');
    perform public.verify_admin(o_name, 'wrong-2');
    perform public.verify_admin(o_name, 'wrong-3');
    perform public.verify_admin(o_name, pw);
    perform public.verify_admin('__sh_none_' || txid_current(), pw);
    reset role;
    got := pg_temp.ev(v_from, o); got2 := pg_temp.evn(v_from, 'signin');
    ok := got = 'signin:ok,signin:wrong_passwordx2,signin:locked_now,signin:locked' and got2 = 'signin:unknown'
      and (select bool_and(e.agent = ua_text and e.client = guard and e.net = pg_temp.net('198.51.100.51'))
             from proxima_auth.signin_events e where e.id > v_from);
    out := out || case when ok then 'ok H1 signin; ' else format('FAIL H1 %s | %s; ', got, got2) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H1 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H2. A disabled account, a deleted one (its own outcome: review wf_d4f75a17-159), an account without a password, and a
  --     member's correct password from an older build.
  begin
    v_from := pg_temp.maxid();
    got := pg_temp.hdr('198.51.100.53', guard); got2 := pg_temp.hdr('198.51.100.52', oldb);
    set local role anon;
    perform set_config('request.headers', got, true);
    perform public.verify_admin(d_name, pw);
    perform public.verify_admin(dl_name, pw);
    perform public.verify_admin(np_name, pw);
    perform set_config('request.headers', got2, true);
    j := public.verify_admin(m_name, pw);
    reset role;
    ok := pg_temp.ev(v_from, d) = 'signin:disabled' and pg_temp.ev(v_from, dl) = 'signin:deleted'
      and pg_temp.ev(v_from, np) = 'signin:no_password'
      and pg_temp.ev(v_from, m) = 'signin:update_required' and j->>'reason' = 'update_required';
    out := out || case when ok then 'ok H2 signin-branches; ' else format('FAIL H2 %s|%s|%s|%s; ', pg_temp.ev(v_from, d),
      pg_temp.ev(v_from, dl), pg_temp.ev(v_from, np), pg_temp.ev(v_from, m)) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H2 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H3. Unlock by name: a wrong code, the right one with a new password, the right one alone; an unknown name, a member
  --     without a backup code, a disabled account, a deleted one; then (another network) four wrong codes (x4), the fifth
  --     pauses, one more while paused.
  begin
    v_from := pg_temp.maxid();
    got := pg_temp.hdr('198.51.100.55', guard); got2 := pg_temp.hdr('198.51.100.56', guard);
    set local role anon;
    perform set_config('request.headers', got, true);
    perform public.unlock_with_backup_code(o_name, 'wrong-code-0000', null);
    j := public.unlock_with_backup_code(o_name, 'backup-code-0001', pw2);
    j2 := public.unlock_with_backup_code(o_name, 'backup-code-0001', null);
    perform public.unlock_with_backup_code('__sh_none_' || txid_current(), 'backup-code-0001', null);
    perform public.unlock_with_backup_code(m_name, 'backup-code-0001', null);
    perform public.unlock_with_backup_code(d_name, 'backup-code-0009', null);
    perform public.unlock_with_backup_code(dl_name, 'backup-code-0005', null);
    perform set_config('request.headers', got2, true);
    for n in 1..5 loop perform public.unlock_with_backup_code(o_name, 'wrong-code-000' || n, null); end loop;
    perform public.unlock_with_backup_code(o_name, 'backup-code-0001', null);
    reset role;
    got := pg_temp.ev(v_from, o);
    ok := (j->>'ok')::boolean and (j2->>'ok')::boolean
      and got = 'unlock:wrong_code,unlock:ok_password_reset,unlock:ok,unlock:wrong_codex4,unlock:paused_now,unlock:paused'
      and pg_temp.evn(v_from, 'unlock') = 'unlock:unknown' and pg_temp.ev(v_from, m) = 'unlock:no_backup_code'
      and pg_temp.ev(v_from, d) = 'unlock:disabled' and pg_temp.ev(v_from, dl) = 'unlock:deleted';
    out := out || case when ok then 'ok H3 unlock; ' else format('FAIL H3 %s | %s | %s | %s | %s; ', got, pg_temp.evn(v_from, 'unlock'),
      pg_temp.ev(v_from, m), pg_temp.ev(v_from, d), pg_temp.ev(v_from, dl)) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H3 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H4. Refusals decided by the request's shape alone (free to send) fold into one row an hour from any network: a new
  --     password that is too short (unlock), and the owner-only legacy unlock from an older build, which names no account
  --     (it no longer writes on the owner's account: review M1).
  begin
    v_from := pg_temp.maxid();
    n := (select count(*) from proxima_auth.signin_events e where e.account_id = o);
    got := pg_temp.hdr('198.51.100.57', guard); got2 := pg_temp.hdr('198.51.100.52', oldb); got3 := pg_temp.hdr('198.51.100.58', oldb);
    set local role anon;
    perform set_config('request.headers', got, true);
    j := public.unlock_with_backup_code(o_name, 'backup-code-0001', 'short');
    perform set_config('request.headers', got2, true);
    j2 := public.unlock_admin_with_backup_code('backup-code-0001', null);
    perform public.unlock_admin_with_backup_code('x', null);
    perform set_config('request.headers', got3, true);
    perform public.unlock_admin_with_backup_code('y', null);
    perform public.unlock_with_backup_code(o_name, 'backup-code-0001', 'short2');
    reset role;
    got := pg_temp.evn(v_from, 'unlock');
    ok := j->>'reason' = 'weak_password' and j2->>'reason' = 'update_required'
      and got = 'unlock:weak_passwordx2,unlock:update_requiredx3'
      and (select count(*) from proxima_auth.signin_events e where e.account_id = o) = n
      and (select bool_and(e.net is null and e.mixed) from proxima_auth.signin_events e where e.id > v_from);
    out := out || case when ok then 'ok H4 shape-refusals; ' else format('FAIL H4 %s; ', got) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H4 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H5. Join: closed (x3 from three networks: one row, network cleared), a bad name (x2 from two networks), a short
  --     password, a dead code, a taken name, the 6th taken name (the code is voided), a name taken meanwhile
  --     (unique_violation, another network), a blocked network (throttled), and a real join (the new account's first
  --     event). The two invites need the owner's password again: one row 'reauth:okx2' (successes fold too).
  begin
    v_from := pg_temp.maxid();
    o_tk := proxima_auth.mint_token(o);
    got := pg_temp.hdr('198.51.100.59', guard); got2 := pg_temp.hdr('198.51.100.60', guard); got3 := pg_temp.hdr('198.51.100.61', guard);
    set local role anon;
    perform set_config('request.headers', got, true);
    j := public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', j_name || 'c', 'join-pass-0001');
    perform set_config('request.headers', got2, true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', j_name || 'c', 'join-pass-0001');
    perform set_config('request.headers', got3, true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', j_name || 'c', 'join-pass-0001');
    reset role;
    update proxima_auth.auth_config set members_open = true where id;
    set local role anon;
    perform set_config('request.headers', got, true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', '!', 'join-pass-0001');
    perform set_config('request.headers', got2, true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', '!', 'join-pass-0001');
    perform set_config('request.headers', got, true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', j_name || 'w', 'short');
    -- a too-short password is a shape refusal too: from another network it folds into the same row
    perform set_config('request.headers', got2, true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', j_name || 'w', 'short');
    perform set_config('request.headers', got, true);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.59', guard, ua_text, o_tk), true);
    code := public.create_invite(o_tk, pw2)->>'code';
    code2 := public.create_invite(o_tk, pw2)->>'code';
    perform set_config('request.headers', got, true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ9', j_name || 'd', 'join-pass-0001');
    perform public.join_with_invite(code, m_name, 'join-pass-0001');
    reset role;
    update proxima_auth.invites set taken_count = 5 where code_hash = proxima_auth._invite_code_hash(code);
    set local role anon;
    perform set_config('request.headers', got, true);
    j2 := public.join_with_invite(code, j_name || 'v', 'join-pass-0001');
    reset role;
    -- a name taken between the join's name check and its insert: fault injection, in this rolled-back transaction only,
    -- through the helper the join calls in between (it takes the name itself, then answers "free", so the join's insert
    -- hits users_username_ci); then restored. Never a trigger on proxima_auth.users: dropping one holds that table
    -- ACCESS EXCLUSIVE until the rollback, which stalled every live session check while this test ran (measured
    -- 2026-10-27 08:26 UTC in pg_locks during a mutation run).
    v_def2 := pg_get_functiondef('proxima_auth._username_taken(text)'::regprocedure);
    execute format($x$create or replace function proxima_auth._username_taken(%s) returns boolean language plpgsql
      security definer set search_path to 'public', 'pg_catalog' as $f$begin
      insert into proxima_auth.users (username, role, scope) values ($1, 'member', 'user:' || $1);
      return false; end$f$$x$, pg_get_function_arguments('proxima_auth._username_taken(text)'::regprocedure));
    set local role anon;
    perform set_config('request.headers', got2, true);
    j3 := public.join_with_invite(code2, j_name || 'u', 'join-pass-0001');
    reset role;
    execute v_def2;   -- the injected account stays until the rollback (its folder row holds it)
    -- the inviting owner changes between the code check and the re-check under its row lock: fault injection, in this
    -- rolled-back transaction only, through the helper the join calls in between (it disables the owner); then restored
    v_def := pg_get_functiondef('proxima_auth._random_code(integer)'::regprocedure);
    execute format($x$create or replace function proxima_auth._random_code(p_len integer) returns text language plpgsql
      set search_path to '' as $f$begin update proxima_auth.users set disabled_at = now() where id = %L::uuid;
      return repeat('A', p_len); end$f$$x$, o);
    set local role anon;
    perform set_config('request.headers', got2, true);
    jg := public.join_with_invite(code2, j_name || 'g', 'join-pass-0001');
    reset role;
    execute v_def;
    update proxima_auth.users set disabled_at = null where id = o;
    update proxima_auth.auth_config set signin_throttle = 'on' where id;
    insert into proxima_auth.signin_throttle (ip_key, window_start, failures, blocked_until, name_keys)
      values (encode(extensions.hmac('198.51.100.91', (select c.throttle_key from proxima_auth.auth_config c where c.id), 'sha256'), 'hex'),
              now(), 99, now() + interval '1 hour', '{}')
      on conflict (ip_key) do update set blocked_until = excluded.blocked_until;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.91', guard), true);
    perform public.join_with_invite(code2, j_name || 't', 'join-pass-0001');
    perform set_config('request.headers', got3, true);
    reset role;
    update proxima_auth.auth_config set signin_throttle = v_mode where id;
    set local role anon;
    perform set_config('request.headers', got3, true);
    j := public.join_with_invite(code2, j_name, 'join-pass-0001');
    reset role;
    joined := (j->>'account_id')::uuid;
    got := pg_temp.evn(v_from, 'join');
    ok := (j->>'ok')::boolean and j2->>'reason' = 'invalid' and j3->>'reason' = 'username_taken' and jg->>'reason' = 'invalid'
      and got = 'join:closedx3,join:invalid_usernamex2,join:weak_passwordx2,join:invalid,join:username_taken,join:invite_voided,join:username_taken,join:invite_creator_gone,join:throttled:T'
      and pg_temp.ev(v_from, joined) = 'join:ok' and pg_temp.ev(v_from, o) = 'reauth:okx2'
      and (select e.net is null and e.agent = ua_text and e.mixed from proxima_auth.signin_events e where e.id > v_from and e.outcome = 'closed')
      and (select e.net is null and e.mixed from proxima_auth.signin_events e where e.id > v_from and e.outcome = 'invalid_username')
      and (select not e.mixed and e.net = pg_temp.net('198.51.100.59') from proxima_auth.signin_events e
            where e.id > v_from and e.account_id = o);
    out := out || case when ok then 'ok H5 join; ' else format('FAIL H5 ok=%s %s | %s | %s; ', j->>'ok', got,
      pg_temp.ev(v_from, joined), pg_temp.ev(v_from, o)) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H5 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H6. Password re-entry (change password, rename, invite, backup code: proxima_auth._reauth) is logged (review M3): two
  --     wrong (x2), the third locks, one more while locked.
  begin
    v_from := pg_temp.maxid();
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = m;
    m_tk := proxima_auth.mint_token(m);
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.62', guard, ua_text, m_tk), true);
    perform public.change_my_password(m_tk, 'bad-1', 'new-pass-0001');
    perform public.change_my_password(m_tk, 'bad-2', 'new-pass-0001');
    perform public.change_my_password(m_tk, 'bad-3', 'new-pass-0001');
    perform public.change_my_password(m_tk, pw, 'new-pass-0001');
    reset role;
    got := pg_temp.ev(v_from, m);
    ok := got = 'reauth:wrong_passwordx2,reauth:locked_now,reauth:locked';
    out := out || case when ok then 'ok H6 reauth; ' else format('FAIL H6 %s; ', got) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H6 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H7. Calls from a blocked network are marked throttled on every branch that can see it: a wrong password, the right one
  --     (a correct password still signs in), an unknown name, an unlock while the backup code is paused (H3), and for
  --     another member: a wrong backup code, the right one with a new password, then that password from an older build.
  begin
    v_from := pg_temp.maxid();
    got := pg_temp.hdr('198.51.100.90', guard);
    -- first the same failure from the same network while it is not blocked: a throttled one never folds into it
    update proxima_auth.auth_config set signin_throttle = 'observe' where id;
    set local role anon;
    perform set_config('request.headers', got, true);
    perform public.verify_admin(o_name, 'wrong-8');
    reset role;
    update proxima_auth.auth_config set signin_throttle = 'on' where id;
    insert into proxima_auth.signin_throttle (ip_key, window_start, failures, blocked_until, name_keys)
      values (encode(extensions.hmac('198.51.100.90', (select c.throttle_key from proxima_auth.auth_config c where c.id), 'sha256'), 'hex'),
              now(), 99, now() + interval '1 hour', '{}')
      on conflict (ip_key) do update set blocked_until = excluded.blocked_until;
    set local role anon;
    perform set_config('request.headers', got, true);
    j := public.verify_admin(o_name, 'wrong-9');
    j2 := public.verify_admin(o_name, pw2);
    perform public.verify_admin('__sh_none4_' || txid_current(), pw);
    perform public.unlock_with_backup_code('__sh_none5_' || txid_current(), 'x', null);
    perform public.unlock_with_backup_code(o_name, 'backup-code-0001', null);
    perform public.unlock_with_backup_code(k_name, 'wrong-code-0000', null);
    j3 := public.unlock_with_backup_code(k_name, 'backup-code-0003', pw3);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.90', oldb), true);
    perform public.verify_admin(k_name, pw3);
    reset role;
    update proxima_auth.auth_config set signin_throttle = v_mode where id;
    got := pg_temp.ev(v_from, o); got2 := pg_temp.evn(v_from, 'signin'); got3 := pg_temp.ev(v_from, k);
    ok := got = 'signin:wrong_password,signin:wrong_password:T,signin:ok:T,unlock:paused:T' and got2 = 'signin:unknown:T'
      and pg_temp.evn(v_from, 'unlock') = 'unlock:unknown:T'
      and got3 = 'unlock:wrong_code:T,unlock:ok_password_reset:T,signin:update_required:T'
      and j->>'reason' = 'throttled' and (j2->>'ok')::boolean and (j3->>'ok')::boolean;
    out := out || case when ok then 'ok H7 throttled-flag; ' else format('FAIL H7 %s | %s | %s reason=%s; ', got, got2, got3, j->>'reason') end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H7 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H8. Reading: only the owner, every account, newest first; a page and the next page (cursor), the last page says no
  --     more; one account; events of no account; each account's last successful sign-in (its kind and network, a reset by
  --     backup code counts); deleted and disabled accounts marked; a member, a malformed token and a disabled owner are
  --     refused.
  begin
    o_tk := proxima_auth.mint_token(o); m_tk := proxima_auth.mint_token(m);
    got3 := pg_temp.net('198.51.100.90');
    n2 := (select count(*) from proxima_auth.users);
    -- the owner's sign-ins and unlocks so far started 2 hours ago: the password re-entry below is newer by more than the
    -- hour the last-sign-in lookup searches before its newest success, so a lookup that let re-entries in would lose the
    -- sign-in (review wf_2d531d87-543: 20 minutes no longer proved it once that window became an hour)
    update proxima_auth.signin_events e set at = now() - interval '2 hours', last_at = now() - interval '2 hours'
     where e.account_id = o and e.kind <> 'reauth';
    -- one row whose latest repeat is apart from its start (H1's x2), so the page's at and last_at cannot be swapped unseen
    update proxima_auth.signin_events e set last_at = now() - interval '90 minutes'
     where e.account_id = o and e.outcome = 'wrong_password' and e.repeats = 2;
    set local role anon;
    -- the owner's newest success is now a password re-entry (an invite): it must not count as a sign-in
    perform set_config('request.headers', pg_temp.hdr('198.51.100.63', guard, ua_text, o_tk), true);
    perform public.create_invite(o_tk, pw2);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.63', guard), true);
    j2 := public.list_signins(m_tk, 50);
    ok := j2->>'reason' = 'forbidden' and j2->'events' is null and j2->'accounts' is null;
    j := public.list_signins(o_tk, 200);
    ids := array(select (x->>'id')::bigint from json_array_elements(j->'events') x);
    ok := ok and (j->>'ok')::boolean and cardinality(ids) > 5
      and ids = array(select unnest(ids) order by 1 desc)
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' = m_name and x->>'outcome' = 'update_required')
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' is null and x->>'outcome' = 'unknown')
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' = o_name and x->>'outcome' = 'locked_now')
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' = o_name and x->>'outcome' = 'wrong_password'
                    and (x->>'repeats')::int = 2 and (x->>'last_at')::bigint >= (x->>'at')::bigint)
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' = j_name and x->>'kind' = 'join');
    j2 := public.list_signins(o_tk, 3);
    ids := array(select (x->>'id')::bigint from json_array_elements(j2->'events') x);
    j3 := public.list_signins(o_tk, 3, ids[3]);
    ids2 := array(select (x->>'id')::bigint from json_array_elements(j3->'events') x);
    ok := ok and cardinality(ids) = 3 and (j2->>'more')::boolean and cardinality(ids2) = 3 and ids2[1] < ids[3]
      and ids2 = array(select unnest(ids2) order by 1 desc)
      -- the next page is exactly the next rows of the full list j (no event skipped or repeated between pages)
      and ids2 = array(select (x->>'id')::bigint from json_array_elements(j->'events') x where (x->>'id')::bigint < ids[3]
                       order by 1 desc limit 3);
    j2 := public.list_signins(o_tk, 200, null, m::text);
    ok := ok and json_array_length(j2->'events') >= 3
      and (select bool_and(x->>'username' = m_name) from json_array_elements(j2->'events') x);
    j2 := public.list_signins(o_tk, 200, null, 'none');
    ok := ok and json_array_length(j2->'events') >= 3
      and (select bool_and(x->>'username' is null and x->>'account_id' is null) from json_array_elements(j2->'events') x);
    j2 := public.list_signins(o_tk, 200, null, 'not-a-uuid');
    ok := ok and j2->>'reason' = 'bad_account';
    -- the owner's last sign-in is H7's (throttled) success, not the newer password re-entry above
    ok := ok and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = o_name and a->>'last_ok_kind' = 'signin'
                           and (a->>'last_ok_at')::bigint = (extract(epoch from now() - interval '2 hours') * 1000)::bigint)
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = m_name and (a->>'last_ok_at') is null)
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = j_name and a->>'last_ok_kind' = 'join')
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = d_name and (a->>'disabled')::boolean)
      and not exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = m_name and (a->>'disabled')::boolean);
    -- every event says whether its repeats came from more than one source; the owner's last sign-in is H7's, from .90;
    -- k's last success is its password reset by backup code (an unlock); the deleted member is marked deleted
    ok := ok and (select bool_and(x->>'mixed' in ('true', 'false') and (x->>'repeats')::int >= 1) from json_array_elements(j->'events') x)
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' is null and x->>'outcome' = 'update_required'
                    and x->>'mixed' = 'true' and (x->>'repeats')::int = 3)
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = o_name and a->>'last_ok_net' = got3
                    and a->>'last_ok_mixed' = 'false')
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = k_name and a->>'last_ok_kind' = 'unlock'
                    and (a->>'last_ok_at') is not null and not (a->>'deleted')::boolean)
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = dl_name and (a->>'deleted')::boolean
                    and (a->>'last_ok_at') is null);
    j2 := public.list_signins(o_tk, 200, null, k::text);
    ok := ok and json_array_length(j2->'events') = 3 and not (j2->>'more')::boolean;
    -- the page's whole contract on known rows (review wf_ca68a06f-ba4): every field of H7's throttled failure of the
    -- owner; H1's folded failure with its start and latest repeat apart; a row of no account; the accounts' ids and
    -- roles, and an id taken from the summary used as the filter; a page of exactly the rest says no more; the limit's
    -- lower clamp
    ok := ok and exists (select 1 from json_array_elements(j->'events') x where x->>'account_id' = o::text and x->>'username' = o_name
                    and x->>'role' = 'owner' and x->>'kind' = 'signin' and x->>'outcome' = 'wrong_password' and x->>'throttled' = 'true'
                    and x->>'net' = got3 and x->>'agent' = ua_text and x->>'client' = guard and (x->>'repeats')::int = 1
                    and x->>'mixed' = 'false'
                    and (x->>'at')::bigint = (extract(epoch from now() - interval '2 hours') * 1000)::bigint
                    and (x->>'last_at')::bigint = (extract(epoch from now() - interval '2 hours') * 1000)::bigint)
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' = o_name and x->>'outcome' = 'wrong_password'
                    and (x->>'repeats')::int = 2
                    and (x->>'at')::bigint = (extract(epoch from now() - interval '2 hours') * 1000)::bigint
                    and (x->>'last_at')::bigint = (extract(epoch from now() - interval '90 minutes') * 1000)::bigint)
      and exists (select 1 from json_array_elements(j->'events') x where x->>'kind' = 'signin' and x->>'outcome' = 'unknown'
                    and x->>'account_id' is null and x->>'username' is null and x->>'role' is null)
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = o_name and a->>'account_id' = o::text
                    and a->>'role' = 'owner')
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = m_name and a->>'account_id' = m::text
                    and a->>'role' = 'member')
      -- the owner comes first in the summary, then the members by name
      and j->'accounts'->0->>'username' = o_name
      -- every account is in the summary, one with no events at all included (H5's injected name: last_ok_at null), and
      -- the page shows a password re-entry and a backup-code unlock with their own kinds (review wf_9d2aac22-a40)
      and json_array_length(j->'accounts') = n2
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = j_name || 'u' and a->>'last_ok_at' is null)
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' = m_name and x->>'kind' = 'reauth'
                    and x->>'outcome' = 'locked_now')
      and exists (select 1 from json_array_elements(j->'events') x where x->>'username' = o_name and x->>'kind' = 'unlock'
                    and x->>'outcome' = 'paused_now')
      and (select array_agg(t.a->>'username' order by t.n) from json_array_elements(j->'accounts') with ordinality t(a, n)
            where t.a->>'role' = 'member')
        = (select array_agg(a->>'username' order by lower(a->>'username')) from json_array_elements(j->'accounts') a
            where a->>'role' = 'member');
    j2 := public.list_signins(o_tk, 200, null, (select a->>'account_id' from json_array_elements(j->'accounts') a where a->>'username' = m_name));
    ok := ok and json_array_length(j2->'events') >= 3 and (select bool_and(x->>'account_id' = m::text) from json_array_elements(j2->'events') x);
    j2 := public.list_signins(o_tk, 3, null, k::text);
    ok := ok and json_array_length(j2->'events') = 3 and not (j2->>'more')::boolean;
    -- paging inside a filtered view (review wf_c11cb64e-cb8): one account's second page holds its older event, and the
    -- events of no account page the same way
    j2 := public.list_signins(o_tk, 2, null, k::text);
    ids := array(select (x->>'id')::bigint from json_array_elements(j2->'events') x);
    j3 := public.list_signins(o_tk, 2, ids[2], k::text);
    ok := ok and cardinality(ids) = 2 and (j2->>'more')::boolean and json_array_length(j3->'events') = 1
      and (j3->'events'->0->>'id')::bigint < ids[2] and j3->'events'->0->>'account_id' = k::text and not (j3->>'more')::boolean;
    j2 := public.list_signins(o_tk, 2, null, 'none');
    ids := array(select (x->>'id')::bigint from json_array_elements(j2->'events') x);
    j3 := public.list_signins(o_tk, 2, ids[2], 'none');
    ok := ok and cardinality(ids) = 2 and (j2->>'more')::boolean and json_array_length(j3->'events') >= 1
      and (select bool_and((x->>'id')::bigint < ids[2] and x->>'account_id' is null) from json_array_elements(j3->'events') x);
    j2 := public.list_signins(o_tk, 0);
    j3 := public.list_signins(o_tk, -5);
    ok := ok and json_array_length(j2->'events') = 1 and (j2->>'more')::boolean and json_array_length(j3->'events') = 1;
    reset role;
    insert into proxima_auth.signin_events (account_id, kind, outcome) select o, 'signin', 'ok' from generate_series(1, 210);
    set local role anon;
    j2 := public.list_signins(o_tk, 100000);
    ok := ok and json_array_length(j2->'events') = 200 and (j2->>'more')::boolean;
    j2 := public.list_signins(o_tk, null);
    ok := ok and json_array_length(j2->'events') = 100 and (j2->>'more')::boolean;
    begin
      j2 := public.list_signins('not-a-token', 10);
      ok := false;
    exception when others then ok := ok and sqlerrm like '%session token%';
    end;
    reset role;
    update proxima_auth.users set disabled_at = now() where id = o;
    set local role anon;
    begin
      j2 := public.list_signins(o_tk, 10);
      ok := ok and j2->>'reason' = 'forbidden';
    exception when others then ok := ok and sqlerrm like '%session%';
    end;
    reset role;
    update proxima_auth.users set disabled_at = null where id = o;
    out := out || case when ok then 'ok H8 owner-only-reads; ' else 'FAIL H8 owner-only-reads; ' end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H8 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H9. Browsers cannot touch the table or call the writer; only list_signins (which checks for the owner) is theirs;
  --     the prune job runs nightly with the 90-day rule.
  begin
    ok := (select bool_and(not has_table_privilege(r, 'proxima_auth.signin_events', p))
             from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
      and (select bool_and(not has_function_privilege(r, 'proxima_auth._log_signin(uuid, text, text, boolean)', 'execute'))
             from unnest(array['anon', 'authenticated', 'service_role']) r)
      and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid = 'proxima_auth._log_signin(uuid, text, text, boolean)'::regprocedure and a.grantee = 0)
      -- the writer and the reader plan each query with its real values (review wf_79964fbc-e0a: a cached generic plan
      -- scanned the whole table when nothing matched, and timed a known name's attempt apart from an unknown one's)
      and (select p.proconfig @> array['plan_cache_mode=force_custom_plan'] from pg_proc p
            where p.oid = 'proxima_auth._log_signin(uuid, text, text, boolean)'::regprocedure)
      and (select p.proconfig @> array['plan_cache_mode=force_custom_plan'] from pg_proc p
            where p.oid = 'public.list_signins(text, integer, bigint, text)'::regprocedure)
      -- the last-sign-in index covers what the summary searches: successes and counted successes, never re-entries
      and pg_get_indexdef('proxima_auth.signin_events_last_ok'::regclass)
          = 'CREATE INDEX signin_events_last_ok ON proxima_auth.signin_events USING btree (account_id, id) WHERE ((kind <> ''reauth''::text) AND (outcome = ANY (ARRAY[''ok''::text, ''ok_password_reset''::text, ''suppressed_ok''::text])))'
      -- no role but the table's owner holds any privilege on it (truncate, trigger and references included)
      and not exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                       where c.oid = 'proxima_auth.signin_events'::regclass and a.grantee <> c.relowner)
      -- the writer never waits on a row another call holds: both of its row picks skip locked rows
      and (select (length(fd.def) - length(replace(fd.def, 'for update skip locked', ''))) / length('for update skip locked') = 2
             from pg_get_functiondef('proxima_auth._log_signin(uuid, text, text, boolean)'::regprocedure) as fd(def))
      -- no column privileges either (has_table_privilege and relacl do not see them)
      and (select bool_and(not has_any_column_privilege(r, 'proxima_auth.signin_events', p))
             from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'references']) p)
      and has_function_privilege('anon', 'public.list_signins(text, integer, bigint, text)', 'execute')
      and has_function_privilege('authenticated', 'public.list_signins(text, integer, bigint, text)', 'execute')
      and (select relrowsecurity from pg_class where oid = 'proxima_auth.signin_events'::regclass)
      and exists (select 1 from cron.job c where c.jobname = 'signin-events-prune' and c.schedule = '23 4 * * *'
                    and c.command = 'delete from proxima_auth.signin_events where at < now() - interval ''90 days''');
    out := out || case when ok then 'ok H9 closed-to-browsers; ' else 'FAIL H9 closed-to-browsers; ' end;
  exception when others then out := out || format('FAIL H9 %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- H10. A row that cannot be written never fails the sign-in it records (here: a kind the table refuses).
  begin
    n := (select count(*) from proxima_auth.signin_events);
    perform proxima_auth._log_signin(null, 'bogus-kind', 'x', false);
    n2 := (select count(*) from proxima_auth.signin_events);
    ok := n = n2;
    out := out || case when ok then 'ok H10 never-breaks; ' else 'FAIL H10 never-breaks; ' end;
  exception when others then out := out || format('FAIL H10 raised %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- H11. Floods (review M1, M2): events of no account get 60 new rows an hour PER KIND, then attempts are counted on one
  --      'suppressed' row; a full sign-in budget leaves joins logged. An account's failures get 30 new rows an hour, then
  --      one counted 'suppressed' row; its success and its lockout are still kept.
  begin
    insert into proxima_auth.signin_events (account_id, kind, outcome) select null, 'signin', 'unknown' from generate_series(1, 60);
    insert into proxima_auth.signin_events (account_id, kind, outcome) select m, 'signin', 'wrong_password' from generate_series(1, 30);
    v_from := pg_temp.maxid();
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = m;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.64', guard), true);
    j := public.verify_admin('__sh_none2_' || txid_current(), pw);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.65', guard), true);
    perform public.verify_admin('__sh_none3_' || txid_current(), pw);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ8', j_name || 'q', 'join-pass-0001');
    perform public.verify_admin(m_name, 'wrong-20');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.66', guard), true);
    perform public.verify_admin(m_name, 'wrong-21');
    j2 := public.verify_admin(m_name, pw);
    reset role;
    update proxima_auth.users set login_failed = 2 where id = m;
    set local role anon;
    perform public.verify_admin(m_name, 'wrong-22');
    reset role;
    got := pg_temp.evn(v_from, 'signin'); got2 := pg_temp.evn(v_from, 'join'); got3 := pg_temp.ev(v_from, m);
    ok := j->>'reason' = 'invalid' and (j2->>'ok')::boolean and got = 'signin:suppressedx2' and got2 = 'join:invalid'
      and got3 = 'signin:suppressedx2,signin:ok,signin:locked_now';
    -- the owner's page shows the counted rows, with their count (review wf_9d2aac22-a40)
    o_tk := proxima_auth.mint_token(o);
    set local role anon;
    j3 := public.list_signins(o_tk, 200, null, 'none');
    reset role;
    ok := ok and exists (select 1 from json_array_elements(j3->'events') x where x->>'kind' = 'signin' and x->>'outcome' = 'suppressed'
                           and (x->>'repeats')::int = 2);
    -- the join budget of no account fills too: 60 join rows in the hour, then the next is the join's own suppressed row
    -- (the seeded rows are removed afterwards, so later cases start below the cap)
    insert into proxima_auth.signin_events (account_id, kind, outcome, client) select null, 'join', 'invalid', 'seed' from generate_series(1, 60);
    v_from := pg_temp.maxid();
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.71', guard), true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ7', j_name || 'q', 'join-pass-0001');
    reset role;
    got2 := got2 || ' / ' || pg_temp.evn(v_from, 'join');
    ok := ok and got2 = 'join:invalid / join:suppressed';
    delete from proxima_auth.signin_events e where e.account_id is null and e.kind = 'join' and e.client = 'seed';
    out := out || case when ok then 'ok H11 flood-caps; ' else format('FAIL H11 %s | %s | %s; ', got, got2, got3) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H11 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H12. Repeats from one network fold even when the browser or the app marker differs: only the field that differs is
  --      cleared, and the row is marked mixed; a browser string is kept at most 300 characters and the app marker at
  --      most 120.
  begin
    v_from := pg_temp.maxid();
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.67', guard, 'Browser A'), true);
    perform public.verify_admin(np_name, 'x');
    perform public.verify_admin(dl_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.67', guard, 'Browser B'), true);
    perform public.verify_admin(np_name, 'x');
    -- a row once mixed stays mixed: a third repeat with no browser string at all (the field already cleared) keeps it
    perform set_config('request.headers', pg_temp.hdr('198.51.100.67', guard, null), true);
    perform public.verify_admin(np_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.67', oldb, 'Browser A'), true);
    perform public.verify_admin(dl_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.68', repeat('C', 200), repeat('A', 400)), true);
    perform public.verify_admin(d_name, 'x');
    -- two accounts' same failure from one network stay two rows
    perform set_config('request.headers', pg_temp.hdr('198.51.100.69', guard), true);
    perform public.verify_admin(k_name, 'x');
    perform public.verify_admin(o_name, 'x');
    reset role;
    ok := pg_temp.ev(v_from, np) = 'signin:no_passwordx3' and pg_temp.ev(v_from, dl) = 'signin:deletedx2'
      and pg_temp.ev(v_from, k) = 'signin:wrong_password' and pg_temp.ev(v_from, o) = 'signin:wrong_password'
      and (select e.agent is null and e.client = guard and e.mixed and e.net = pg_temp.net('198.51.100.67')
             from proxima_auth.signin_events e where e.id > v_from and e.account_id = np)
      and (select e.agent = 'Browser A' and e.client is null and e.mixed and e.net = pg_temp.net('198.51.100.67')
             from proxima_auth.signin_events e where e.id > v_from and e.account_id = dl)
      and (select length(e.agent) = 300 and length(e.client) = 120 and not e.mixed
             from proxima_auth.signin_events e where e.id > v_from and e.account_id = d);
    out := out || case when ok then 'ok H12 fold-and-field-caps; ' else format('FAIL H12 %s; ', pg_temp.ev(v_from, np)) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H12 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H13. With ip_source 'xff-last' the network code hashes the LAST X-Forwarded-For entry (the one the platform added),
  --      exactly as the throttle reads it: not the first entry (the caller's choice) and not cf-connecting-ip. An IPv6
  --      caller is one network per /64 (as the throttle groups it): two addresses in one /64 fold, another /64 does not.
  begin
    v_from := pg_temp.maxid();
    update proxima_auth.auth_config set ip_source = 'xff-last' where id;
    set local role anon;
    perform set_config('request.headers', json_build_object('x-forwarded-for', '203.0.113.7, 198.51.100.70', 'cf-connecting-ip', '198.51.100.99',
      'user-agent', ua_text, 'x-client-info', guard)::text, true);
    perform public.verify_admin(d_name, pw);
    reset role;
    update proxima_auth.auth_config set ip_source = v_src where id;
    v_n := pg_temp.maxid();
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('2001:db8:1:2::5', guard), true);
    perform public.verify_admin(np_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('2001:db8:1:2:aaaa::9', guard), true);
    perform public.verify_admin(np_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('2001:db8:1:3::5', guard), true);
    perform public.verify_admin(np_name, 'x');
    reset role;
    ok := pg_temp.ev(v_from, d) = 'signin:disabled'
      and (select e.net = pg_temp.net('198.51.100.70') from proxima_auth.signin_events e where e.id > v_from and e.account_id = d)
      and pg_temp.ev(v_n, np) = 'signin:no_passwordx2,signin:no_password'
      and (select array_agg(e.net order by e.id) = array[pg_temp.net('2001:db8:1:2::'), pg_temp.net('2001:db8:1:3::')]
             from proxima_auth.signin_events e where e.id > v_n and e.account_id = np);
    out := out || case when ok then 'ok H13 xff-last-net; ' else format('FAIL H13 %s; ', pg_temp.ev(v_from, d)) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H13 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H14. Fold windows, by backdating (review wf_d4f75a17-159 M-C): a failure folds into a row from the same network
  --      started 9 minutes ago, not one started 11 minutes ago, nor one STARTED 15 minutes ago whose latest repeat was 5
  --      minutes ago (the window runs from a row's start: review wf_79964fbc-e0a M, the last-sign-in summary relies on
  --      it); a shape refusal folds from any network into a row started 59 minutes ago, not one started 61 minutes ago.
  begin
    v_from := pg_temp.maxid();
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = k;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.72', guard), true);
    perform public.verify_admin(k_name, 'wrong-30');
    reset role;
    update proxima_auth.signin_events e set at = now() - interval '11 minutes', last_at = now() - interval '11 minutes'
     where e.id > v_from and e.account_id = k;
    set local role anon;
    perform public.verify_admin(k_name, 'wrong-31');
    reset role;
    update proxima_auth.users set login_failed = 0 where id = k;
    update proxima_auth.signin_events e set at = now() - interval '9 minutes', last_at = now() - interval '9 minutes'
     where e.id = pg_temp.maxid() and e.account_id = k;
    set local role anon;
    perform public.verify_admin(k_name, 'wrong-32');
    reset role;
    update proxima_auth.users set login_failed = 0 where id = k;
    -- started 15 minutes ago, latest repeat 5 minutes ago: past the 10 minutes from its start, so a new row
    v_n := pg_temp.maxid();
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.87', guard), true);
    perform public.verify_admin(k_name, 'wrong-33');
    reset role;
    update proxima_auth.signin_events e set at = now() - interval '15 minutes', last_at = now() - interval '5 minutes', repeats = 3
     where e.id > v_n and e.account_id = k;
    set local role anon;
    perform public.verify_admin(k_name, 'wrong-34');
    reset role;
    update proxima_auth.users set login_failed = 0 where id = k;
    got := pg_temp.ev(v_from, k);
    -- a repeat keeps the row's start: the row started 9 minutes ago still started then (review wf_9d2aac22-a40)
    got3 := (select case when e.at = now() - interval '9 minutes' and e.last_at = now() then 'start kept' else 'start moved' end
               from proxima_auth.signin_events e where e.id > v_from and e.account_id = k and e.repeats = 2);
    -- started 61 minutes ago, latest repeat 5 minutes ago: the shape hour runs from the start too
    update proxima_auth.signin_events e set at = now() - interval '61 minutes', last_at = now() - interval '5 minutes'
     where e.account_id is null and e.kind = 'join' and e.outcome = 'invalid_username';
    v_from := pg_temp.maxid();
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.73', guard), true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ6', '!', 'join-pass-0001');
    reset role;
    update proxima_auth.signin_events e set at = now() - interval '59 minutes', last_at = now() - interval '59 minutes'
     where e.id > v_from and e.account_id is null;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.74', guard), true);
    perform public.join_with_invite('ZZZZ-ZZZZ-ZZZZ-ZZZ6', '!', 'join-pass-0001');
    reset role;
    got2 := pg_temp.evn(v_from, 'join');
    ok := got = 'signin:wrong_password,signin:wrong_passwordx2,signin:wrong_passwordx3,signin:wrong_password'
      and got2 = 'join:invalid_usernamex2' and got3 = 'start kept';
    out := out || case when ok then 'ok H14 fold-windows; ' else format('FAIL H14 %s | %s | %s; ', got, got2, got3) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H14 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H15. Caps count the last hour, per class (review wf_d4f75a17-159 M-A, M-B): 30 failures of an account 61 minutes ago
  --      do not count; 30 in the hour turn the next failure into a counted 'suppressed' row, one an hour per account and
  --      kind (a suppressed row 61 minutes old is not added to; an unlock gets its own); a password reset by backup code
  --      is a success (still logged at the failure cap); a lock moment is its own class (still logged at the failure
  --      cap), and 30 of those make 'suppressed_lock'.
  begin
    update proxima_auth.signin_events e set at = now() - interval '2 hours', last_at = now() - interval '2 hours' where e.account_id = k;
    -- started 61 minutes ago, latest repeat 30 minutes ago: a cap counts rows by their START (review wf_79964fbc-e0a)
    insert into proxima_auth.signin_events (account_id, kind, outcome, client, at, last_at)
      select k, 'signin', 'wrong_password', 'seed', now() - interval '61 minutes', now() - interval '30 minutes' from generate_series(1, 30);
    v_from := pg_temp.maxid();
    update proxima_auth.users set login_failed = 0, login_locked_at = null, backup_failed = 0, backup_locked_until = null where id = k;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.80', guard), true);
    perform public.verify_admin(k_name, 'wrong-40');
    reset role;
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'signin', 'wrong_password', 'seed' from generate_series(1, 28);
    -- one of them started 59 minutes ago: still inside the cap's hour (review wf_9d2aac22-a40)
    insert into proxima_auth.signin_events (account_id, kind, outcome, client, at, last_at)
      values (k, 'signin', 'wrong_password', 'seed', now() - interval '59 minutes', now() - interval '59 minutes');
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.81', guard), true);
    perform public.verify_admin(k_name, 'wrong-41');
    reset role;
    update proxima_auth.users set login_failed = 0 where id = k;
    -- the counted row started 61 minutes ago (latest attempt a minute ago): the next attempt starts a new one
    update proxima_auth.signin_events e set at = now() - interval '61 minutes', last_at = now() - interval '1 minute'
     where e.id > v_from and e.account_id = k and e.outcome = 'suppressed';
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.82', guard), true);
    perform public.verify_admin(k_name, 'wrong-42');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.83', guard), true);
    j := public.unlock_with_backup_code(k_name, 'wrong-code-0040', null);
    -- at the failure cap, a password reset by backup code is a success: its own row, not counted as a failure
    perform set_config('request.headers', pg_temp.hdr('198.51.100.86', guard), true);
    j3 := public.unlock_with_backup_code(k_name, 'backup-code-0003', pw3);
    reset role;
    -- 30 attempts while locked in the hour are failures, not lock moments: the pause below is still its own row
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'signin', 'locked', 'seed' from generate_series(1, 30);
    update proxima_auth.users set backup_failed = 4 where id = k;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.84', guard), true);
    j2 := public.unlock_with_backup_code(k_name, 'wrong-code-0041', null);
    reset role;
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'signin', 'locked_now', 'seed' from generate_series(1, 29);
    update proxima_auth.users set login_failed = 2, login_locked_at = null where id = k;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.85', guard), true);
    perform public.verify_admin(k_name, 'wrong-43');
    reset role;
    update proxima_auth.users set login_failed = 0, login_locked_at = null, backup_failed = 0, backup_locked_until = null where id = k;
    got := pg_temp.ev(v_from, k);
    ok := got = 'signin:wrong_password,signin:suppressed,signin:suppressed,unlock:suppressed,unlock:ok_password_reset,unlock:paused_now,signin:suppressed_lock'
      and j->>'reason' = 'invalid' and j2->>'reason' = 'invalid' and (j3->>'ok')::boolean;
    out := out || case when ok then 'ok H15 cap-windows-classes; ' else format('FAIL H15 %s; ', got) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H15 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H16. Successes fold and are capped too (review wf_d4f75a17-159 M-A): three sign-ins from one network are one row
  --      (x3), an unlock from it its own row (kind), another network its own; the account's last sign-in is the latest
  --      one even when an older row got that repeat (here from another browser: mixed, browser cleared); 30 successes in
  --      the hour make 'suppressed_ok'; suppressed rows never count toward a cap (29 failures + that row: the next
  --      failure is still its own row). Review wf_79964fbc-e0a M: the account's 30 password re-entries in the hour use
  --      none of its sign-in rows; past the limit the last sign-in is the counted row's (flagged, its network kept), and
  --      a counted row folds its source like any row (a second network clears it, mixed).
  begin
    update proxima_auth.signin_events e set at = now() - interval '2 hours', last_at = now() - interval '2 hours' where e.account_id = k;
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = k;
    v_from := pg_temp.maxid();
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'reauth', 'ok', 'seed' from generate_series(1, 30);
    o_tk := proxima_auth.mint_token(o);
    got2 := pg_temp.net('198.51.100.76'); got3 := pg_temp.net('198.51.100.78');
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.76', guard), true);
    for n in 1..3 loop perform public.verify_admin(k_name, pw3); end loop;
    j2 := public.unlock_with_backup_code(k_name, 'backup-code-0003', null);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.77', guard), true);
    perform public.verify_admin(k_name, pw3);
    reset role;
    update proxima_auth.signin_events e set at = now() - interval '5 minutes', last_at = now() - interval '5 minutes'
     where e.id > v_from and e.account_id = k and e.net = got2;
    update proxima_auth.signin_events e set at = now() - interval '3 minutes', last_at = now() - interval '3 minutes'
     where e.id > v_from and e.account_id = k and e.net is distinct from got2;
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.76', guard, 'Browser Z'), true);
    perform public.verify_admin(k_name, pw3);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.78', guard), true);
    j := public.list_signins(o_tk, 10, null, k::text);
    reset role;
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'signin', 'ok', 'seed' from generate_series(1, 27);
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.78', guard), true);
    perform public.verify_admin(k_name, pw3);
    j3 := public.list_signins(o_tk, 10, null, k::text);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.89', guard), true);
    perform public.verify_admin(k_name, pw3);
    reset role;
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'signin', 'wrong_password', 'seed' from generate_series(1, 29);
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.79', guard), true);
    perform public.verify_admin(k_name, 'wrong-50');
    reset role;
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = k;
    got := pg_temp.ev(v_from, k);
    ok := got = 'signin:okx4,unlock:ok,signin:ok,signin:suppressed_okx2,signin:wrong_password' and (j2->>'ok')::boolean
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = k_name and a->>'last_ok_net' = got2
                    and a->>'last_ok_agent' is null and a->>'last_ok_mixed' = 'true' and a->>'last_ok_kind' = 'signin'
                    and a->>'last_ok_counted' = 'false'
                    and (a->>'last_ok_at')::bigint = (extract(epoch from now()) * 1000)::bigint)
      -- past the limit: the counted row is the last sign-in, flagged, with the network of its (so far one) source
      and exists (select 1 from json_array_elements(j3->'accounts') a where a->>'username' = k_name and a->>'last_ok_counted' = 'true'
                    and a->>'last_ok_net' = got3 and a->>'last_ok_agent' = ua_text and a->>'last_ok_kind' = 'signin'
                    and (a->>'last_ok_at')::bigint = (extract(epoch from now()) * 1000)::bigint)
      -- a second network folded into the counted row: network cleared, browser and app kept, mixed
      and (select e.net is null and e.agent = ua_text and e.client = guard and e.mixed and e.repeats = 2
             from proxima_auth.signin_events e where e.id > v_from and e.account_id = k and e.outcome = 'suppressed_ok');
    out := out || case when ok then 'ok H16 successes; ' else format('FAIL H16 %s; ', got) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H16 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H17. The last sign-in shown is the latest even when it was counted on a row past the limit that STARTED 59 minutes
  --      58 seconds before the newest ordinary sign-in row: a counted row takes repeats for an hour from its start, so
  --      the summary searches the hour before its newest success row (review wf_79964fbc-e0a); a search of 59 min 58 s
  --      or less fails this case (reviews wf_2d531d87-543, wf_ca68a06f-ba4). Here the account is back at its cap (29
  --      rows 50 minutes ago + one a second ago), so the next sign-in folds into the counted row started 59 min 59 s ago.
  begin
    update proxima_auth.signin_events e set at = now() - interval '2 hours', last_at = now() - interval '2 hours' where e.account_id = k;
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = k;
    insert into proxima_auth.signin_events (account_id, kind, outcome, client, at, last_at)
      select k, 'signin', 'ok', 'seed', now() - interval '50 minutes', now() - interval '50 minutes' from generate_series(1, 29);
    insert into proxima_auth.signin_events (account_id, kind, outcome, at, last_at)
      values (k, 'signin', 'suppressed_ok', now() - interval '59 minutes 59 seconds', now() - interval '59 minutes 59 seconds')
      returning id into v_n;
    insert into proxima_auth.signin_events (account_id, kind, outcome, at, last_at, net)
      values (k, 'signin', 'ok', now() - interval '1 second', now() - interval '1 second', pg_temp.net('198.51.100.92'));
    v_from := pg_temp.maxid();
    o_tk := proxima_auth.mint_token(o);
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.93', guard), true);
    perform public.verify_admin(k_name, pw3);
    j := public.list_signins(o_tk, 10, null, k::text);
    reset role;
    got := pg_temp.ev(v_from, k);
    ok := got = ''
      and (select e.repeats = 2 and e.last_at = now() and e.at = now() - interval '59 minutes 59 seconds'
             from proxima_auth.signin_events e where e.id = v_n)
      and exists (select 1 from json_array_elements(j->'accounts') a where a->>'username' = k_name and a->>'last_ok_counted' = 'true'
                    and (a->>'last_ok_at')::bigint = (extract(epoch from now()) * 1000)::bigint);
    out := out || case when ok then 'ok H17 counted-last-sign-in; ' else format('FAIL H17 [%s]; ', got) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H17 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H18. An account's password re-entries have their own hourly rows, both ways (review wf_2d531d87-543; H16 covers
  --      re-entries not using up sign-in rows): 30 sign-in failures in the hour leave a re-entry failure its own row,
  --      and 30 re-entry successes in the hour make the next one a counted 'suppressed_ok' re-entry row.
  begin
    update proxima_auth.signin_events e set at = now() - interval '2 hours', last_at = now() - interval '2 hours' where e.account_id = k;
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = k;
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'signin', 'wrong_password', 'seed' from generate_series(1, 30);
    v_from := pg_temp.maxid();
    perform set_config('request.headers', pg_temp.hdr('198.51.100.94', guard), true);
    got2 := proxima_auth._reauth(k, 'wrong-60');
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select k, 'reauth', 'ok', 'seed' from generate_series(1, 30);
    got3 := proxima_auth._reauth(k, pw3);
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = k;
    got := pg_temp.ev(v_from, k);
    ok := got = 'reauth:wrong_password,reauth:suppressed_ok' and got2 = 'invalid' and got3 = 'ok';
    out := out || case when ok then 'ok H18 reauth-budget; ' else format('FAIL H18 %s | %s %s; ', got, got2, got3) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H18 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H19. Repeats from a caller that leaves a header out still fold and count (review wf_9d2aac22-a40: a null-unsafe
  --      comparison would break the update, and the writer swallows the error, so the repeat would vanish): no browser
  --      string twice (one row x2, not mixed), no app marker twice (the same), no browser string then one (x2, mixed,
  --      browser cleared), and no address at all twice (no network code, one row x2).
  begin
    v_from := pg_temp.maxid();
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.101', guard, null), true);
    perform public.verify_admin(np_name, 'x');
    perform public.verify_admin(np_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.102', null), true);
    perform public.verify_admin(np_name, 'x');
    perform public.verify_admin(np_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.103', guard, null), true);
    perform public.verify_admin(np_name, 'x');
    perform set_config('request.headers', pg_temp.hdr('198.51.100.103', guard), true);
    perform public.verify_admin(np_name, 'x');
    perform set_config('request.headers', pg_temp.hdr(null, guard), true);
    perform public.verify_admin(np_name, 'x');
    perform public.verify_admin(np_name, 'x');
    reset role;
    got := pg_temp.ev(v_from, np);
    ok := got = 'signin:no_passwordx2,signin:no_passwordx2,signin:no_passwordx2,signin:no_passwordx2'
      and (select array_agg(e.mixed order by e.id) = array[false, false, true, false]
                  and array_agg(e.agent is null order by e.id) = array[true, false, true, false]
                  and array_agg(e.client is null order by e.id) = array[false, true, false, false]
                  and array_agg(e.net is null order by e.id) = array[false, false, false, true]
             from proxima_auth.signin_events e where e.id > v_from and e.account_id = np);
    out := out || case when ok then 'ok H19 missing-headers; ' else format('FAIL H19 %s; ', got) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H19 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- H20. The no-account cap is exactly 60 a kind in the hour (review wf_9d2aac22-a40): with 59 unlock rows of no account
  --      in the hour, the next is its own row (the 60th) and the one after is counted.
  begin
    update proxima_auth.signin_events e set at = now() - interval '2 hours', last_at = now() - interval '2 hours'
     where e.account_id is null and e.kind = 'unlock';
    insert into proxima_auth.signin_events (account_id, kind, outcome, client)
      select null, 'unlock', 'unknown', 'seed' from generate_series(1, 59);
    v_from := pg_temp.maxid();
    set local role anon;
    perform set_config('request.headers', pg_temp.hdr('198.51.100.105', guard), true);
    perform public.unlock_with_backup_code('__sh_none6_' || txid_current(), 'x', null);
    perform set_config('request.headers', pg_temp.hdr('198.51.100.106', guard), true);
    perform public.unlock_with_backup_code('__sh_none7_' || txid_current(), 'x', null);
    reset role;
    got := pg_temp.evn(v_from, 'unlock');
    ok := got = 'unlock:unknown,unlock:suppressed';
    out := out || case when ok then 'ok H20 no-account-cap-edge; ' else format('FAIL H20 %s; ', got) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL H20 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  begin update proxima_auth.auth_config set members_open = v_open, signin_throttle = v_mode, ip_source = v_src where id; exception when others then null; end;
  raise exception 'RESULT: %', out;
end $t$;
