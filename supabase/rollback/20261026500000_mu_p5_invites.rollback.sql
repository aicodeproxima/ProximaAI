-- Rollback for supabase/migrations/20261026500000_mu_p5_invites.sql: drops the four invite functions, their helpers, the
-- invites table and the members switch. Refuses while a member account exists (removing one is account deletion, P5).
-- Proof (rolled back; every case must FAIL again, as before the migration):
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261026500000_mu_p5_invites.sql supabase/rollback/20261026500000_mu_p5_invites.rollback.sql --test scripts/test-invites-db.sql

do $guard$
begin
  if exists (select 1 from proxima_auth.users where role = 'member') then
    raise exception '20261026500000 rollback: a member account exists; delete it first (P5), then roll back';
  end if;
end $guard$;

drop function public.join_with_invite(text, text, text), public.revoke_invite(text, uuid), public.list_my_invites(text),
  public.create_invite(text, text);
drop function proxima_auth._username_taken(text), proxima_auth._random_code(int), proxima_auth._invite_code_hash(text);
drop table proxima_auth.invites;
alter table proxima_auth.auth_config drop column members_open;

delete from supabase_migrations.schema_migrations where version = '20261026500000' and name = 'mu_p5_invites';
