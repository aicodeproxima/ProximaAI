-- Rollback of supabase/migrations/20261023300000_mu_p1_mint_u_tokens.sql (M3; docs/P1-AUTH-DESIGN.md §7). Kept OUT of
-- supabase/migrations/. One transaction, no transaction control:
--   0) guards (proxima_auth.users taken in EXCLUSIVE mode first, as M3 does, so no sign-in mints across the switch):
--      - REFUSES while M4 (20261023xxxx40_mu_p1_end_dual_accept) is live, even in part. M4 counts as live when ANY of:
--        (M4-a) proxima_auth.current_account's body no longer contains the literal 'admin: (M4 removes its admin:
--               branch);
--        (M4-b) public._verify_session_token answers 'session token revoked' to a fresh 'admin:<owner name>' token,
--               signed with the current key and issued after the owner's epoch exactly as the pre-M3 issue_session
--               issued one (M4 replaces the admin: branch with an explicit revoke); before M4 that token verifies;
--        (M4-c) public.set_admin_credentials_rehash(text,text) is gone (M4 drops it).
--        Restoring the owner's admin: mint after M4 would hand the owner tokens the verifier revokes at once (every
--        sign-in, password change, rename and unlock would sign the owner out). Roll M4 back first.
--      - compare-and-swap: issue_session must have M3's post-apply body (md5 b9ba44a18b04d17bdf0034b944a57035).
--   1) issue_session recreated from its pre-M3 pg_get_functiondef text, verbatim (captured 2026-10-23 from the live
--      database by a script, not retyped; md5 69fdda20ce11b5dd3d7e588bf44cbac0 = M1's post-apply body).
--   2) post-check: md5 equals the pre-M3 capture, owner/grants/settings unchanged, mint_token(owner id) gives an
--      'admin:<owner name>' token again, and a 'u:<owner id>' token still resolves to the owner (M1 keeps verifying u:,
--      so nobody is signed out).
--   3) M3's own migration record is deleted (supabase_migrations.schema_migrations, version 20261023300000, name
--      mu_p1_mint_u_tokens), in this same transaction. apply-migration.mjs skips a version that is recorded under the
--      same name, so without this a later re-apply of M3 through it would print "already recorded" and change nothing
--      (review m3crit #1/#3). Zero rows is fine: M3 applied by a tool that does not record (sb-query --write -f).
-- Order (design §7): M4 -> this -> M2 (RLS session; its rollback refuses while M3 is live) -> M1b -> M1.
-- M4 timing restarts on a rollback and re-apply: M4 no earlier than 12 h 05 min after the LAST M3 apply (and the last
-- script-minted admin: token, which includes every admin: token minted while this rollback is in effect). M4 itself
-- refuses unless M3 is live (design §4 item 9), so M4 can never land while issue_session mints admin:.
-- Proof: scripts/test-mu-m3-rollback.sql (M3 -> this -> M3 again, the record deleted, and the refusals under a
-- simulated M4).

-- ── 0. Guards ──
do $guard$
declare
  v_m3_post constant text := 'b9ba44a18b04d17bdf0034b944a57035';
  v_m4 text := ''; v_name text; v_ep bigint; v_err text;
begin
  if to_regprocedure('proxima_auth.issue_session(uuid)') is null or to_regclass('proxima_auth.users') is null then
    raise exception 'M3 rollback: proxima_auth.issue_session or proxima_auth.users is missing (M1 not live)';
  end if;
  lock table proxima_auth.users in exclusive mode;
  -- M4-a
  if to_regprocedure('proxima_auth.current_account(text)') is null
     or position('''admin:' in pg_get_functiondef('proxima_auth.current_account(text)'::regprocedure)) = 0 then
    v_m4 := v_m4 || 'current_account has no admin: branch; ';
  end if;
  -- M4-b
  select u.username, u.sessions_valid_after into v_name, v_ep from proxima_auth.users u where u.role = 'owner';
  if v_name is null then raise exception 'M3 rollback: no owner row in proxima_auth.users'; end if;
  begin
    perform public._verify_session_token(public._sign_session_token('admin:' || v_name,
      to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200)));
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err = 'session token revoked' then
    v_m4 := v_m4 || 'the verifier answers revoked for a fresh admin:<owner> token; ';
  elsif v_err is not null then
    raise exception 'M3 rollback: the admin:<owner> probe failed unexpectedly: %', v_err;
  end if;
  -- M4-c
  if to_regprocedure('public.set_admin_credentials_rehash(text,text)') is null then
    v_m4 := v_m4 || 'set_admin_credentials_rehash is dropped; ';
  end if;
  if v_m4 <> '' then
    raise exception 'M3 rollback: M4 is live (%); roll back M4 first', rtrim(v_m4, '; ');
  end if;
  if md5(pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure)) <> v_m3_post then
    raise exception 'M3 rollback compare-and-swap: issue_session differs from M3''s post-apply text (M3 not live, or changed since)';
  end if;
end $guard$;

-- ── 1. The pre-M3 body, verbatim ──
CREATE OR REPLACE FUNCTION proxima_auth.issue_session(p_account uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_u proxima_auth.users; v_issued bigint; v_exp bigint; v_tok text;
begin
  select * into v_u from proxima_auth.users u where u.id = p_account;
  if not found then raise exception 'issue_session: unknown account'; end if;
  v_issued := greatest(extract(epoch from clock_timestamp())::bigint, v_u.sessions_valid_after + 1);
  v_exp := v_issued + 43200;
  v_tok := public._sign_session_token(case when v_u.role = 'owner' then 'admin:' || v_u.username else 'u:' || v_u.id::text end,
                                      to_timestamp(v_exp));
  return jsonb_build_object('token', v_tok, 'expires_at', v_exp, 'username', v_u.username, 'account_id', v_u.id,
                            'role', v_u.role, 'scope', v_u.scope);
end $function$
;

-- ── 2. Post-check ──
do $post$
declare
  v_pre constant text := '69fdda20ce11b5dd3d7e588bf44cbac0';
  v_id uuid; v_name text; v_ep bigint; v_tok text; v_acc proxima_auth.account;
begin
  if md5(pg_get_functiondef('proxima_auth.issue_session(uuid)'::regprocedure)) <> v_pre then
    raise exception 'M3 rollback: restored issue_session differs from the pre-M3 capture';
  end if;
  if (select p.proacl::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.proconfig::text
        from pg_proc p where p.oid = 'proxima_auth.issue_session(uuid)'::regprocedure)
     is distinct from '{postgres=X/postgres}|postgres|true|{"search_path=\"\""}' then
    raise exception 'M3 rollback: issue_session''s grants, owner, definer or search_path changed';
  end if;
  select u.id, u.username, u.sessions_valid_after into v_id, v_name, v_ep from proxima_auth.users u where u.role = 'owner';
  v_tok := proxima_auth.mint_token(v_id);
  if v_tok is null or left(v_tok, length('admin:' || v_name) + 1) <> 'admin:' || v_name || '.' then
    raise exception 'M3 rollback: mint_token(owner id) does not give an admin:<owner> token';
  end if;
  v_acc := proxima_auth.current_account(public._sign_session_token('u:' || v_id::text,
             to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200)));
  if v_acc.id is distinct from v_id then
    raise exception 'M3 rollback: a u:<owner id> token no longer resolves to the owner';
  end if;
end $post$;

-- ── 3. M3's own migration record, so a re-apply through apply-migration.mjs really applies ──
delete from supabase_migrations.schema_migrations where version = '20261023300000' and name = 'mu_p1_mint_u_tokens';
