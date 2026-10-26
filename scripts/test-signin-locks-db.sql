-- Tests for supabase/migrations/20261025920000_signin_locks_no_key.sql: the five account-row locks that change no key are
-- FOR NO KEY UPDATE (they no longer wait for a backup's FOR KEY SHARE, 20261025820000), and rename keeps FOR UPDATE (it
-- changes the scope key). Checked in the bodies: a row lock is not visible in pg_locks unless something waits on it, and an
-- account created inside the test already carries this transaction's lock (users_keep_folder's foreign key), so a
-- same-transaction probe cannot observe the mode (measured by the RLS session, scratchpad p4/lk/xmax-probe.sql).
-- Comments and string literals are stripped first (block comments, line comments, then '...'), so a comment or message that
-- names the table and a lock clause cannot pass or fail the check (as the RLS session's body checks do since its round 11).
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261025920000_signin_locks_no_key.sql --test scripts/test-signin-locks-db.sql
do $t$
declare
  out text := ''; f text; src text; locks text[]; bad text := '';
begin
  foreach f in array array['public.verify_admin(text,text)', 'public.unlock_with_backup_code(text,text,text)', 'proxima_auth._reauth(uuid,text)',
                           'public.set_my_provider_key(text,text,text)', 'public.clear_my_provider_key(text,text)'] loop
    src := lower(pg_get_functiondef(f::regprocedure));
    src := regexp_replace(src, '/\*.*?\*/', ' ', 'g');
    src := regexp_replace(src, '--[^\n]*', '', 'g');
    src := regexp_replace(src, $r$'[^']*'(?:'[^']*')*$r$, '''''', 'g');   -- a doubled '' inside a literal stays inside it
    select array_agg(l) into locks from regexp_split_to_table(src, E'\n') l where l ~ 'proxima_auth\.users' and l ~ 'for (no key )?update';
    if coalesce(array_length(locks, 1), 0) <> 1 or locks[1] !~ 'for no key update' then bad := bad || f || ' '; end if;
  end loop;
  out := out || case when bad = '' then 'ok L1 no-key-locks; ' else format('FAIL L1 %s; ', bad) end;
  src := lower(pg_get_functiondef('public.rename_my_account(text,text,text)'::regprocedure));
  out := out || case when src ~ 'proxima_auth\.users u where u\.id = v_acc\.id for update;' then 'ok L2 rename-keeps-for-update; '
                     else 'FAIL L2 rename lock changed; ' end;
  raise exception 'RESULT: %', out;
end $t$;
