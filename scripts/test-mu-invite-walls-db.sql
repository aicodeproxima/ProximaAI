-- Invites between accounts (P4 gate, with scripts/test-mu-matrix.sql; the invite functions are the other session's P5 and
-- scripts/test-invites-db.sql tests them in full): what one account can do to another's invites, called as the browser
-- calls them (anon, a minted token). A = the owner (there is only one: users_one_owner), B = a member seeded here. Rolled
-- back by sql-tx; the owner's real invites are only searched for a probe invite inserted here, never read out.
--   W1 B cannot create an invite, even with its own password (forbidden; none made)
--   W2 B cannot list invites (forbidden): nothing of A's comes back
--   W3 B cannot revoke A's invite (forbidden), which stays open
--   W4 B cannot read the invites table itself (proxima_auth is closed to browser roles)
--   W5 A lists its invite and can revoke it (the walls are walls, not a dead switch)
--   W6 a junk code joins nothing at either stage (members closed: 'closed'; open: 'invalid')
-- Covers behaviour live since 20261026500000, so it cannot fail first; it does catch a broken wall: with list_my_invites
-- stripped of its role check (a rolled-back mutant, 2026-10-26), W2 fails.
do $t$
declare
  r text[] := '{}'; p constant text := '__iw' || txid_current();
  a_id uuid; a_tok text; b_id uuid; b_tok text; b_name constant text := p || 'b'; b_pw constant text := 'walls-member-pass-1';
  inv uuid; j json; j2 json; n int; open0 boolean; ok boolean;
  ip constant text := '198.51.100.51';
begin
  select u.id, proxima_auth.mint_token(u.id) into a_id, a_tok from proxima_auth.users u where u.role = 'owner';
  insert into proxima_auth.users (username, role, scope, password_hash)
    values (b_name, 'member', 'user:' || b_name, extensions.crypt(b_pw, extensions.gen_salt('bf', 4))) returning id into b_id;
  b_tok := proxima_auth.mint_token(b_id);
  insert into proxima_auth.invites (code_hash, created_by, expires_at)
    values (proxima_auth._invite_code_hash(p), a_id, now() + interval '1 day') returning id into inv;
  open0 := coalesce((select c.members_open from proxima_auth.auth_config c where c.id), false);
  update proxima_auth.auth_config set members_open = true;   -- create_invite would answer 'closed' before its role check

  -- W1
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', b_tok, 'cf-connecting-ip', ip)::text, true);
    j := public.create_invite(b_tok, b_pw);
    execute 'reset role';
  exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); end;
  select count(*) into n from proxima_auth.invites i where i.created_by = b_id;
  r := r || format('%s W1 a member cannot create an invite (%s; made %s)',
                   case when j->>'reason' = 'forbidden' and n = 0 then 'PASS' else 'FAIL' end, coalesce(j->>'reason', 'ok'), n);
  -- W2
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', b_tok, 'cf-connecting-ip', ip)::text, true);
    j := public.list_my_invites(b_tok);
    execute 'reset role';
  exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); end;
  r := r || format('%s W2 a member cannot list invites (%s; the owner''s probe invite in the answer: %s)',
                   case when j->>'reason' = 'forbidden' and position(inv::text in j::text) = 0 then 'PASS' else 'FAIL' end,
                   coalesce(j->>'reason', 'ok'), position(inv::text in j::text) > 0);
  -- W3
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', b_tok, 'cf-connecting-ip', ip)::text, true);
    j := public.revoke_invite(b_tok, inv);
    execute 'reset role';
  exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); end;
  select count(*) into n from proxima_auth.invites i where i.id = inv and i.revoked_at is null;
  r := r || format('%s W3 a member cannot revoke the owner''s invite (%s; still open: %s)',
                   case when j->>'reason' = 'forbidden' and n = 1 then 'PASS' else 'FAIL' end, coalesce(j->>'reason', 'ok'), n = 1);
  -- W4
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', b_tok, 'cf-connecting-ip', ip)::text, true);
    execute 'select count(*) from proxima_auth.invites' into n;
    execute 'reset role';
    r := r || format('FAIL W4 a browser role read the invites table (%s rows)', n);
  exception when insufficient_privilege then r := r || text 'PASS W4 the invites table is closed to browser roles (42501)';
            when others then r := r || format('FAIL W4 invites table: %s %s', sqlstate, left(sqlerrm, 60)); end;
  -- W5
  begin
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', a_tok, 'cf-connecting-ip', ip)::text, true);
    j := public.list_my_invites(a_tok);
    j2 := public.revoke_invite(a_tok, inv);
    execute 'reset role';
  exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); j2 := j; end;
  select count(*) into n from proxima_auth.invites i where i.id = inv and i.revoked_at is not null;
  r := r || format('%s W5 the owner lists its invite (%s) and revokes it (%s; revoked: %s)',
                   case when (j->>'ok')::boolean and position(inv::text in j::text) > 0 and (j2->>'ok')::boolean and n = 1 then 'PASS' else 'FAIL' end,
                   coalesce(j->>'reason', 'listed ' || (position(inv::text in j::text) > 0)), coalesce(j2->>'reason', 'ok'), n = 1);
  -- W6: both stages, starting from the live one.
  ok := true;
  foreach open0 in array array[open0, not open0] loop
    update proxima_auth.auth_config set members_open = open0;
    begin
      execute 'set local role anon';
      perform set_config('request.headers', json_build_object('cf-connecting-ip', ip)::text, true);
      j := public.join_with_invite('AAAA-BBBB-CCCC-DDDD', p || 'j', 'joiner-pass-0001');
      execute 'reset role';
    exception when others then j := json_build_object('ok', false, 'reason', 'error ' || sqlstate); end;
    ok := ok and j->>'reason' = case when open0 then 'invalid' else 'closed' end;
  end loop;
  r := r || format('%s W6 a junk code joins nothing, members closed or open', case when ok then 'PASS' else 'FAIL' end);
  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) q where q like 'PASS%'),
    (select count(*) from unnest(r) q where q like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
