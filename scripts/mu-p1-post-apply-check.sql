-- P1 M1 post-apply check (docs/P1-AUTH-DESIGN.md §2; review round 17 #2/#4/#5). READ-ONLY; run right after M1 commits
-- (and any time until M4):
--   node scripts/tools/sb-query.mjs -f scripts/mu-p1-post-apply-check.sql
-- M1 freezes the 9 app_secrets account rows its seed copied: in the same transaction, after the seed, it creates the
-- guard triggers app_secrets_m1_frozen (BEFORE INSERT OR UPDATE OR DELETE, per row) and app_secrets_m1_frozen_truncate
-- (BEFORE TRUNCATE) on public.app_secrets, both calling proxima_auth.m1_frozen_guard(), which refuses every write of
-- those keys (errcode 55000). An old-code call that was blocked on M1's lock fails at its first write after the commit
-- and rolls back whole (the client shows an error; a retry runs the new code), so nothing is ever left to copy.
-- Prints ONE row: same (true when every frozen key's md5(value::text) still equals proxima_auth.m1_seed_snapshot AND
-- both guard triggers exist, call the guard and are enabled), changed_keys (the frozen keys whose md5 differs, never a
-- value) and guard ('on', or how many of the 2 triggers are in place). same is true always: anything else means
-- something bypassed or removed the guard; stop and investigate (there is no re-copy).
-- Proof: scripts/test-mu-frozen-guard.sql (embeds this query verbatim; the M1 generator asserts it and this key list).
select c.k = '' and g.n = 2 as same, c.k as changed_keys,
       case when g.n = 2 then 'on' else format('%s of 2 triggers in place', g.n) end as guard
  from (select coalesce(string_agg(x.key, ', ' order by x.key), '') as k
          from unnest(array['admin_username', 'admin_password_hash', 'admin_backup_code_hash', 'admin_email',
                            'admin_email_verified', 'admin_last_verified_at', 'admin_sessions_valid_after',
                            'admin_login_lockout', 'admin_backup_attempts']) x(key)
         where (select md5(a.value::text) from public.app_secrets a where a.key = x.key)
               is distinct from (select m.value_md5 from proxima_auth.m1_seed_snapshot m where m.key = x.key)) c,
       (select count(*) as n
          from pg_trigger t
         where t.tgrelid = 'public.app_secrets'::regclass
           and t.tgfoid = to_regprocedure('proxima_auth.m1_frozen_guard()')
           and t.tgenabled in ('O', 'A')
           -- tgtype 31 = ROW | BEFORE | INSERT | DELETE | UPDATE; 34 = BEFORE | TRUNCATE (per statement)
           and ((t.tgname = 'app_secrets_m1_frozen' and t.tgtype = 31)
                or (t.tgname = 'app_secrets_m1_frozen_truncate' and t.tgtype = 34))) g;
