-- Backup scrubs short and one account at a time; a rename takes its new name's sign-in key first (P4, follow-up to
-- 20261025800000 from its review rounds 14-21).
-- 1. _scrub_backups_to_live_items (the switch-off scrub: backed-up History entries trimmed to their live items) builds
--    each backup's History in one statement. The loop appended entry by entry (`v_new := v_new || jsonb_build_array(e)`),
--    copying the growing array each time: quadratic in a backup's size. 3 backups of 1000 entries of 1.7 KB took 2.8 s
--    (measured 2026-10-26; 5.3 s in review round 14) and now take 150 ms. It runs in the per-minute drain and in
--    set_auto_backups(true), a browser call cancelled after 3 s (join_with_invite can wait on that one, see its comment).
--    Same rules as the loop, proven on identical data by scripts/test-scrub-linear-db.sql, but one: an entry with a live
--    History row and no tasks key now stays (the loop dropped it whenever another entry of its backup changed: a null
--    jsonb_typeof failed both of its tests).
-- 2. The per-minute drain commits one account at a time: cron 'backup-scrub-drain' calls the new procedure
--    _drain_backup_scrubs_job(), which drains each account with queued scrubs in its own transaction, with a 2 s lock
--    wait. Before, one transaction drained them all, so each drained account's restore marker and backup rows stayed
--    locked until the last account was done, and one account's lock wait held up every account after it. pg_cron 1.6.4
--    sends each job as a top-level statement (cron.use_background_workers is off), so the procedure may commit.
-- 3. rename_my_account: the new name's sign-in key (join_with_invite and verify_admin take it) before the account row,
--    so a rename and a join of one name run one after the other; the names join_with_invite allows (letters, digits, '_'
--    and '-', 2 to 64; every account's name fits, counted 2026-10-26), so no rename makes a name no account could be
--    created with; a unique violation (users_username_ci, users_keep_folder) answers username_taken and counts against
--    the rename limit instead of failing the call; and the account's queued scrubs move with it (the data_backups
--    trigger moved them only for an account that has a backup).
-- Rollback: supabase/rollback/20261026200000_mu_p4_backup_scrubs_per_account.rollback.sql
set local lock_timeout = '2s';   -- an apply that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s

do $guard$
begin
  if to_regprocedure('public._drain_backup_scrubs_job()') is not null then
    raise exception '20261026200000 is already applied (public._drain_backup_scrubs_job() exists)';
  end if;
  if md5(pg_get_functiondef('public._scrub_backups_to_live_items(text)'::regprocedure)) <> '44eebc31f7ab83d9cd36c18b647a680a'
     or md5(pg_get_functiondef('public.rename_my_account(text,text,text)'::regprocedure)) <> '28e9c3cafe8b1cf735caba095ef6f060'
     or md5(pg_get_functiondef('public._drain_backup_scrubs(text)'::regprocedure)) <> 'c79e4b229c4897d5a2d15dea856668f1'
     or (select count(*) from cron.job where jobname = 'backup-scrub-drain') <> 1
     or (select command from cron.job where jobname = 'backup-scrub-drain') <> 'select public._drain_backup_scrubs()' then
    raise exception 'a function or the drain job is not the one 20261026200000 was written against: rebase this migration';
  end if;
end $guard$;

CREATE OR REPLACE FUNCTION public._scrub_backups_to_live_items(p_username text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  b record; v_new jsonb; v_changed boolean; v_n int := 0;
begin
  -- 20261026200000: one statement per backup (the loop it replaces was quadratic). Per entry: no live History row of
  -- this account, or tasks that are no array on either side (or missing), and it stays as it is; else each task stays
  -- while its id is in the live entry or, id-less, the live entry holds an id-less task equal to it or sharing an output.
  -- An entry keeping all its tasks (an empty tasks array keeps all) stays as it is, one keeping some gets those tasks and
  -- their completed cost as total_cost, one keeping none goes.
  for b in select d.id, d.history_snapshot from data_backups d
            where d.username = p_username and jsonb_typeof(d.history_snapshot) = 'array' loop
    select coalesce(jsonb_agg(case when s.kept is null or s.kept_n = s.all_n then s.e
                                   else jsonb_set(jsonb_set(s.e, '{tasks}', s.kept), '{total_cost}', to_jsonb(s.cost)) end
                              order by s.ord) filter (where s.kept is null or s.kept_n > 0 or s.kept_n = s.all_n), '[]'::jsonb),
           coalesce(bool_or(s.kept is not null and s.kept_n < s.all_n), false)
      into v_new, v_changed
      from (select x.ord, x.e, k.kept, k.cost, coalesce(jsonb_array_length(k.kept), 0) as kept_n,
                   case when jsonb_typeof(x.e->'tasks') = 'array' then jsonb_array_length(x.e->'tasks') else 0 end as all_n
              from jsonb_array_elements(b.history_snapshot) with ordinality x(e, ord)
              left join history h on h.id = x.e->>'id' and h.device_id = p_username
              left join lateral (
                select case when h.tasks is null or jsonb_typeof(h.tasks) <> 'array' or jsonb_typeof(x.e->'tasks') is distinct from 'array' then null
                            else coalesce(jsonb_agg(i.item order by i.n) filter (where i.keep), '[]'::jsonb) end as kept,
                       coalesce(sum(case when i.keep and i.item->>'status' = 'completed' and jsonb_typeof(i.item->'cost') = 'number'
                                         then (i.item->>'cost')::numeric end), 0) as cost
                  from (select t.item, t.n,
                               (coalesce(t.item->>'id', '') <> '' and exists (
                                  select 1 from jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) l
                                   where l->>'id' = t.item->>'id'))
                               or (coalesce(t.item->>'id', '') = '' and exists (
                                  select 1 from jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) l
                                   where coalesce(l->>'id', '') = ''
                                     and (l = t.item or exists (
                                       select 1
                                         from jsonb_array_elements_text(case when jsonb_typeof(l->'outputs') = 'array' then l->'outputs' else '[]'::jsonb end) lo,
                                              jsonb_array_elements_text(case when jsonb_typeof(t.item->'outputs') = 'array' then t.item->'outputs' else '[]'::jsonb end) io
                                        where lo.value = io.value)))) as keep
                          from jsonb_array_elements(case when jsonb_typeof(x.e->'tasks') = 'array' then x.e->'tasks' else '[]'::jsonb end)
                               with ordinality t(item, n)) i
              ) k on true) s;
    if v_changed then
      update data_backups d set
        history_snapshot = v_new,
        history_count = greatest(coalesce(d.history_count, 0) - (jsonb_array_length(b.history_snapshot) - jsonb_array_length(v_new)), 0)
      where d.id = b.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $function$;
revoke execute on function public._scrub_backups_to_live_items(text) from public, anon, authenticated;

-- The per-minute drain, one account per transaction. A procedure that commits can have neither SECURITY DEFINER nor a
-- SET clause, so every name in it is schema-qualified; only postgres (the cron job's user) may run it. One account's
-- failure is logged and never stops the others (_drain_backup_scrubs also counts it on the account's queue rows).
CREATE PROCEDURE public._drain_backup_scrubs_job()
 LANGUAGE plpgsql
AS $procedure$
declare
  v_user text;
begin
  for v_user in select distinct q.username from public.backup_scrub_queue q order by 1 loop
    begin
      perform pg_catalog.set_config('lock_timeout', '2s', true);
      perform public._drain_backup_scrubs(v_user);
    exception when others then
      raise warning '_drain_backup_scrubs_job: an account''s drain failed: % %', sqlstate, sqlerrm;
    end;
    commit;
  end loop;
end $procedure$;
revoke execute on procedure public._drain_backup_scrubs_job() from public, anon, authenticated;
select cron.alter_job(j.jobid, command := 'call public._drain_backup_scrubs_job()') from cron.job j where j.jobname = 'backup-scrub-drain';

CREATE OR REPLACE FUNCTION public.rename_my_account(p_session_token text, p_current_password text, p_new_username text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_old text; v_new text := trim(p_new_username); v_auth text; v_s jsonb; v_u proxima_auth.users; v_taken boolean;
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  v_old := v_acc.username;
  -- 20261026200000: the names join_with_invite allows, so no rename makes a name no account could be created with (the
  -- old rule allowed other characters, and two names differing only in them share one folder).
  if v_new is null or v_new !~ '^[A-Za-z0-9_-]{2,64}$' then
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  -- 20261026200000: the new name's sign-in key before the account row (join_with_invite and verify_admin take it):
  -- a rename and a join of one name run one after the other, so each one's check below sees the other's name.
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(v_new), 0));
  select * into v_u from proxima_auth.users u where u.id = v_acc.id for update;
  if v_u.rename_taken_since > now() - interval '1 hour' and v_u.rename_taken_count >= 5 then
    return json_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  v_auth := proxima_auth._reauth(v_acc.id, p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  if v_new <> v_old then
    v_taken := exists (select 1 from proxima_auth.users u where lower(u.username) = lower(v_new) and u.id <> v_acc.id)
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
                   where f.folder = proxima_auth.scope_folder('user:' || v_new) and f.account_id <> v_acc.id);
    if not v_taken then
      perform set_config('proxima.rescope', 'on', true);
      -- Restores and replayed deletes take this account's restore marker before its rows (20261022230000); so does a
      -- rename, so no two of them wait on each other in opposite orders (review round 5).
      insert into settings (device_id, key, value) values (v_acc.scope, 'last_restore_at', '0'::jsonb)
        on conflict (device_id, key) do nothing;
      perform 1 from settings where device_id = v_acc.scope and key = 'last_restore_at' for update;
      perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: another rename may have run
      if (proxima_auth.current_account(p_session_token)).scope is distinct from v_acc.scope then raise exception 'session token revoked'; end if;
      begin
        update proxima_auth.users set username = v_new, scope = 'user:' || v_new, updated_at = now() where id = v_acc.id;
      exception when unique_violation then   -- 20261026200000: taken by something the checks above cannot see
        v_taken := true;
      end;
    end if;
    if v_taken then
      perform set_config('proxima.rescope', 'off', true);
      update proxima_auth.users
         set rename_taken_count = case when rename_taken_since > now() - interval '1 hour' then rename_taken_count + 1 else 1 end,
             rename_taken_since = case when rename_taken_since > now() - interval '1 hour' then rename_taken_since else now() end
       where id = v_acc.id;
      raise log 'rename_my_account: username_taken for account %', v_acc.id;
      return json_build_object('ok', false, 'reason', 'username_taken');
    end if;
    update tasks set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update history set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update favorites set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update presets set device_id = 'user:' || v_new where device_id = v_acc.scope;
    delete from settings where device_id = 'user:' || v_new and key = 'last_restore_at';   -- a leftover marker of the target name
    update settings set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update sync_tombstones set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update user_secrets set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update backup_scrub_queue set username = 'user:' || v_new where username = v_acc.scope;   -- 20261026200000
    update data_backups set username = 'user:' || v_new where username = v_acc.scope;
    perform set_config('proxima.rescope', 'off', true);
    perform proxima_auth._revoke_sessions(v_acc.id);
  end if;
  v_s := proxima_auth.issue_session(v_acc.id);
  return json_build_object('ok', true, 'username', v_new,
    'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint);
end $function$;
