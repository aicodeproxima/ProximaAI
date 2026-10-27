-- Rollback of supabase/migrations/20261026200000_mu_p4_backup_scrubs_per_account.sql (exact inverse: the two function
-- bodies below are the live ones it replaced, saved byte for byte before it; the drain job gets its old command back and
-- the procedure goes). Kept OUT of supabase/migrations/.
set local lock_timeout = '2s';   -- a rollback that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s

-- md5 guard: what this file restores or removes must still be what 20261026200000 installed.
do $rbguard$
begin
  if to_regprocedure('public._drain_backup_scrubs_job()') is null then
    raise exception 'refusing the 20261026200000 rollback: 20261026200000 is not applied (no public._drain_backup_scrubs_job())';
  end if;
  if md5(pg_get_functiondef('public._scrub_backups_to_live_items(text)'::regprocedure)) <> '993fd502c472244247610a928a029e68'
     or md5(pg_get_functiondef('public.rename_my_account(text,text,text)'::regprocedure)) <> 'b5d44cfb20032ce52071dc26852265e5'
     or md5(pg_get_functiondef('public._drain_backup_scrubs_job()'::regprocedure)) <> '98d0af1bf50fc4090d3283d04ad000cb'
     or (select count(*) from cron.job where jobname = 'backup-scrub-drain') <> 1
     or (select command from cron.job where jobname = 'backup-scrub-drain') <> 'call public._drain_backup_scrubs_job()' then
    raise exception 'refusing the 20261026200000 rollback: something it restores changed since the migration (write a new rollback from the live state)';
  end if;
end $rbguard$;

select cron.alter_job(j.jobid, command := 'select public._drain_backup_scrubs()') from cron.job j where j.jobname = 'backup-scrub-drain';
drop procedure public._drain_backup_scrubs_job();

CREATE OR REPLACE FUNCTION public._scrub_backups_to_live_items(p_username text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  b record; e jsonb; i jsonb; live jsonb;
  v_new jsonb; v_kept jsonb; v_cost numeric; v_changed boolean; v_n int := 0;
begin
  for b in select d.id, d.history_snapshot from data_backups d
            where d.username = p_username and jsonb_typeof(d.history_snapshot) = 'array' loop
    v_new := '[]'::jsonb; v_changed := false;
    for e in select x from jsonb_array_elements(b.history_snapshot) x loop
      live := null;
      select h.tasks into live from history h where h.id = e->>'id' and h.device_id = p_username;
      if live is null or jsonb_typeof(live) <> 'array' or jsonb_typeof(e->'tasks') <> 'array' then
        v_new := v_new || jsonb_build_array(e);
        continue;
      end if;
      v_kept := '[]'::jsonb; v_cost := 0;
      for i in select y from jsonb_array_elements(e->'tasks') y loop
        if (coalesce(i->>'id', '') <> '' and exists (select 1 from jsonb_array_elements(live) l where l->>'id' = i->>'id'))
           or (coalesce(i->>'id', '') = '' and exists (
                 select 1 from jsonb_array_elements(live) l
                  where coalesce(l->>'id', '') = ''
                    and (l = i or exists (
                      select 1
                        from jsonb_array_elements_text(case when jsonb_typeof(l->'outputs') = 'array' then l->'outputs' else '[]'::jsonb end) lo,
                             jsonb_array_elements_text(case when jsonb_typeof(i->'outputs') = 'array' then i->'outputs' else '[]'::jsonb end) io
                       where lo.value = io.value)))) then
          v_kept := v_kept || jsonb_build_array(i);
          if i->>'status' = 'completed' and jsonb_typeof(i->'cost') = 'number' then v_cost := v_cost + (i->>'cost')::numeric; end if;
        else
          v_changed := true;
        end if;
      end loop;
      if jsonb_array_length(v_kept) = jsonb_array_length(e->'tasks') then
        v_new := v_new || jsonb_build_array(e);
      elsif jsonb_array_length(v_kept) > 0 then
        v_new := v_new || jsonb_build_array(jsonb_set(jsonb_set(e, '{tasks}', v_kept), '{total_cost}', to_jsonb(v_cost)));
      end if;
    end loop;
    if v_changed then
      update data_backups d set
        history_snapshot = v_new,
        history_count = greatest(coalesce(d.history_count, 0) - (jsonb_array_length(b.history_snapshot) - jsonb_array_length(v_new)), 0)
      where d.id = b.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $function$
;
revoke execute on function public._scrub_backups_to_live_items(text) from public, anon, authenticated;

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
       or exists (select 1 from data_backups x where x.username = 'user:' || v_new)
       -- 20261025100000: a folder some other account holds (its old name, or a spelling of the same folder) is taken too.
       or exists (select 1 from proxima_auth.account_folders f
                   where f.folder = proxima_auth.scope_folder('user:' || v_new) and f.account_id <> v_acc.id) then
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
