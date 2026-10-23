-- Gate fixture for M2 (run between M1 and M2 by sql-tx, so it is rolled back): the owner renames in the M1-only window.
-- The real rename_my_account runs (name and scope, every row moved, epoch bumped); the owner row gets a known cost-4
-- password first, inside this rolled-back run only. M1's guard keeps the frozen app_secrets rows where they were.
do $fx$
declare v_id uuid; v_r json;
begin
  update proxima_auth.users set password_hash = extensions.crypt('mu-fx-pass-0001', extensions.gen_salt('bf', 4))
   where role = 'owner' returning id into v_id;
  v_r := public.rename_my_account(proxima_auth.mint_token(v_id), 'mu-fx-pass-0001', '__mu_fx_renamed');
  if not coalesce((v_r->>'ok')::boolean, false) then
    raise exception 'fixture: the rename failed (%)', coalesce(v_r->>'reason', 'no reason');
  end if;
end $fx$;
