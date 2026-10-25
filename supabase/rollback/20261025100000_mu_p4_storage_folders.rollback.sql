-- Rollback of supabase/migrations/20261025100000_mu_p4_storage_folders.sql (exact inverse). Proof, with the other P4
-- rollbacks, in ONE rolled-back call: scripts/test-mu-p4-rollback.sql (its header has both orders).
-- Kept OUT of supabase/migrations/ so `supabase db push` never applies it.
-- With a second account in proxima_auth.users this rollback reopens every file to every valid session: run it only
-- while the owner is the only account, or not at all.
-- md5 guard (review round 2, c3 #2): the bodies this file restores must still be the ones 20261025100000 installed;
-- otherwise someone changed them since, and restoring the old text would undo that change.
do $rbguard$
begin
  if md5(pg_get_functiondef('public.rename_my_account(text,text,text)'::regprocedure)) <> '28e9c3cafe8b1cf735caba095ef6f060' then
    raise exception 'refusing the 20261025100000 rollback: a function it restores changed since the migration (write a new rollback from the live body)';
  end if;
end $rbguard$;

do $rb$
begin
  if (select count(*) from proxima_auth.users) > 1 then
    raise exception 'refusing the storage-folder rollback: % accounts exist, and it would open every file to all of them',
      (select count(*) from proxima_auth.users);
  end if;
end $rb$;

alter policy "generations session select" on storage.objects
  using (bucket_id = 'generations' and (select proxima_auth.session_scope(false)) is not null);
alter policy "generations session insert" on storage.objects
  with check (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null);
alter policy "generations session update" on storage.objects
  using (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null)
  with check (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null);
alter policy "generations session delete" on storage.objects
  using (bucket_id = 'generations' and (select proxima_auth.session_scope(true)) is not null);

-- rename_my_account as it was (live body of 2026-10-25, md5 52480f48…).
CREATE OR REPLACE FUNCTION public.rename_my_account(p_session_token text, p_current_password text, p_new_username text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_old text; v_new text := trim(p_new_username); v_auth text; v_s jsonb; v_u proxima_auth.users;
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  v_old := v_acc.username;
  if v_new is null or length(v_new) < 2 or length(v_new) > 64 or v_new ~ '[.:/\s]' then
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  select * into v_u from proxima_auth.users u where u.id = v_acc.id for update;
  if v_u.rename_taken_since > now() - interval '1 hour' and v_u.rename_taken_count >= 5 then
    return json_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  v_auth := proxima_auth._reauth(v_acc.id, p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  if v_new <> v_old then
    if exists (select 1 from proxima_auth.users u where lower(u.username) = lower(v_new) and u.id <> v_acc.id)
       or exists (select 1 from tasks x where x.device_id = 'user:' || v_new)
       or exists (select 1 from history x where x.device_id = 'user:' || v_new)
       or exists (select 1 from favorites x where x.device_id = 'user:' || v_new)
       or exists (select 1 from presets x where x.device_id = 'user:' || v_new)
       or exists (select 1 from settings x where x.device_id = 'user:' || v_new and x.key <> 'last_restore_at')
       or exists (select 1 from sync_tombstones x where x.device_id = 'user:' || v_new)
       or exists (select 1 from user_secrets x where x.device_id = 'user:' || v_new)
       or exists (select 1 from data_backups x where x.username = 'user:' || v_new) then
      update proxima_auth.users
         set rename_taken_count = case when rename_taken_since > now() - interval '1 hour' then rename_taken_count + 1 else 1 end,
             rename_taken_since = case when rename_taken_since > now() - interval '1 hour' then rename_taken_since else now() end
       where id = v_acc.id;
      raise log 'rename_my_account: username_taken for account %', v_acc.id;
      return json_build_object('ok', false, 'reason', 'username_taken');
    end if;
    perform set_config('proxima.rescope', 'on', true);
    -- Restores and replayed deletes take this account's restore marker before its rows (20261022230000); so does a
    -- rename, so no two of them wait on each other in opposite orders (review round 5).
    insert into settings (device_id, key, value) values (v_acc.scope, 'last_restore_at', '0'::jsonb)
      on conflict (device_id, key) do nothing;
    perform 1 from settings where device_id = v_acc.scope and key = 'last_restore_at' for update;
    perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: another rename may have run
    if (proxima_auth.current_account(p_session_token)).scope is distinct from v_acc.scope then raise exception 'session token revoked'; end if;
    update proxima_auth.users set username = v_new, scope = 'user:' || v_new, updated_at = now() where id = v_acc.id;
    update tasks set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update history set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update favorites set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update presets set device_id = 'user:' || v_new where device_id = v_acc.scope;
    delete from settings where device_id = 'user:' || v_new and key = 'last_restore_at';   -- a leftover marker of the target name
    update settings set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update sync_tombstones set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update user_secrets set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update data_backups set username = 'user:' || v_new where username = v_acc.scope;
    perform set_config('proxima.rescope', 'off', true);
    perform proxima_auth._revoke_sessions(v_acc.id);
  end if;
  v_s := proxima_auth.issue_session(v_acc.id);
  return json_build_object('ok', true, 'username', v_new,
    'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint);
end $function$
;

drop trigger users_keep_folder on proxima_auth.users;
drop function proxima_auth._users_keep_folder();
drop function proxima_auth.my_folders(boolean);
drop function proxima_auth.object_folder(text);
drop table proxima_auth.account_folders;
drop function proxima_auth.scope_folder(text);

-- The migration's own record goes with it, in the same transaction, so a later apply re-applies it.
delete from supabase_migrations.schema_migrations where version = '20261025100000' and name = 'mu_p4_storage_folders';
