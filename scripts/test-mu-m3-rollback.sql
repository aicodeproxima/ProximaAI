-- Rollback proof for M3 (supabase/migrations/20261023300000_mu_p1_mint_u_tokens.sql; design §7). This ONE file runs
-- several times in ONE sql-tx run (everything rolled back); a temp table carries the mode and the step.
--   T=scripts/test-mu-m3-rollback.sql M3=supabase/migrations/20261023300000_mu_p1_mint_u_tokens.sql
--   RB3=supabase/rollback/20261023300000_mu_p1_mint_u_tokens.rollback.sql
--   RB2=supabase/rollback/20261023200000_mu_p1_scope_topic.rollback.sql
-- PROOF (live M1 + M2, M3 not applied):   node scripts/tools/sql-tx.mjs $T $M3 $T $RB3 $T $M3 --test $T   (all ok)
--   step 0 (before M3): issue_session has M1's post-apply body (md5 69fdda20...); capture its full text and attributes.
--   step 1 (after M3): M3's post-apply md5; owner/grants/settings as captured; mint_token(owner id) gives 'u:<id>' and
--          session_scope resolves it to the owner's scope; M2's rollback guard sees M3 (no 'admin:' || left). Then M3's
--          migration record is inserted as apply-migration.mjs records it (sql-tx records nothing), and the other
--          records are counted.
--   step 2 (after M3's rollback): issue_session's text equals the step-0 capture byte for byte, attributes as captured;
--          mint_token(owner id) gives 'admin:<owner name>' again; the 'u:' token minted at step 1 still resolves to the
--          owner (nobody is signed out); M2's rollback guard passes again; M3's record is gone and every other
--          record is still there (review m3crit #1/#3: apply-migration.mjs skips a recorded version, so the re-apply
--          after a rollback must find no record).
--   step 3 (after M3 again): M3's post-apply md5 again (re-apply over the restored body works); mint_token gives 'u:'.
-- REFUSALS: separate runs that must stop with an error before RESULT (if the rollback ran instead, the final $T reports
-- "FAIL the M3 rollback ran under simulated M4 ..."). Simulated M4 (sim mode: $T finds M3 already applied and no
-- state yet), one M4 change per run, each detected on its own by the rollback's guard:
--   node scripts/tools/sql-tx.mjs $M3 $T $RB3 --test $T          (M4-a: current_account without its admin: branch)
--     -> M3 rollback: M4 is live (current_account has no admin: branch); roll back M4 first
--   node scripts/tools/sql-tx.mjs $M3 $T $T $RB3 --test $T       (M4-b: the verifier revokes admin: explicitly)
--     -> M3 rollback: M4 is live (the verifier answers revoked for a fresh admin:<owner> token); roll back M4 first
--   node scripts/tools/sql-tx.mjs $M3 $T $T $T $RB3 --test $T    (M4-c: set_admin_credentials_rehash dropped)
--     -> M3 rollback: M4 is live (set_admin_credentials_rehash is dropped); roll back M4 first
--   node scripts/tools/sql-tx.mjs $RB3 --test $T                 (M3 not live)
--     -> M3 rollback compare-and-swap: issue_session differs from M3's post-apply text ...
--   node scripts/tools/sql-tx.mjs $M3 $RB2 --test $T             (M2's rollback while M3 is live)
--     -> M2 rollback: issue_session no longer signs admin: tokens (M3 is live); roll back M3 first
-- Tokens live in variables and a temp table only; nothing secret is printed.
do $t$
declare
  pre_md5 constant text := '69fdda20ce11b5dd3d7e588bf44cbac0';   -- M1's post-apply issue_session = pre-M3
  m3_md5 constant text := 'b9ba44a18b04d17bdf0034b944a57035';    -- M3's post-apply issue_session
  m3_ver constant text := '20261023300000'; m3_name constant text := 'mu_p1_mint_u_tokens';
  mint_re constant text := $re$'admin:'\s*\|\|$re$;
  v_md5 text; v_def text; v_attrs text; v_mode text; v_step int; out text; v_new text;
  v_id uuid; v_name text; v_scope text; v_tok text; v_got text; v_acc proxima_auth.account;
begin
  v_def := pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure);
  v_md5 := md5(v_def);
  select p.proacl::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.proconfig::text
    into v_attrs from pg_proc p where p.oid = 'proxima_auth.issue_session(uuid)'::regprocedure;
  select u.id, u.username, u.scope into v_id, v_name, v_scope from proxima_auth.users u where u.role = 'owner';

  if to_regclass('pg_temp.m3_rb_state') is null then
    create temp table m3_rb_state (mode text, step int, acc text, def text, attrs text, utok text, ca_def text, vf_def text,
                                   rec_others int)
      on commit drop;
    if v_md5 = pre_md5 then
      insert into m3_rb_state (mode, step, acc, def, attrs)
        values ('proof', 1, 'ok step0 pre-M3 body (M1 post-apply md5) captured; ', v_def, v_attrs);
      return;
    elsif v_md5 = m3_md5 then
      -- Simulated M4, change a: current_account loses its admin: branch.
      insert into m3_rb_state (mode, step, ca_def, vf_def)
        values ('sim', 1, pg_get_functiondef('proxima_auth.current_account(text)'::regprocedure),
                pg_get_functiondef('public._verify_session_token(text)'::regprocedure));
      select regexp_replace(s.ca_def, '\n  elsif v_sub like ''admin:%'' then\n[^\n]*', '') into v_new from m3_rb_state s;
      if v_new = (select ca_def from m3_rb_state) then raise exception 'RESULT: FAIL sim-M4-a could not remove the admin: branch'; end if;
      execute v_new;
      return;
    else
      raise exception 'RESULT: FAIL issue_session is neither the pre-M3 nor the M3 body (md5 %)', v_md5;
    end if;
  end if;

  select s.mode, s.step, s.acc into v_mode, v_step, out from m3_rb_state s;

  if v_mode = 'sim' then
    if v_md5 <> m3_md5 then
      raise exception 'RESULT: FAIL the M3 rollback ran under simulated M4 change %', chr(96 + v_step);
    end if;
    if v_step = 1 then
      -- change b: current_account restored; the verifier answers revoked for every admin: token (M4's explicit branch).
      execute (select ca_def from m3_rb_state);
      select replace(s.vf_def, $s$elsif v_subject like 'admin:%' then$s$,
                     $s$elsif v_subject like 'admin:%' then
    raise exception 'session token revoked';$s$) into v_new from m3_rb_state s;
      if v_new = (select vf_def from m3_rb_state) then raise exception 'RESULT: FAIL sim-M4-b could not change the verifier'; end if;
      execute v_new;
    elsif v_step = 2 then
      -- change c: the verifier restored; set_admin_credentials_rehash dropped.
      execute (select vf_def from m3_rb_state);
      drop function public.set_admin_credentials_rehash(text, text);
    else
      raise exception 'RESULT: FAIL sim mode has no change after c';
    end if;
    update m3_rb_state set step = v_step + 1;
    return;
  end if;

  -- proof mode
  if v_step in (1, 3) then
    out := out || format('%s step%s M3 body (post-apply md5); ', case when v_md5 = m3_md5 then 'ok' else 'FAIL' end, v_step);
    v_tok := proxima_auth.mint_token(v_id);
    perform set_config('request.headers', json_build_object('x-proxima-session', v_tok)::text, true);
    begin v_got := proxima_auth.session_scope(true); exception when others then v_got := 'error: ' || left(sqlerrm, 40); end;
    perform set_config('request.headers', '', true);
    out := out || format('%s step%s owner mints u: (scope resolves); ',
                         case when left(v_tok, 39) = 'u:' || v_id::text || '.' and v_got = v_scope then 'ok' else 'FAIL' end, v_step);
    out := out || format('%s step%s M2 rollback guard sees M3; ', case when v_def !~* mint_re then 'ok' else 'FAIL' end, v_step);
    if v_step = 1 then
      update m3_rb_state set utok = v_tok;
      -- The record apply-migration.mjs writes for M3 (buildApplyScript: version, name, statements).
      insert into supabase_migrations.schema_migrations (version, name, statements)
        values (m3_ver, m3_name, array['-- test-mu-m3-rollback stand-in for the M3 text']);
      update m3_rb_state set rec_others = (select count(*) from supabase_migrations.schema_migrations where version <> m3_ver);
    end if;
  end if;
  if v_step = 2 then
    out := out || format('%s step2 body restored verbatim; ', case when v_def = (select def from m3_rb_state) and v_md5 = pre_md5 then 'ok' else 'FAIL' end);
    v_tok := proxima_auth.mint_token(v_id);
    out := out || format('%s step2 owner mints admin: again; ',
                         case when left(v_tok, length('admin:' || v_name) + 1) = 'admin:' || v_name || '.' then 'ok' else 'FAIL' end);
    begin
      v_acc := proxima_auth.current_account((select utok from m3_rb_state));
      out := out || format('%s step2 u: token from M3 still valid; ', case when v_acc.id = v_id and v_acc.role = 'owner' then 'ok' else 'FAIL' end);
    exception when others then out := out || format('FAIL step2 u: token from M3 refused %s; ', left(sqlerrm, 40)); end;
    out := out || format('%s step2 M2 rollback guard passes; ', case when v_def ~* mint_re then 'ok' else 'FAIL' end);
    out := out || format('%s step2 rollback deleted its own record only; ',
                         case when not exists (select 1 from supabase_migrations.schema_migrations where version = m3_ver)
                                   and (select count(*) from supabase_migrations.schema_migrations where version <> m3_ver)
                                       = (select rec_others from m3_rb_state)
                              then 'ok' else 'FAIL' end);
  end if;
  out := out || format('%s step%s attributes as captured; ', case when v_attrs = (select attrs from m3_rb_state) then 'ok' else 'FAIL' end, v_step);

  if v_step < 3 then
    update m3_rb_state set step = v_step + 1, acc = out;
    return;
  end if;
  raise exception 'RESULT: %', out;
end $t$;
