-- Tests for supabase/migrations/20261026600000_mu_p5_member_signin_guard.sql: a member signs in only from a build that marks
-- its requests 'proxima-guard/1' (x-client-info); the owner from any build.
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261026600000_mu_p5_member_signin_guard.sql --test scripts/test-member-signin-guard-db.sql
-- One DO block, always rolled back by sql-tx. Fixtures: a member and (the owner role moved onto it, in this transaction
-- only) a test owner, both with known passwords. Calls run as anon with the request headers a browser would send.
do $t$
declare
  out text := ''; ok boolean; j json; j2 json; j3 json; n int; n2 int; thr text;
  m uuid; o uuid;
  m_name constant text := '__sg_m_' || txid_current();
  o_name constant text := '__sg_o_' || txid_current();
  pw constant text := 'guard-pass-0001';
  old_build constant text := '{"cf-connecting-ip":"198.51.100.41","x-client-info":"supabase-js-web/2.45.0 proxima-rls/1 sess/0"}';
  new_build constant text := '{"cf-connecting-ip":"198.51.100.42","x-client-info":"supabase-js-web/2.45.0 proxima-rls/1 sess/0 proxima-guard/1"}';
begin
  begin
    update proxima_auth.users set role = 'member' where role = 'owner';
    insert into proxima_auth.users (username, role, scope, password_hash)
      values (o_name, 'owner', 'user:' || o_name, extensions.crypt(pw, extensions.gen_salt('bf', 4))) returning id into o;
    insert into proxima_auth.users (username, role, scope, password_hash)
      values (m_name, 'member', 'user:' || m_name, extensions.crypt(pw, extensions.gen_salt('bf', 4))) returning id into m;
    out := out || 'ok seed; ';
  exception when others then out := out || format('FAIL seed %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  -- G1. A member from an older build (no marker) with the right password: update_required, no session, and nothing counted
  --     or reset (r7 tests #7: three such tries lock nothing, and a pending failure stays as it was; r8 #11: nothing counted
  --     against the network throttle either, which would also block the owner on the same network); the same member from
  --     a guard build: signed in as a member (its failure count reset). The throttle is switched on for this case only.
  begin
    update proxima_auth.users set login_failed = 1 where id = m;
    thr := (select signin_throttle from proxima_auth.auth_config where id);
    update proxima_auth.auth_config set signin_throttle = 'on' where id;
    n := coalesce((select failures from proxima_auth.signin_throttle where ip_key = encode(extensions.hmac(host('198.51.100.41'::inet),
           (select throttle_key from proxima_auth.auth_config where id), 'sha256'), 'hex')), 0);
    set local role anon;
    perform set_config('request.headers', old_build, true);
    j := public.verify_admin(m_name, pw);
    j3 := public.verify_admin(m_name, pw);
    j3 := public.verify_admin(m_name, pw);
    reset role;
    n2 := coalesce((select failures from proxima_auth.signin_throttle where ip_key = encode(extensions.hmac(host('198.51.100.41'::inet),
            (select throttle_key from proxima_auth.auth_config where id), 'sha256'), 'hex')), 0);
    update proxima_auth.auth_config set signin_throttle = thr where id;
    ok := (select login_failed = 1 and login_locked_at is null from proxima_auth.users where id = m) and n2 = n;
    if n2 <> n then out := out || format('FAIL G1 throttle counted %s -> %s; ', n, n2); end if;
    set local role anon;
    perform set_config('request.headers', new_build, true);
    j2 := public.verify_admin(m_name, pw);
    reset role;
    ok := ok and (select login_failed = 0 from proxima_auth.users where id = m);
    ok := ok and j->>'reason' = 'update_required' and j3->>'reason' = 'update_required' and j->>'token' is null and (j2->>'ok')::boolean and j2->>'role' = 'member';
    out := out || case when ok then 'ok G1 member-needs-guard-build; ' else format('FAIL G1 %s ok=%s role=%s; ', j, j2->>'ok', j2->>'role') end;   -- never the token
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL G1 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- G2. A wrong password from an older build gets the generic answer (update_required is never an oracle for a name).
  begin
    set local role anon;
    perform set_config('request.headers', old_build, true);
    j := public.verify_admin(m_name, 'wrong-password-9');
    reset role;
    ok := j->>'reason' = 'invalid';
    update proxima_auth.users set login_failed = 0, login_locked_at = null where id = m;
    out := out || case when ok then 'ok G2 wrong-password-generic; ' else format('FAIL G2 %s; ', j) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL G2 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- G3. The owner signs in from any build.
  begin
    set local role anon;
    perform set_config('request.headers', old_build, true);
    j := public.verify_admin(o_name, pw);
    perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.43"}', true);
    j2 := public.verify_admin(o_name, pw);
    reset role;
    ok := (j->>'ok')::boolean and j->>'role' = 'owner' and (j2->>'ok')::boolean;
    out := out || case when ok then 'ok G3 owner-any-build; ' else format('FAIL G3 ok=%s/%s role=%s/%s reason=%s/%s; ', j->>'ok', j2->>'ok', j->>'role', j2->>'role', j->>'reason', j2->>'reason') end;   -- never the token
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL G3 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- G4. Only the exact marker counts: a longer version, a marker glued to another word, no headers or broken headers do not.
  begin
    set local role anon;
    perform set_config('request.headers', '{"x-client-info":"proxima-guard/10"}', true);
    j := public.verify_admin(m_name, pw);
    perform set_config('request.headers', '{"x-client-info":"xproxima-guard/1"}', true);
    j2 := public.verify_admin(m_name, pw);
    perform set_config('request.headers', 'not json', true);
    j3 := public.verify_admin(m_name, pw);
    reset role;
    ok := j->>'reason' = 'update_required' and j2->>'reason' = 'update_required' and j3->>'reason' = 'update_required';
    out := out || case when ok then 'ok G4 exact-marker; ' else format('FAIL G4 %s %s %s; ', j, j2, j3) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL G4 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- G6. The legacy owner-only unlock (only older builds call it) refuses a request without the marker before anything, so a
  --     member on an older build cannot count wrong codes against the owner's row (r7 security #3); with the marker it
  --     still unlocks the owner by code (a wrong code counted there as before).
  begin
    update proxima_auth.users set backup_code_hash = extensions.crypt('OWNER-CODE-1234', extensions.gen_salt('bf', 4)), backup_failed = 0 where id = o;
    set local role anon;
    perform set_config('request.headers', old_build, true);
    j := public.unlock_admin_with_backup_code('MEMBER-CODE-0000', null);
    reset role;
    ok := j->>'reason' = 'update_required' and (select backup_failed = 0 from proxima_auth.users where id = o);
    set local role anon;
    perform set_config('request.headers', new_build, true);
    j2 := public.unlock_admin_with_backup_code('WRONG-CODE-0000', null);
    reset role;
    ok := ok and j2->>'reason' = 'invalid' and (select backup_failed = 1 from proxima_auth.users where id = o);
    out := out || case when ok then 'ok G6 legacy-unlock-guarded; ' else format('FAIL G6 %s %s; ', j, j2) end;
  exception when others then
    begin reset role; exception when others then null; end;
    out := out || format('FAIL G6 %s %s; ', sqlstate, left(sqlerrm, 80));
  end;

  -- G5. The helper is not a browser entry point.
  begin
    ok := not has_function_privilege('anon', 'proxima_auth._client_guard()', 'execute')
      and not has_function_privilege('authenticated', 'proxima_auth._client_guard()', 'execute');
    out := out || case when ok then 'ok G5 helper-closed; ' else 'FAIL G5 helper-closed; ' end;
  exception when others then out := out || format('FAIL G5 %s %s; ', sqlstate, left(sqlerrm, 80)); end;

  raise exception 'RESULT: %', out;
end $t$;
