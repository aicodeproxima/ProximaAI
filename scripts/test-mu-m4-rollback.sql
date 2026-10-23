-- Rollback proof for M4 (supabase/migrations/20261023400000_mu_p1_end_dual_accept.sql; design §7). This ONE file runs
-- several times in ONE sql-tx run (everything rolled back); a temp table carries the step.
--   T=scripts/test-mu-m4-rollback.sql M4=supabase/migrations/20261023400000_mu_p1_end_dual_accept.sql
--   RB4=supabase/rollback/20261023400000_mu_p1_end_dual_accept.rollback.sql
--   RB3=supabase/rollback/20261023300000_mu_p1_mint_u_tokens.rollback.sql
--   RB2=supabase/rollback/20261023200000_mu_p1_scope_topic.rollback.sql
--   RB1=supabase/rollback/20261023100000_mu_p1_accounts.rollback.sql
--   Before 2026-10-23 21:06:07 UTC M4's clock check refuses; use its no-clock scratch copy as M4 (never the real file
--   edited): sed '/^  -- M4-CLOCK-BEGIN/,/^  -- M4-CLOCK-END$/d' $M4 > <scratch>/m4-noclock.sql
-- PROOF (live M1 + M2 + M3, M4 not applied):   node scripts/tools/sql-tx.mjs $T $M4 $T $RB4 $T $M4 --test $T   (all ok)
--   step 0 (before M4): the verifier, current_account and set_admin_credentials_rehash have the pre-M4 md5s; capture
--          their full text and attributes; the guard function, both triggers and the seed snapshot exist.
--   step 1 (after M4): M4's post-apply md5s with the captured attributes; set_admin_credentials_rehash, the guard, both
--          triggers and the snapshot are gone; unlock_admin_with_backup_code unchanged; issue_session unchanged (M3's
--          md5); every admin: token (the owner's, issued now) answers 'session token revoked'; the owner's u: token from
--          mint_token resolves; M3's rollback guard would refuse (its M4-a, M4-b and M4-c each hold). Then M4's
--          migration record is inserted as apply-migration.mjs records it (sql-tx records nothing), and the other
--          records are counted.
--   step 2 (after M4's rollback): the three texts equal the step-0 capture byte for byte, attributes as captured
--          (set_admin_credentials_rehash's grants included); a fresh admin:<owner> token resolves to the owner again;
--          the u: token minted at step 1 still resolves (nobody is signed out); M3's rollback guard passes (M4-a/b/c
--          all clear); the guard and the snapshot are NOT recreated; M4's record is gone and every other record is
--          still there.
--   step 3 (after M4 again, over the restored bodies with the guard already gone): M4's post-apply md5s again.
-- REFUSALS and the chain (separate runs; each must stop with the error shown, or print the result shown):
--   node scripts/tools/sql-tx.mjs $RB4 --test $T                     -> M4 rollback compare-and-swap: M4 is not live ...
--   node scripts/tools/sql-tx.mjs $M4 $RB3 --test $T                 -> M3 rollback: M4 is live (current_account has no
--                                                                       admin: branch; the verifier answers revoked ...;
--                                                                       set_admin_credentials_rehash is dropped) ...
--   node scripts/tools/sql-tx.mjs $M4 $RB2 --test $T                 -> M2 rollback: issue_session no longer signs admin:
--                                                                       tokens (M3 is live); roll back M3 first
--   node scripts/tools/sql-tx.mjs $M4 $RB1 --test $T                 -> M1 rollback: still referenced outside the rollback
--                                                                       set: proxima_auth.session_scope(boolean),
--                                                                       proxima_auth.sync_topic() (roll back M2 first)
--     (its first guard; with that guard blind, before the m4crit #1/#2 fix, it stopped one check later at "M1 rollback
--     compare-and-swap: body differs from M1's post-apply text: current_account, issue_session, ...")
--   node scripts/tools/sql-tx.mjs $M4 $RB4 $RB3 $RB1 --test $T       -> M1 rollback: still referenced outside the rollback
--                                                                       set: proxima_auth.session_scope(boolean),
--                                                                       proxima_auth.sync_topic() (roll back M2 first)
--     (M2 still live). M1's rollback leaves names that no longer exist out of that guard's array (M4 drops
--     proxima_auth.m1_frozen_guard(); a NULL there made the ANY NULL and the guard see nothing: review m4crit #1/#2,
--     fixed in m1-gen gen.mjs 2026-10-23). Before the fix this printed "FAIL p1-fully-rolled-back (a P1 object
--     remains; session_scope still M2's: t)"; any RESULT here, ok or FAIL, means the guard is blind again.
--   node scripts/tools/sql-tx.mjs $RB3 $M4 --test $T                 -> M4: M3 is not live: issue_session still signs ...
--   node scripts/tools/sql-tx.mjs <real M4, before 21:06:07 UTC> --test $T -> M4: too early: not before 2026-10-23 21:06:07 UTC ...
--   node scripts/tools/sql-tx.mjs $M4 $RB4 $RB3 $RB2 $RB1 --test $T  -> chain: ok p1-fully-rolled-back (the order
--                                                                       M4 -> M3 -> M2 -> M1 permits; M1's rollback ran
--                                                                       without the guard and the snapshot M4 dropped)
-- 2026-10-23 (live M1 + M2 + M3, M4 as its no-clock copy): proof 22 ok, 0 FAIL; every refusal and the chain as shown
-- above. Run alone (one --test, e.g. by m1-gen suites.mjs) it stops after step 0 with "raised no RESULT": a multi-run
-- proof like test-mu-m3-rollback.sql, so it belongs in suites.mjs's skip set.
-- Tokens live in variables and a temp table only; nothing secret is printed.
do $t$
declare
  pre_md5 constant jsonb := '{"public._verify_session_token(text)": "484c5195284ab3141fcae69a7c80b8af",
    "proxima_auth.current_account(text)": "6e53e84b823eaf7e6580d0d8ebed45fc",
    "public.set_admin_credentials_rehash(text,text)": "16d6979772017cdaa5ee7c9d4bf80c17"}';
  m4_md5 constant jsonb := '{"public._verify_session_token(text)": "59556daf06c76548385bfe196467c2dd",
    "proxima_auth.current_account(text)": "9175d1aea4b9e6959723c12f0bb708f1"}';
  m3_md5 constant text := 'b9ba44a18b04d17bdf0034b944a57035';
  unlock_md5 constant text := 'efa5fb04c91d9a3c374c8f8c351524e3';
  m4_ver constant text := '20261023400000'; m4_name constant text := 'mu_p1_end_dual_accept';
  v_step int; out text := ''; v_cur jsonb; v_attrs jsonb; v_id uuid; v_name text; v_scope text; v_ep bigint;
  v_tok text; v_err text; v_acc record; v_got text; n int; v_guard_gone boolean;
begin
  if to_regclass('proxima_auth.users') is null then
    -- The chain run: M4 -> M3 -> M2 -> M1 rolled back in that order (each rollback's guard passed).
    raise exception 'RESULT: %', case when to_regprocedure('proxima_auth.current_account(text)') is null
                                           and to_regnamespace('proxima_auth') is not null
                                           and to_regprocedure('proxima_auth.m1_frozen_guard()') is null
                                           and to_regclass('proxima_auth.m1_seed_snapshot') is null
                                           and not exists (select 1 from pg_trigger tg where tg.tgname like 'app_secrets_m1_frozen%')
                                           and to_regprocedure('public.set_admin_credentials_rehash(text,text)') is not null
                                           and pg_get_functiondef('proxima_auth.session_scope(boolean)'::regprocedure) !~ 'current_account'
      then 'ok p1-fully-rolled-back (M4 -> M3 -> M2 -> M1, no P1 object left, pre-P1 rehash function back); '
      else format('FAIL p1-fully-rolled-back (a P1 object remains; session_scope still M2''s: %s); ',
                  pg_get_functiondef('proxima_auth.session_scope(boolean)'::regprocedure) ~ 'current_account') end;
  end if;
  select jsonb_object_agg(k, md5(pg_get_functiondef(to_regprocedure(k)))) into v_cur
    from jsonb_object_keys(pre_md5) k where to_regprocedure(k) is not null;
  select jsonb_object_agg(k, (select p.proacl::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|'
                                     || p.proconfig::text from pg_proc p where p.oid = to_regprocedure(k)))
    into v_attrs from jsonb_object_keys(pre_md5) k where to_regprocedure(k) is not null;
  select u.id, u.username, u.scope, u.sessions_valid_after into v_id, v_name, v_scope, v_ep from proxima_auth.users u where u.role = 'owner';
  v_guard_gone := to_regprocedure('proxima_auth.m1_frozen_guard()') is null and to_regclass('proxima_auth.m1_seed_snapshot') is null
                  and not exists (select 1 from pg_trigger tg where tg.tgname in ('app_secrets_m1_frozen', 'app_secrets_m1_frozen_truncate'));

  if to_regclass('pg_temp.m4_rb_state') is null then
    if v_cur is distinct from pre_md5 then
      raise exception 'RESULT: FAIL step0 not the pre-M4 state (M4 live or a body changed): %', v_cur;
    end if;
    create temp table m4_rb_state (step int, acc text, defs jsonb, attrs jsonb, utok text, rec_others int) on commit drop;
    insert into m4_rb_state values (1,
      format('%s step0 pre-M4 bodies captured, guard and snapshot present; ',
             case when not v_guard_gone and to_regprocedure('proxima_auth.m1_frozen_guard()') is not null
                       and to_regclass('proxima_auth.m1_seed_snapshot') is not null
                       and (select count(*) from pg_trigger tg where tg.tgname in ('app_secrets_m1_frozen', 'app_secrets_m1_frozen_truncate')) = 2
                  then 'ok' else 'FAIL' end),
      (select jsonb_object_agg(k, pg_get_functiondef(to_regprocedure(k))) from jsonb_object_keys(pre_md5) k), v_attrs, null, null);
    return;
  end if;
  select s.step, s.acc into v_step, out from m4_rb_state s;

  if v_step in (1, 3) then
    out := out || format('%s step%s M4 bodies (post-apply md5), rehash gone; ', case when v_cur = m4_md5 then 'ok' else 'FAIL' end, v_step);
    out := out || format('%s step%s attributes as captured; ',
                         case when v_attrs = (select attrs from m4_rb_state) - 'public.set_admin_credentials_rehash(text,text)' then 'ok' else 'FAIL' end, v_step);
    out := out || format('%s step%s guard, triggers and snapshot gone; ', case when v_guard_gone then 'ok' else 'FAIL' end, v_step);
    out := out || format('%s step%s issue_session and the old unlock unchanged; ',
                         case when md5(pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure)) = m3_md5
                                   and md5(pg_get_functiondef('public.unlock_admin_with_backup_code(text,text)'::regprocedure)) = unlock_md5
                              then 'ok' else 'FAIL' end, v_step);
    v_err := null;
    begin
      perform public._verify_session_token(public._sign_session_token('admin:' || v_name,
        to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200)));
    exception when others then v_err := sqlerrm; end;
    out := out || format('%s step%s fresh admin:<owner> revoked; ', case when v_err = 'session token revoked' then 'ok' else 'FAIL' end, v_step);
    v_tok := proxima_auth.mint_token(v_id);
    select * into v_acc from proxima_auth.current_account(v_tok);
    out := out || format('%s step%s owner u: token resolves; ',
                         case when left(v_tok, 39) = 'u:' || v_id::text || '.' and v_acc.id = v_id and v_acc.scope = v_scope then 'ok' else 'FAIL' end, v_step);
    -- M3's rollback guard: M4-a (no 'admin: in current_account), M4-b (v_err above), M4-c (rehash gone) each hold.
    out := out || format('%s step%s M3 rollback guard sees M4 (a, b and c); ',
                         case when position('''admin:' in pg_get_functiondef('proxima_auth.current_account(text)'::regprocedure)) = 0
                                   and v_err = 'session token revoked'
                                   and to_regprocedure('public.set_admin_credentials_rehash(text,text)') is null
                              then 'ok' else 'FAIL' end, v_step);
    if v_step = 1 then
      update m4_rb_state set utok = v_tok;
      insert into supabase_migrations.schema_migrations (version, name, statements)
        values (m4_ver, m4_name, array['-- test-mu-m4-rollback stand-in for the M4 text']);
      update m4_rb_state set rec_others = (select count(*) from supabase_migrations.schema_migrations where version <> m4_ver);
    end if;
  end if;

  if v_step = 2 then
    out := out || format('%s step2 bodies restored verbatim; ',
                         case when v_cur = pre_md5
                                   and (select jsonb_object_agg(k, pg_get_functiondef(to_regprocedure(k))) from jsonb_object_keys(pre_md5) k)
                                       = (select defs from m4_rb_state)
                              then 'ok' else 'FAIL' end);
    out := out || format('%s step2 attributes as captured (rehash grants included); ',
                         case when v_attrs = (select attrs from m4_rb_state) then 'ok' else 'FAIL' end);
    v_err := null;
    begin
      select * into v_acc from proxima_auth.current_account(public._sign_session_token('admin:' || v_name,
                 to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200)));
    exception when others then v_err := sqlerrm; end;
    out := out || format('%s step2 fresh admin:<owner> resolves again; ',
                         case when v_err is null and v_acc.id = v_id and v_acc.role = 'owner' then 'ok' else 'FAIL' end);
    begin
      select * into v_acc from proxima_auth.current_account((select utok from m4_rb_state));
      out := out || format('%s step2 u: token from M4 still valid; ', case when v_acc.id = v_id then 'ok' else 'FAIL' end);
    exception when others then out := out || format('FAIL step2 u: token from M4 refused %s; ', left(sqlerrm, 40)); end;
    out := out || format('%s step2 M3 rollback guard passes (a, b, c clear); ',
                         case when position('''admin:' in pg_get_functiondef('proxima_auth.current_account(text)'::regprocedure)) > 0
                                   and v_err is null
                                   and to_regprocedure('public.set_admin_credentials_rehash(text,text)') is not null
                              then 'ok' else 'FAIL' end);
    out := out || format('%s step2 guard and snapshot not recreated; ', case when v_guard_gone then 'ok' else 'FAIL' end);
    out := out || format('%s step2 rollback deleted its own record only; ',
                         case when not exists (select 1 from supabase_migrations.schema_migrations where version = m4_ver)
                                   and (select count(*) from supabase_migrations.schema_migrations where version <> m4_ver)
                                       = (select rec_others from m4_rb_state)
                              then 'ok' else 'FAIL' end);
  end if;

  if v_step < 3 then
    update m4_rb_state set step = v_step + 1, acc = out;
    return;
  end if;
  raise exception 'RESULT: %', out;
end $t$;
