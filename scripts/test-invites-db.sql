-- Tests for supabase/migrations/20261026500000_mu_p5_invites.sql: joining by invite (docs/SECOND-ACCOUNT-PLAN.md K7).
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261026500000_mu_p5_invites.sql --test scripts/test-invites-db.sql
-- One DO block, always rolled back by sql-tx. Fixtures are made inside it: the owner role moves to a test account (the real
-- owner's row is only demoted in this transaction, never read for secrets), a test member, the members switch turned on.
-- Browser calls run as anon with a minted token and a client IP header, as the browser's do. Each case catches its errors.
do $t$
declare
  out text := '';
  ok boolean; j json; j2 json; j3 json; v text; n int; n2 int; rid uuid;
  tx constant text := txid_current()::text;
  o uuid; o_tk text; m uuid; m_tk text; joined uuid; joined_tk text;
  o_name constant text := '__inv_o_' || txid_current();
  m_name constant text := '__inv_m_' || txid_current();
  j_name constant text := '__inv_j_' || txid_current();
  o_pw constant text := 'inv-owner-pass-1';
  m_pw constant text := 'inv-member-pass-1';
  j_pw constant text := 'joiner-pass-0001';
  code_re constant text := '^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$';
  backup_re constant text := '^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){4}$';
  ip_a constant text := '{"cf-connecting-ip":"198.51.100.21"}';
  ip_t constant text := '{"cf-connecting-ip":"198.51.100.22"}';
  code1 text; code2 text; code3 text; code4 text; code5 text;
  bad constant json := json_build_object('ok', false, 'reason', 'invalid');
begin
  -- I0. The gate (plan K7): the members switch is off as applied, and its column default is false (review r5 tests #1).
  begin
    execute 'select members_open from proxima_auth.auth_config where id' into ok;
    ok := ok is false and (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                            where d.adrelid = 'proxima_auth.auth_config'::regclass and a.attname = 'members_open') = 'false';
    out := out || case when ok then 'ok I0 switch-off-by-default; ' else 'FAIL I0 switch-off-by-default; ' end;
  exception when others then out := out || format('FAIL I0 %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- 0. Fixtures: the owner role on a test account (rolled back), a member, the switch on, the throttle on.
  begin
    update proxima_auth.users set role = 'member' where role = 'owner';
    insert into proxima_auth.users (username, role, scope, password_hash)
      values (o_name, 'owner', 'user:' || o_name, extensions.crypt(o_pw, extensions.gen_salt('bf', 4))) returning id into o;
    insert into proxima_auth.users (username, role, scope, password_hash)
      values (m_name, 'member', 'user:' || m_name, extensions.crypt(m_pw, extensions.gen_salt('bf', 4))) returning id into m;
    o_tk := proxima_auth.mint_token(o); m_tk := proxima_auth.mint_token(m);
    update proxima_auth.auth_config set signin_throttle = 'on', throttle_max_failures = 10, throttle_window = interval '15 minutes',
                                        throttle_guard_names = 50;
    execute 'update proxima_auth.auth_config set members_open = true';
    out := out || 'ok seed; ';
  exception when others then out := out || format('FAIL seed %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- I1. The owner creates an invite (password re-checked): the code comes back once, shaped for writing down; the server
  --     keeps only its sha-256 (of the code without dashes), the owner and a 7-day expiry.
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk, 'cf-connecting-ip', '198.51.100.20')::text, true);
    execute 'select public.create_invite($1, $2)' into j using o_tk, o_pw;
    reset role;
    code1 := j->>'code';
    execute 'select count(*) from proxima_auth.invites i where i.code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'')
               and i.created_by = $2 and i.used_at is null and i.revoked_at is null
               and i.expires_at between now() + interval ''6 days 23 hours'' and now() + interval ''7 days 1 hour''
               and position($1 in i::text) = 0 and position(replace($1, ''-'', '''') in i::text) = 0' into n using code1, o;
    ok := (j->>'ok')::boolean and code1 ~ code_re and n = 1 and (j->>'expires_at')::bigint > extract(epoch from now())::bigint;
    out := out || case when ok then 'ok I1 owner-creates; ' else format('FAIL I1 owner-creates %s n=%s; ', j, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I1 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I2. Refused: a member (forbidden), the owner with a wrong password (invalid, counted like every re-check), and anyone
  --     while the members switch is off (closed).
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', m_tk)::text, true);
    execute 'select public.create_invite($1, $2)' into j using m_tk, m_pw;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk)::text, true);
    execute 'select public.create_invite($1, $2)' into j2 using o_tk, 'wrong-password-1';
    reset role;
    execute 'update proxima_auth.auth_config set members_open = false';
    set local role anon;
    execute 'select public.create_invite($1, $2)' into j3 using o_tk, o_pw;
    reset role;
    execute 'update proxima_auth.auth_config set members_open = true';
    select login_failed into n from proxima_auth.users where id = o;   -- review r5 tests #6: the wrong password was counted
    update proxima_auth.users set login_failed = 0 where id = o;
    ok := j->>'reason' = 'forbidden' and j2->>'reason' = 'invalid' and j3->>'reason' = 'closed' and n = 1
      and j->>'code' is null and j2->>'code' is null and j3->>'code' is null;
    out := out || case when ok then 'ok I2 create-refusals; ' else format('FAIL I2 create-refusals %s %s %s; ', j, j2, j3) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I2 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I3. Joining with the code (typed in lower case without dashes): a member account invited by the owner, its folder
  --     claimed, a backup code shown once (stored hashed, accepted by the unlock), the invite used, a session for it.
  begin
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using lower(replace(code1, '-', '')), j_name, j_pw;
    reset role;
    joined := (j->>'account_id')::uuid; joined_tk := j->>'token';
    select count(*) into n from proxima_auth.users u
     where u.id = joined and u.username = j_name and u.role = 'member' and u.scope = 'user:' || j_name and u.invited_by = o
       and u.password_hash = extensions.crypt(j_pw, u.password_hash)
       and u.backup_code_hash = extensions.crypt(j->>'backup_code', u.backup_code_hash);
    execute 'select count(*) from proxima_auth.invites i where i.code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'')
               and i.used_by = $2 and i.used_at is not null' into n2 using code1, joined;
    ok := (j->>'ok')::boolean and j->>'role' = 'member' and j->>'username' = j_name and n = 1 and n2 = 1
      and (j->>'backup_code') ~ backup_re and (proxima_auth.current_account(joined_tk)).id = joined
      and exists (select 1 from proxima_auth.account_folders f where f.account_id = joined and f.folder = proxima_auth.scope_folder('user:' || j_name));
    out := out || case when ok then 'ok I3 join; ' else format('FAIL I3 join %s n=%s; ', left(j::text, 200), n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I3 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I4. Codes that do not work all get the same answer: used, unknown, expired, revoked, empty.
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk, 'cf-connecting-ip', '198.51.100.20')::text, true);
    execute 'select public.create_invite($1, $2)->>''code''' into code2 using o_tk, o_pw;
    execute 'select public.create_invite($1, $2)->>''code''' into code3 using o_tk, o_pw;
    reset role;
    execute 'update proxima_auth.invites set expires_at = now() - interval ''1 second'' where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'')' using code2;
    out := out || case when code2 ~ code_re and code3 ~ code_re then 'ok I4-setup; ' else 'FAIL I4-setup; ' end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I4-setup %s %s; ', sqlstate, left(sqlerrm, 80));
  end;
  begin
    execute 'select id from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'')' into rid using code3;
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk)::text, true);
    execute 'select public.revoke_invite($1, $2)' into j3 using o_tk, rid;
    perform set_config('request.headers', ip_a, true);
    ok := (j3->>'ok')::boolean;
    execute 'select public.join_with_invite($1, $2, $3)' into j using code1, j_name || 'x', j_pw;
    ok := ok and j::text = bad::text;
    execute 'select public.join_with_invite($1, $2, $3)' into j using 'AAAA-BBBB-CCCC-DDDD', j_name || 'x', j_pw;
    ok := ok and j::text = bad::text;
    execute 'select public.join_with_invite($1, $2, $3)' into j using code2, j_name || 'x', j_pw;
    ok := ok and j::text = bad::text;
    execute 'select public.join_with_invite($1, $2, $3)' into j using code3, j_name || 'x', j_pw;
    ok := ok and j::text = bad::text;
    execute 'select public.join_with_invite($1, $2, $3)' into j using null, j_name || 'x', j_pw;
    ok := ok and j::text = bad::text;
    reset role;
    ok := ok and not exists (select 1 from proxima_auth.users where username = j_name || 'x');
    out := out || case when ok then 'ok I4 dead-codes-generic; ' else format('FAIL I4 dead-codes-generic %s; ', j) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I4 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I5. A taken name (another account's, in any case; rows under its scope; a folder held by another account) answers
  --     username_taken after a valid code, and the invite stays usable.
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk, 'cf-connecting-ip', '198.51.100.20')::text, true);
    execute 'select public.create_invite($1, $2)->>''code''' into code4 using o_tk, o_pw;
    reset role;
    insert into tasks (id, device_id, status, start_time, outputs) values ('inv-x-' || tx, 'user:__inv_rows_' || tx, 'completed', 1000, '[]');
    insert into proxima_auth.account_folders (folder, account_id) values (proxima_auth.scope_folder('user:__inv_fold_' || tx), m);
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, upper(m_name), j_pw;
    execute 'select public.join_with_invite($1, $2, $3)' into j2 using code4, '__inv_rows_' || tx, j_pw;
    execute 'select public.join_with_invite($1, $2, $3)' into j3 using code4, '__inv_fold_' || tx, j_pw;
    reset role;
    execute 'select count(*) from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'') and used_at is null and revoked_at is null and expires_at > now()' into n using code4;
    ok := j->>'reason' = 'username_taken' and j2->>'reason' = 'username_taken' and j3->>'reason' = 'username_taken' and n = 1;
    out := out || case when ok then 'ok I5 name-taken-keeps-invite; ' else format('FAIL I5 name-taken %s %s %s n=%s; ', j, j2, j3, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I5 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I6. Shapes are checked first (no code is looked up): a bad name or a short password, and the invite stays usable.
  begin
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, 'a', j_pw;
    execute 'select public.join_with_invite($1, $2, $3)' into j2 using code4, 'has space', j_pw;
    execute 'select public.join_with_invite($1, $2, $3)' into j3 using code4, j_name || 'y', 'short';
    ok := j->>'reason' = 'invalid_username' and j2->>'reason' = 'invalid_username' and j3->>'reason' = 'weak_password';
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, 'dot.name', j_pw;
    ok := ok and j->>'reason' = 'invalid_username';
    reset role;
    execute 'select count(*) from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'') and used_at is null and revoked_at is null and expires_at > now()' into n using code4;
    ok := ok and n = 1;
    out := out || case when ok then 'ok I6 shapes-first; ' else format('FAIL I6 shapes %s n=%s; ', j, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I6 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I7. The new member signs in like any account, as a member.
  begin
    set local role anon;
    perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.23"}', true);
    j := public.verify_admin(j_name, j_pw);
    reset role;
    ok := (j->>'ok')::boolean and j->>'role' = 'member' and (j->>'account_id')::uuid = joined;
    out := out || case when ok then 'ok I7 member-signs-in; ' else format('FAIL I7 member-signs-in %s; ', j->>'reason') end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I7 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I8. The owner lists invites (state only: never a code or a hash); a member can neither list nor revoke them.
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk)::text, true);
    execute 'select public.list_my_invites($1)' into j using o_tk;
    perform set_config('request.headers', json_build_object('x-proxima-session', m_tk)::text, true);
    execute 'select public.list_my_invites($1)' into j2 using m_tk;
    execute 'select public.revoke_invite($1, (select null::uuid))' into j3 using m_tk;
    reset role;
    ok := (j->>'ok')::boolean and json_array_length(j->'invites') >= 4
      and position('code' in (j->'invites')::text) = 0 and position(code4 in j::text) = 0
      and j::text !~ '[0-9a-f]{64}'   -- review r5 tests #7: no hash under any key
      and exists (select 1 from json_array_elements(j->'invites') e where e->>'used_by_username' = j_name and e->>'state' = 'used')
      and exists (select 1 from json_array_elements(j->'invites') e where e->>'state' = 'revoked')
      and exists (select 1 from json_array_elements(j->'invites') e where e->>'state' = 'expired')
      and exists (select 1 from json_array_elements(j->'invites') e where e->>'state' = 'open')
      and j2->>'reason' = 'forbidden' and j3->>'reason' = 'forbidden';
    out := out || case when ok then 'ok I8 list-and-member-refused; ' else format('FAIL I8 list %s | %s | %s; ', left(j::text, 300), j2, j3) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I8 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I9. While the members switch is off, a valid code answers closed and stays usable.
  begin
    execute 'update proxima_auth.auth_config set members_open = false';
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, j_name || 'z', j_pw;
    reset role;
    execute 'update proxima_auth.auth_config set members_open = true';
    execute 'select count(*) from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'') and used_at is null and revoked_at is null and expires_at > now()' into n using code4;
    ok := j->>'reason' = 'closed' and n = 1 and not exists (select 1 from proxima_auth.users where username = j_name || 'z');
    out := out || case when ok then 'ok I9 closed; ' else format('FAIL I9 closed %s n=%s; ', j, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I9 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I10. At most 5 open invites at a time: the next one is refused until one is used, revoked or expired.
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk, 'cf-connecting-ip', '198.51.100.20')::text, true);
    for i in 1..6 loop
      execute 'select public.create_invite($1, $2)' into j using o_tk, o_pw;
      exit when not coalesce((j->>'ok')::boolean, false);
    end loop;
    reset role;
    execute 'select count(*) from proxima_auth.invites where used_at is null and revoked_at is null and expires_at > now()' into n;
    ok := j->>'reason' = 'too_many' and n = 5;
    out := out || case when ok then 'ok I10 cap; ' else format('FAIL I10 cap %s n=%s; ', j, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I10 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I11. The browser roles cannot read the invites table; the four functions are the only way in.
  begin
    begin
      set local role anon;
      execute 'select count(*) from proxima_auth.invites' into n;
      reset role;
      ok := false;
    exception when insufficient_privilege then
      reset role; ok := true;
    end;
    ok := ok and has_function_privilege('anon', 'public.join_with_invite(text,text,text)', 'execute')
      and has_function_privilege('anon', 'public.create_invite(text,text)', 'execute')
      and not has_table_privilege('authenticated', 'proxima_auth.invites', 'select')
      and not has_function_privilege('anon', 'proxima_auth._invite_code_hash(text)', 'execute');
    out := out || case when ok then 'ok I11 table-closed; ' else 'FAIL I11 table-closed; ' end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I11 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I12. Wrong codes count against the caller's IP like failed sign-ins: once it is blocked, even a valid code answers
  --      throttled and stays usable.
  begin
    update proxima_auth.auth_config set throttle_max_failures = 2;
    set local role anon;
    perform set_config('request.headers', ip_t, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', j_name || 't', j_pw;
    execute 'select public.join_with_invite($1, $2, $3)' into j using 'YYYY-YYYY-YYYY-YYYY', j_name || 't', j_pw;
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, j_name || 't', j_pw;
    reset role;
    update proxima_auth.auth_config set throttle_max_failures = 10;
    execute 'select count(*) from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'') and used_at is null and revoked_at is null and expires_at > now()' into n using code4;
    ok := j->>'reason' = 'throttled' and (j->>'retry_after')::int > 0 and n = 1;
    out := out || case when ok then 'ok I12 throttled; ' else format('FAIL I12 throttled %s n=%s; ', j, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I12 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I13. A joined account is a member everywhere: it cannot create invites, and the one owner stays the one owner.
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', joined_tk)::text, true);
    execute 'select public.create_invite($1, $2)' into j using joined_tk, j_pw;
    reset role;
    select count(*) into n from proxima_auth.users where role = 'owner';
    ok := j->>'reason' = 'forbidden' and n = 1;
    out := out || case when ok then 'ok I13 member-not-owner; ' else format('FAIL I13 %s n=%s; ', j, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I13 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- Review r5 cases. First free the 5-invite cap I10 filled (as postgres): every open invite but code4 is revoked.
  begin
    execute 'update proxima_auth.invites set revoked_at = now() where used_at is null and revoked_at is null
               and code_hash <> encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'')' using code4;
  exception when others then out := out || format('FAIL r5-setup %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- I14. The order is switch, shapes, code, name (r5 tests #2): a dead code with a taken name answers the generic invalid
  --      (nothing about the name); a dead code with a bad name answers invalid_username and is not counted; with the switch
  --      off a dead code answers closed and is not counted.
  begin
    set local role anon;
    perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.30"}', true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using 'ZZZZ-ZZZZ-ZZZZ-ZZZ2', upper(m_name), j_pw;
    reset role;
    execute 'select coalesce((select failures from proxima_auth.signin_throttle where ip_key = encode(extensions.hmac(host(''198.51.100.30''::inet),
               (select throttle_key from proxima_auth.auth_config where id), ''sha256''), ''hex'')), 0)' into n;
    set local role anon;
    perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.30"}', true);
    execute 'select public.join_with_invite($1, $2, $3)' into j2 using 'ZZZZ-ZZZZ-ZZZZ-ZZZ3', 'a', j_pw;
    reset role;
    execute 'update proxima_auth.auth_config set members_open = false';
    set local role anon;
    perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.30"}', true);
    execute 'select public.join_with_invite($1, $2, $3)' into j3 using 'ZZZZ-ZZZZ-ZZZZ-ZZZ4', j_name || 'q', j_pw;
    reset role;
    execute 'update proxima_auth.auth_config set members_open = true';
    execute 'select coalesce((select failures from proxima_auth.signin_throttle where ip_key = encode(extensions.hmac(host(''198.51.100.30''::inet),
               (select throttle_key from proxima_auth.auth_config where id), ''sha256''), ''hex'')), 0)' into n2;
    ok := j::text = bad::text and j2->>'reason' = 'invalid_username' and j3->>'reason' = 'closed' and n = 1 and n2 = 1;
    out := out || case when ok then 'ok I14 check-order; ' else format('FAIL I14 check-order %s %s %s n=%s n2=%s; ', j, j2, j3, n, n2) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I14 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I15. Every source of the taken-name list on its own (r5 tests #3): a row under 'user:<name>' in each table, an account
  --      in any case, a held folder; a scope holding only the restore marker is free. Called directly (as postgres), so
  --      the unique-index fallback cannot stand in for the list; and once through join.
  begin
    insert into history (id, device_id) values ('inv-h-' || tx, 'user:__inv_hist_' || tx);
    insert into favorites (id, device_id) values ('inv-f-' || tx, 'user:__inv_fav_' || tx);
    insert into presets (device_id, model_id) values ('user:__inv_pre_' || tx, 'm');
    insert into settings (device_id, key, value) values ('user:__inv_set_' || tx, 'theme', '"x"'::jsonb);
    insert into settings (device_id, key, value) values ('user:__inv_mark_' || tx, 'last_restore_at', '0'::jsonb);
    insert into sync_tombstones (id, kind, device_id) values ('inv-t-' || tx, 'task', 'user:__inv_tomb_' || tx);
    insert into user_secrets (device_id, key, value) values ('user:__inv_sec_' || tx, 'note', '{}'::jsonb);
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot, settings_snapshot)
      values ('user:__inv_bak_' || tx, 'manual', 0, 0, '[]', '[]', '{}');
    v := '';
    for j3 in select to_json(x) from unnest(array['__inv_rows_' || tx, '__inv_hist_' || tx, '__inv_fav_' || tx, '__inv_pre_' || tx,
                 '__inv_set_' || tx, '__inv_tomb_' || tx, '__inv_sec_' || tx, '__inv_bak_' || tx, upper(m_name), '__inv_fold_' || tx]) x loop
      execute 'select proxima_auth._username_taken($1)' into ok using j3#>>'{}';
      if not ok then v := v || (j3#>>'{}') || ' '; end if;
    end loop;
    execute 'select proxima_auth._username_taken($1)' into ok using '__inv_mark_' || tx;
    if ok then v := v || 'marker-only '; end if;
    execute 'select proxima_auth._username_taken($1)' into ok using '__inv_free_' || tx;
    if ok then v := v || 'free '; end if;
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, '__inv_sec_' || tx, j_pw;
    reset role;
    ok := v = '' and j->>'reason' = 'username_taken';
    out := out || case when ok then 'ok I15 taken-sources; ' else format('FAIL I15 taken-sources wrong: [%s] %s; ', v, j) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I15 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I16. A valid code answers at most 5 taken names (r5 security #1): the 6th try voids the invite (generic invalid), so a
  --      leaked code cannot list account names.
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk, 'cf-connecting-ip', '198.51.100.20')::text, true);
    execute 'select public.create_invite($1, $2)->>''code''' into code5 using o_tk, o_pw;
    perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.31"}', true);
    v := '';
    for i in 1..5 loop
      execute 'select public.join_with_invite($1, $2, $3)' into j using code5, case when i % 2 = 0 then upper(m_name) else '__inv_rows_' || tx end, j_pw;
      v := v || coalesce(j->>'reason', 'ok') || ' ';
    end loop;
    execute 'select public.join_with_invite($1, $2, $3)' into j using code5, j_name || 'cap', j_pw;
    reset role;
    execute 'select count(*) from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'')
               and revoked_at is not null and used_at is null' into n using code5;
    ok := v = repeat('username_taken ', 5) and j::text = bad::text and n = 1 and not exists (select 1 from proxima_auth.users where username = j_name || 'cap');
    out := out || case when ok then 'ok I16 taken-cap; ' else format('FAIL I16 taken-cap [%s] %s n=%s; ', v, j, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I16 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I17. Names with invisible or direction characters are refused (r5 security #2), and so are the boundaries (r5 tests #7):
  --      a 7-character password, a 65-character name, ':' and '/'. None of them touches the invite.
  begin
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    v := '';
    for j3 in select to_json(x) from unnest(array[m_name || chr(8203), chr(8238) || 'abc', 'ab' || chr(173) || 'c', 'ab' || chr(65279),
                 'ab' || chr(8288), 'ab' || chr(7), repeat('n', 65), 'a:b', 'a/b']) x loop
      execute 'select public.join_with_invite($1, $2, $3)' into j using code4, j3#>>'{}', j_pw;
      if j->>'reason' is distinct from 'invalid_username' then v := v || format('%s=%s ', length(j3#>>'{}'), j->>'reason'); end if;
    end loop;
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, j_name || 'pw', '1234567';
    reset role;
    execute 'select count(*) from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'') and used_at is null and revoked_at is null and expires_at > now()' into n using code4;
    ok := v = '' and j->>'reason' = 'weak_password' and n = 1;
    out := out || case when ok then 'ok I17 name-chars-and-bounds; ' else format('FAIL I17 names [%s] pw=%s n=%s; ', v, j->>'reason', n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I17 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I18. Revoke answers not_found for a used or an already revoked invite (r5 tests #7); the invites table has row security on.
  begin
    execute 'select id from proxima_auth.invites where used_by = $1' into rid using joined;
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk)::text, true);
    execute 'select public.revoke_invite($1, $2)' into j using o_tk, rid;
    reset role;
    execute 'select id from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'')' into rid using code3;
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk)::text, true);
    execute 'select public.revoke_invite($1, $2)' into j2 using o_tk, rid;
    reset role;
    ok := j->>'reason' = 'not_found' and j2->>'reason' = 'not_found'
      and (select c.relrowsecurity from pg_class c where c.oid = 'proxima_auth.invites'::regclass);
    out := out || case when ok then 'ok I18 revoke-filters-rls; ' else format('FAIL I18 %s %s; ', j, j2) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I18 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I19. A code works only while its creator is still the owner (r5 tests #5): disabled, or the owner role moved, answers
  --      invalid and leaves the invite as it was.
  begin
    update proxima_auth.users set disabled_at = now() where id = o;
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, j_name || 'dis', j_pw;
    reset role;
    update proxima_auth.users set disabled_at = null, role = 'member' where id = o;
    set local role anon;
    perform set_config('request.headers', ip_a, true);
    execute 'select public.join_with_invite($1, $2, $3)' into j2 using code4, j_name || 'dem', j_pw;
    reset role;
    update proxima_auth.users set role = 'owner' where id = o;
    execute 'select count(*) from proxima_auth.invites where code_hash = encode(extensions.digest(replace($1, ''-'', ''''), ''sha256''), ''hex'') and used_at is null and revoked_at is null and expires_at > now()' into n using code4;
    ok := j::text = bad::text and j2::text = bad::text and n = 1;
    out := out || case when ok then 'ok I19 creator-still-owner; ' else format('FAIL I19 %s %s n=%s; ', j, j2, n) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I19 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I20. Lock order (r5 security #3), checked in the body (one transaction cannot race two): the name's advisory key, then
  --      the invite row (FOR UPDATE), then the creator's row (FOR KEY SHARE) before the name check, so an owner renaming to
  --      the same name at the same moment makes it wait instead of deadlocking; a unique violation (a name or folder taken
  --      meanwhile) answers username_taken before the invite is marked used.
  begin
    v := lower(pg_get_functiondef('public.join_with_invite(text,text,text)'::regprocedure));
    ok := position('pg_advisory_xact_lock(hashtextextended(''proxima-signin:'' || lower(v_name), 0))' in v) > 0
      and position('pg_advisory_xact_lock(' in v) < position('for update of i' in v)
      and position('for update of i' in v) < position('for key share' in v)
      and position('for key share' in v) < position('_username_taken(' in v)
      and v ~ 'exception when unique_violation then[^;]*return json_build_object\(''ok'', false, ''reason'', ''username_taken''\);\s*end;\s*update proxima_auth\.invites set used_at';
    out := out || case when ok then 'ok I20 lock-order-and-race-answer; ' else 'FAIL I20 lock-order-and-race-answer; ' end;
  exception when others then out := out || format('FAIL I20 %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- I22. The rest of the r5 mutants: an invite of another creator is neither listed nor revocable by the owner; the code
  --      alphabet is used evenly; nobody but anon/authenticated runs the four functions and no browser role a helper.
  begin
    execute 'insert into proxima_auth.invites (code_hash, created_by, expires_at) values (md5($1) || md5($1), $2, now() + interval ''1 day'') returning id'
      into rid using 'other-' || tx, m;
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', o_tk)::text, true);
    execute 'select public.list_my_invites($1)' into j using o_tk;
    execute 'select public.revoke_invite($1, $2)' into j2 using o_tk, rid;
    reset role;
    ok := position(rid::text in j::text) = 0 and j2->>'reason' = 'not_found';
    execute 'select count(distinct c) from (select regexp_split_to_table(replace(proxima_auth._random_code(16), ''-'', ''''), '''') c from generate_series(1, 400)) s' into n;
    execute 'select max(k) - min(k) from (select count(*) k from (select regexp_split_to_table(replace(proxima_auth._random_code(16), ''-'', ''''), '''') c
               from generate_series(1, 2000)) s group by c) t' into n2;
    ok := ok and n = 32 and n2 < 400;   -- 32000 symbols: about 1000 each; a biased draw stands out
    ok := ok and not exists (
      select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid in ('public.create_invite(text,text)'::regprocedure, 'public.list_my_invites(text)'::regprocedure,
                       'public.revoke_invite(text,uuid)'::regprocedure, 'public.join_with_invite(text,text,text)'::regprocedure)
         and a.privilege_type = 'EXECUTE' and a.grantee not in ('anon'::regrole, 'authenticated'::regrole, p.proowner))
      and not exists (
      select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid in ('proxima_auth._invite_code_hash(text)'::regprocedure, 'proxima_auth._random_code(int)'::regprocedure,
                       'proxima_auth._username_taken(text)'::regprocedure)
         and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner);
    out := out || case when ok then 'ok I22 creator-filter-alphabet-grants; ' else format('FAIL I22 %s %s distinct=%s spread=%s; ', left(j::text, 80), j2, n, n2) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I22 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- I21. After every refusal above, the invite still works (r5 tests #4): the file ends with a successful join on code4.
  begin
    set local role anon;
    perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.32"}', true);
    execute 'select public.join_with_invite($1, $2, $3)' into j using code4, '  ' || j_name || 'end ', j_pw;   -- trimmed (r5)
    reset role;
    ok := (j->>'ok')::boolean and j->>'username' = j_name || 'end';
    out := out || case when ok then 'ok I21 code4-still-works; ' else format('FAIL I21 %s; ', j) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL I21 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  raise exception 'RESULT: %', out;
end $t$;
