-- Gate fixture for M2 (run between M1 and M2 by sql-tx, so it is rolled back): the owner row moves in the M1-only
-- window the way a stranger can force it. Three wrong passwords lock the owner's name, then the owner unlocks with the
-- backup code, which bumps the owner's epoch. The real M1 functions run; the owner row gets a known cost-4 backup code
-- first, inside this rolled-back run only. M1's guard keeps the frozen app_secrets rows where they were.
do $fx$
declare v_name text; v_r json;
begin
  update proxima_auth.users set backup_code_hash = extensions.crypt('mu-fx-code-0001', extensions.gen_salt('bf', 4))
   where role = 'owner' returning username into v_name;
  for i in 1..3 loop
    perform public.verify_admin(v_name, 'mu-fx-wrong-' || i);
  end loop;
  if (select login_locked_at from proxima_auth.users where role = 'owner') is null then
    raise exception 'fixture: three wrong passwords did not lock the owner';
  end if;
  v_r := public.unlock_with_backup_code(v_name, 'mu-fx-code-0001', null);
  if not coalesce((v_r->>'ok')::boolean, false) then
    raise exception 'fixture: the backup-code unlock failed (%)', v_r->>'reason';
  end if;
end $fx$;
