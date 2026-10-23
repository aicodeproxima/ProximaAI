-- Rollback proof for M2 (supabase/migrations/20261023200000_mu_p1_scope_topic.sql; design §7). This ONE file runs five
-- times in ONE sql-tx run (everything rolled back); a temp table carries the step:
--   T=scripts/test-mu-scope-topic-rollback.sql M1=supabase/migrations/20261023100000_mu_p1_accounts.sql
--   M2=supabase/migrations/20261023200000_mu_p1_scope_topic.sql RB2=supabase/rollback/20261023200000_mu_p1_scope_topic.rollback.sql
--   RB1=supabase/rollback/20261023100000_mu_p1_accounts.rollback.sql
--   node scripts/tools/sql-tx.mjs $T $M1 $T $M2 $RB2 $T $M2 $T $RB2 $RB1 --test $T
--   That is the form from before M1 was live. With M1 live and M2 not yet, the second T follows the first directly:
--   node scripts/tools/sql-tx.mjs $T $T $M2 $RB2 $T $M2 $T $RB2 $RB1 --test $T (13/0 on 2026-10-23 before the M2 apply).
--   With M2 live, check its rollback alone: node scripts/tools/sql-tx.mjs $RB2 --test scripts/test-rls-rpcs.sql (7/0 on
--   2026-10-23 08:30 UTC); the rollback's own post-check refuses unless both bodies equal the pre-M2 md5s, and the suite
--   shows the app's calls still work after it.
-- step 0 (before M1): capture session_scope, sync_topic and ping_sync (pg_get_functiondef md5, ACL, config,
--        volatility, definer) and the topic value.
-- step 1 (after M1): all equal (M1 leaves them alone), same topic.
-- step 2 (after M2 + its rollback): all equal, same topic; an owner 'u:' token is refused again ('not admin-scoped',
--        the pre-M2 behaviour); neither body references a P1 object, so M1's rollback guard lets it run.
-- step 3 (after M2 again): M2's post-apply md5s (re-apply over the restored bodies works), same topic, and both bodies
--        reference P1 objects (M1's rollback would refuse).
-- step 4 (after M2's and M1's rollbacks): all equal to step 0, same topic, no P1 object left.
-- The refusals themselves are separate runs that must stop with an error (see the end of this file).
-- Nothing secret is printed: the topic is compared, never shown.
do $t$
declare
  fns constant text[] := array['proxima_auth.session_scope(boolean)', 'proxima_auth.sync_topic()', 'proxima_auth.ping_sync()'];
  m2_post constant jsonb := '{"proxima_auth.session_scope(boolean)":"0e153c08ca88b0e2f7e933d97c451fc8","proxima_auth.sync_topic()":"d477f4ef6736a9322a5a06e6c439e136"}';
  p1_ref constant text := '(proxima_auth\.users|current_account|auth_config|issue_session)';
  v_step int; out text; n int; v_bad text; v_id uuid; v_ep bigint; v_tok text;
begin
  if to_regclass('pg_temp.m2_rb_state') is null then
    create temp table m2_rb_state (step int, acc text) on commit drop;
    create temp table m2_rb_fn (sig text primary key, md5 text, acl text, cfg text, vol "char", secdef boolean) on commit drop;
    create temp table m2_rb_topic (t text) on commit drop;
    insert into m2_rb_fn
      select x, md5(pg_get_functiondef(p.oid)), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef
        from unnest(fns) x join pg_proc p on p.oid = to_regprocedure(x);
    get diagnostics n = row_count;
    insert into m2_rb_topic values (proxima_auth.sync_topic());
    insert into m2_rb_state values (1, case when n = cardinality(fns) then 'ok capture; ' else format('FAIL capture %s of %s; ', n, cardinality(fns)) end);
    return;
  end if;
  select s.step, s.acc into v_step, out from m2_rb_state s;

  if v_step in (1, 2, 4) then
    -- The three functions exactly as captured (md5, ACL, config, volatility, definer).
    select string_agg(c.sig, ', ' order by c.sig) into v_bad
      from m2_rb_fn c left join pg_proc p on p.oid = to_regprocedure(c.sig)
     where p.oid is null or md5(pg_get_functiondef(p.oid)) <> c.md5 or p.proacl::text is distinct from c.acl
        or p.proconfig::text is distinct from c.cfg or p.provolatile <> c.vol or p.prosecdef <> c.secdef;
    out := out || format('%s step%s functions as captured%s; ', case when v_bad is null then 'ok' else 'FAIL' end, v_step, coalesce(': ' || v_bad, ''));
  end if;
  if v_step in (2, 3) then
    select count(*) into n from pg_proc p
     where p.oid in ('proxima_auth.session_scope(boolean)'::regprocedure, 'proxima_auth.sync_topic()'::regprocedure)
       and p.prosrc ~ p1_ref;
    out := out || format('%s step%s %s; ', case when n = case v_step when 2 then 0 else 2 end then 'ok' else 'FAIL' end, v_step,
                         case v_step when 2 then 'no P1 reference left (M1 rollback may run)' else 'both bodies reference P1 (M1 rollback refuses)' end);
  end if;
  if v_step = 2 then
    select u.id, u.sessions_valid_after into v_id, v_ep from proxima_auth.users u where u.role = 'owner';
    v_tok := public._sign_session_token('u:' || v_id::text, to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200));
    perform set_config('request.headers', json_build_object('x-proxima-session', v_tok)::text, true);
    begin
      perform proxima_auth.session_scope(true);
      out := out || 'FAIL step2 owner u: accepted after the rollback; ';
    exception when others then
      out := out || format('%s step2 owner u: refused again (%s); ', case when sqlstate = '28000' and sqlerrm = 'not admin-scoped' then 'ok' else 'FAIL' end, sqlerrm);
    end;
    perform set_config('request.headers', '', true);
  end if;
  if v_step = 3 then
    select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(m2_post) e(k, m)
     where md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
    out := out || format('%s step3 M2 re-applied (post-apply md5s)%s; ', case when v_bad is null then 'ok' else 'FAIL' end, coalesce(': ' || v_bad, ''));
  end if;
  out := out || format('%s step%s same topic; ', case when proxima_auth.sync_topic() = (select t from m2_rb_topic) then 'ok' else 'FAIL' end, v_step);

  if v_step < 4 then
    update m2_rb_state set step = v_step + 1, acc = out;
    return;
  end if;
  out := out || format('%s step4 no P1 object left; ', case when to_regclass('proxima_auth.users') is null
    and to_regprocedure('proxima_auth.current_account(text)') is null and to_regtype('proxima_auth.account') is null then 'ok' else 'FAIL' end);
  raise exception 'RESULT: %', out;
end $t$;

-- Separate runs that must stop with an error (the refusals; each prints "error before RESULT" with that message):
--   node scripts/tools/sql-tx.mjs $M1 $M2 $RB1 --test $T
--     -> M1 rollback: still referenced outside the rollback set: proxima_auth.session_scope(boolean), proxima_auth.sync_topic() (roll back M2 first)
--   node scripts/tools/sql-tx.mjs $M1 $M2 <issue_session minting u: for every role, as M3 does> $RB2 --test $T
--     -> M2 rollback: issue_session no longer signs admin: tokens (M3 is live); roll back M3 first
--   node scripts/tools/sql-tx.mjs $M2 --test $T                      -> M2: M1 is not applied ...
