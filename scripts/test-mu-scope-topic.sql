-- M2 gate (RLS session; docs/P1-AUTH-DESIGN.md §4 rows session_scope and sync_topic): proxima_auth.session_scope with
-- both token formats, and proxima_auth.sync_topic on the owner row. Members __m2_a and __m2_b exist only inside this
-- rolled-back block (no member account may exist before P5). Browser calls run as anon, the way PostgREST runs them.
--   (From M4, marked by set_admin_credentials_rehash being gone, the owner's 'admin:' token must instead be refused with
--   'session token revoked' in S4, R5 and T7.)
--   S  scope: A's and B's 'u:' tokens give their own scope, the owner's 'u:' and 'admin:' tokens the owner's; no
--      header, an unparsable header and every bad token are refused with 28000 and the verifier's message; disabling
--      A or bumping A's epoch revokes A only; a token minted after the bump works.
--   R  rows: with A's session only A's rows are visible or changeable and A cannot write into B's or the owner's
--      scope; B and the owner (both formats) see only their own.
--   T  topic: the owner row's epoch and name rotate it, a member's epoch does not; it equals the topic of the frozen
--      app_secrets rows while the owner row still matches them; get_my_account hands it to the owner only.
--   G  STABLE, SECURITY DEFINER, search_path '', owner and grants unchanged; the M2 bodies are live.
-- Run: node scripts/tools/sql-tx.mjs <M1> <M2> --test scripts/test-mu-scope-topic.sql (all PASS), or alone once M2 is
-- live. With M1 alone: FAIL on S1-S3, S10, S12, S13, R1-R4 and R5 for B and owner u: (u: tokens), T3, T5 and G3.
-- Before M1: one FAIL. Also run with the owner moving between M1 and M2 (review round 18 #1: M2 must still apply, and
-- the topic rotates once); both all PASS, with T2 reporting n/a:
--   node scripts/tools/sql-tx.mjs <M1> scripts/fixtures/mu-owner-unlock.sql <M2> --test scripts/test-mu-scope-topic.sql
--   node scripts/tools/sql-tx.mjs <M1> scripts/fixtures/mu-owner-rename.sql <M2> --test scripts/test-mu-scope-topic.sql
-- Tokens live in variables only; only labels and error messages are printed.
do $st$
declare
  r text[] := '{}';
  p text := '__m2_' || txid_current();
  a_id constant uuid := '6d320000-0000-4000-8000-0000000000a1';
  b_id constant uuid := '6d320000-0000-4000-8000-0000000000b1';
  a_scope constant text := 'user:__m2_a';
  b_scope constant text := 'user:__m2_b';
  o_id uuid; o_name text; o_scope text; o_epoch bigint;
  v_exp timestamptz; t_a text; t_b text; t_ou text; t_oa text; t text; v text; n int; t0 text; i int;
  lbl text[]; tok text[]; want text[];
  -- From M4 the owner's 'admin:' token is refused ('session token revoked'). M4 drops set_admin_credentials_rehash, the
  -- marker test-mu-auth uses too; S4, R5 and T7 follow it.
  m4 boolean := to_regprocedure('public.set_admin_credentials_rehash(text,text)') is null;
  -- From P4's per-account topic (20261025200000) a member gets its own topic; T7 follows it.
  p4_topic boolean := to_regprocedure('proxima_auth.account_topic(uuid)') is not null;
  a_topic text;   -- member A's own topic (P4), read before T7 switches to anon
begin
  if to_regclass('proxima_auth.users') is null then
    raise exception 'RESULT: 0 PASS, 1 FAIL :: FAIL M1 not applied (no proxima_auth.users)';
  end if;
  select u.id, u.username, u.scope, u.sessions_valid_after into o_id, o_name, o_scope, o_epoch
    from proxima_auth.users u where u.role = 'owner';
  insert into proxima_auth.users (id, username, role, scope)
    values (a_id, '__m2_a', 'member', a_scope), (b_id, '__m2_b', 'member', b_scope);
  t_a := proxima_auth.mint_token(a_id);
  t_b := proxima_auth.mint_token(b_id);
  v_exp := to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, o_epoch + 1) + 43200);
  t_ou := public._sign_session_token('u:' || o_id::text, v_exp);
  t_oa := public._sign_session_token('admin:' || o_name, v_exp);

  -- S1-S4: each token gives its own account's scope.
  lbl := array['A u:', 'B u:', 'owner u:', 'owner admin:'];
  tok := array[t_a, t_b, t_ou, t_oa];
  want := array[a_scope, b_scope, o_scope, o_scope];
  for i in 1..4 loop
    perform set_config('request.headers', json_build_object('x-proxima-session', tok[i])::text, true);
    execute 'set local role anon';
    begin
      v := proxima_auth.session_scope(true);
      if i = 4 and m4 then
        r := r || text 'FAIL S4 owner admin: accepted after M4';
      else
        r := r || format('%s S%s %s own scope', case when v = want[i] then 'PASS' else 'FAIL' end, i, lbl[i]);
      end if;
    exception when others then
      if i = 4 and m4 and sqlstate = '28000' and sqlerrm = 'session token revoked' then
        r := r || text 'PASS S4 owner admin: revoked from M4';
      else
        r := r || format('FAIL S%s %s: %s %s', i, lbl[i], sqlstate, sqlerrm);
      end if;
    end;
    execute 'reset role';
  end loop;

  -- S5-S7: no header, optional no header, unparsable header.
  execute 'set local role anon';
  perform set_config('request.headers', '{}', true);
  begin
    perform proxima_auth.session_scope(true);
    r := r || text 'FAIL S5 no header passed';
  exception when others then
    r := r || format('%s S5 no header refused%s', case when sqlstate = '28000' and sqlerrm = 'session token missing' then 'PASS' else 'FAIL' end,
                     case when sqlstate = '28000' and sqlerrm = 'session token missing' then '' else ': ' || sqlstate || ' ' || sqlerrm end);
  end;
  r := r || format('%s S6 optional no header is null', case when proxima_auth.session_scope(false) is null then 'PASS' else 'FAIL' end);
  perform set_config('request.headers', 'not json', true);
  begin
    perform proxima_auth.session_scope(true);
    r := r || text 'FAIL S7 unparsable header passed';
  exception when others then
    r := r || format('%s S7 unparsable header refused%s', case when sqlstate = '28000' and sqlerrm = 'session token missing' then 'PASS' else 'FAIL' end,
                     case when sqlstate = '28000' and sqlerrm = 'session token missing' then '' else ': ' || sqlstate || ' ' || sqlerrm end);
  end;
  execute 'reset role';

  -- S8: every bad token is refused with 28000 and the verifier's message.
  lbl := array['forged', 'expired', 'unknown u:', 'bad uuid', 'other subject', 'admin: not owner', 'garbage'];
  tok := array[left(t_a, -1) || case right(t_a, 1) when '0' then '1' else '0' end,
               public._sign_session_token('u:' || a_id::text, now() - interval '1 minute'),
               public._sign_session_token('u:' || gen_random_uuid()::text, v_exp),
               public._sign_session_token('u:not-a-uuid', v_exp),
               public._sign_session_token('svc:__m2', v_exp),
               public._sign_session_token('admin:__m2_a', v_exp),
               'garbage'];
  want := array['invalid signature', 'session token expired', 'session token revoked', 'malformed session token',
                'malformed session token', 'session token revoked', 'malformed session token'];
  execute 'set local role anon';
  for i in 1..cardinality(lbl) loop
    perform set_config('request.headers', json_build_object('x-proxima-session', tok[i])::text, true);
    begin
      perform proxima_auth.session_scope(true);
      r := r || format('FAIL S8 %s passed', lbl[i]);
    exception when others then
      r := r || format('%s S8 %s%s', case when sqlstate = '28000' and sqlerrm = want[i] then 'PASS' else 'FAIL' end, lbl[i],
                       case when sqlstate = '28000' and sqlerrm = want[i] then '' else ': ' || sqlstate || ' ' || sqlerrm end);
    end;
  end loop;
  execute 'reset role';

  -- S9-S13: disabling A or bumping A's epoch revokes A only; a token minted after the bump works.
  for i in 1..2 loop
    if i = 1 then
      update proxima_auth.users set disabled_at = now() where id = a_id;
    else
      update proxima_auth.users set disabled_at = null, sessions_valid_after = extract(epoch from clock_timestamp())::bigint + 60 where id = a_id;
      t := proxima_auth.mint_token(a_id);
    end if;
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', t_a)::text, true);
    begin
      perform proxima_auth.session_scope(true);
      r := r || format('FAIL S%s A passed after %s', 7 + 2 * i, case i when 1 then 'disable' else 'epoch bump' end);
    exception when others then
      r := r || format('%s S%s A refused after %s%s', case when sqlstate = '28000' and sqlerrm = 'session token revoked' then 'PASS' else 'FAIL' end,
                       7 + 2 * i, case i when 1 then 'disable' else 'epoch bump' end,
                       case when sqlstate = '28000' and sqlerrm = 'session token revoked' then '' else ': ' || sqlstate || ' ' || sqlerrm end);
    end;
    perform set_config('request.headers', json_build_object('x-proxima-session', t_b)::text, true);
    begin
      r := r || format('%s S%s B unaffected', case when proxima_auth.session_scope(true) = b_scope then 'PASS' else 'FAIL' end, 8 + 2 * i);
    exception when others then
      r := r || format('FAIL S%s B unaffected: %s %s', 8 + 2 * i, sqlstate, sqlerrm);
    end;
    execute 'reset role';
  end loop;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', t)::text, true);
  begin
    r := r || format('%s S13 A minted after the bump', case when proxima_auth.session_scope(true) = a_scope then 'PASS' else 'FAIL' end);
  exception when others then
    r := r || format('FAIL S13 A minted after the bump: %s %s', sqlstate, sqlerrm);
  end;
  execute 'reset role';
  update proxima_auth.users set sessions_valid_after = 0 where id = a_id;   -- t_a is valid again for R

  -- R1-R5: rows by session (owner role seeds one task per scope).
  insert into public.tasks (id, device_id, status)
    values (p || '_a', a_scope, 'completed'), (p || '_b', b_scope, 'completed'), (p || '_o', o_scope, 'completed');
  perform set_config('request.headers', json_build_object('x-proxima-session', t_a)::text, true);
  execute 'set local role anon';
  begin
    select string_agg(substring(x.id from length(p) + 2), ',' order by x.id) into v from public.tasks x where left(x.id, length(p)) = p;
    r := r || format('%s R1 A sees only its own (%s)', case when v = 'a' then 'PASS' else 'FAIL' end, coalesce(v, 'none'));
    update public.tasks set status = 'failed' where id in (p || '_b', p || '_o');
    get diagnostics n = row_count;
    r := r || format('%s R2 A changes no other scope (%s)', case when n = 0 then 'PASS' else 'FAIL' end, n);
    insert into public.tasks (id, device_id, status) values (p || '_a2', a_scope, 'completed');
    r := r || text 'PASS R3 A writes its own scope';
  exception when others then
    r := r || format('FAIL R1-R3 as A: %s %s', sqlstate, sqlerrm);
  end;
  lbl := array['B''s', 'the owner''s'];
  want := array[b_scope, o_scope];
  for i in 1..2 loop
    begin
      insert into public.tasks (id, device_id, status) values (p || '_x' || i, want[i], 'completed');
      r := r || format('FAIL R4 A wrote into %s scope', lbl[i]);
    exception when others then
      r := r || format('%s R4 A cannot write %s scope%s', case when sqlstate = '42501' then 'PASS' else 'FAIL' end, lbl[i],
                       case when sqlstate = '42501' then '' else ': ' || sqlstate || ' ' || sqlerrm end);
    end;
  end loop;
  execute 'reset role';
  lbl := array['B', 'owner u:', 'owner admin:'];
  tok := array[t_b, t_ou, t_oa];
  want := array['b', 'o', 'o'];
  for i in 1..3 loop
    perform set_config('request.headers', json_build_object('x-proxima-session', tok[i])::text, true);
    execute 'set local role anon';
    begin
      select string_agg(substring(x.id from length(p) + 2), ',' order by x.id) into v from public.tasks x where left(x.id, length(p)) = p;
      if i = 3 and m4 then
        r := r || text 'FAIL R5 owner admin: read after M4';
      else
        r := r || format('%s R5 %s sees only its own (%s)', case when v = want[i] then 'PASS' else 'FAIL' end, lbl[i], coalesce(v, 'none'));
      end if;
    exception when others then
      if i = 3 and m4 and sqlstate = '28000' and sqlerrm = 'session token revoked' then
        r := r || text 'PASS R5 owner admin: refused from M4';
      else
        r := r || format('FAIL R5 %s: %s %s', lbl[i], sqlstate, sqlerrm);
      end if;
    end;
    execute 'reset role';
  end loop;
  perform set_config('request.headers', '', true);

  -- T1-T9: the topic.
  t0 := proxima_auth.sync_topic();
  r := r || format('%s T1 topic shape', case when t0 ~ '^proxima-sync-[0-9a-f]{64}$' then 'PASS' else 'FAIL' end);
  if (select value->>'username' from public.app_secrets where key = 'admin_username') is not distinct from o_name
     and (select value->>'at' from public.app_secrets where key = 'admin_sessions_valid_after') is not distinct from (o_epoch + 1)::text then
    v := 'proxima-sync-' || encode(extensions.hmac(
           'sync-ping:'
             || coalesce((select value->>'username' from public.app_secrets where key = 'admin_username'), '')
             || ':' || coalesce((select value->>'at' from public.app_secrets where key = 'admin_sessions_valid_after'), '0'),
           (select value->>'key' from public.app_secrets where key = 'session_signing_key'), 'sha256'), 'hex');
    r := r || format('%s T2 topic = frozen rows'' topic', case when t0 = v then 'PASS' else 'FAIL' end);
  else
    r := r || text 'PASS T2 n/a (owner row changed since M1)';
  end if;
  update proxima_auth.users set sessions_valid_after = sessions_valid_after + 1 where id = o_id;
  r := r || format('%s T3 owner epoch rotates it', case when proxima_auth.sync_topic() is distinct from t0 then 'PASS' else 'FAIL' end);
  update proxima_auth.users set sessions_valid_after = o_epoch where id = o_id;
  r := r || format('%s T4 epoch restored, topic restored', case when proxima_auth.sync_topic() = t0 then 'PASS' else 'FAIL' end);
  update proxima_auth.users set username = o_name || 'm2', scope = 'user:' || o_name || 'm2' where id = o_id;
  r := r || format('%s T5 owner rename rotates it', case when proxima_auth.sync_topic() is distinct from t0 then 'PASS' else 'FAIL' end);
  update proxima_auth.users set username = o_name, scope = o_scope where id = o_id;
  update proxima_auth.users set sessions_valid_after = sessions_valid_after + 100 where id = a_id;
  r := r || format('%s T6 member epoch leaves it', case when proxima_auth.sync_topic() = t0 then 'PASS' else 'FAIL' end);
  update proxima_auth.users set sessions_valid_after = 0 where id = a_id;
  if p4_topic then execute 'select proxima_auth.account_topic($1)' into a_topic using a_id; end if;
  execute 'set local role anon';
  begin
    begin
      v := public.get_my_account(t_oa)->>'sync_topic';
    exception when others then
      v := case when sqlerrm = 'session token revoked' then 'revoked' else 'error ' || sqlstate end;
    end;
    r := r || format('%s T7 get_my_account: owner topic (u:%s), member %s',
      case when public.get_my_account(t_ou)->>'sync_topic' = t0
                and case when p4_topic then public.get_my_account(t_a)->>'sync_topic' = a_topic and a_topic <> t0
                         else public.get_my_account(t_a)->>'sync_topic' is null end
                and case when m4 then v = 'revoked' else v = t0 end then 'PASS' else 'FAIL' end,
      case when m4 then '; admin: revoked from M4' else ' and admin:' end,
      case when p4_topic then 'its own (P4)' else 'null' end);
  exception when others then
    r := r || format('FAIL T7 get_my_account: %s %s', sqlstate, sqlerrm);
  end;
  begin
    perform proxima_auth.sync_topic();
    r := r || text 'FAIL T8 anon called sync_topic';
  exception when others then
    r := r || format('%s T8 anon cannot call sync_topic', case when sqlstate = '42501' then 'PASS' else 'FAIL' end);
  end;
  execute 'reset role';

  -- G1-G3: attributes, grants, and the M2 bodies.
  select count(*) into n from pg_proc x
   where x.oid in ('proxima_auth.session_scope(boolean)'::regprocedure, 'proxima_auth.sync_topic()'::regprocedure)
     and x.provolatile = 's' and x.prosecdef and x.proconfig = array['search_path=""'] and pg_get_userbyid(x.proowner) = 'postgres';
  r := r || format('%s G1 stable definer search_path owner (%s of 2)', case when n = 2 then 'PASS' else 'FAIL' end, n);
  r := r || format('%s G2 grants unchanged', case
    when (select x.proacl::text from pg_proc x where x.oid = 'proxima_auth.session_scope(boolean)'::regprocedure) = '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres}'
     and (select x.proacl::text from pg_proc x where x.oid = 'proxima_auth.sync_topic()'::regprocedure) = '{postgres=X/postgres}'
    then 'PASS' else 'FAIL' end);
  r := r || format('%s G3 M2 bodies live', case
    when pg_get_functiondef('proxima_auth.session_scope(boolean)'::regprocedure) ~ 'proxima_auth\.current_account\('
     and pg_get_functiondef('proxima_auth.sync_topic()'::regprocedure) ~ 'proxima_auth\.users'
    then 'PASS' else 'FAIL' end);

  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(r) x where x like 'PASS%'), (select count(*) from unnest(r) x where x like 'FAIL%'),
    array_to_string(r, ' | ');
end $st$;
