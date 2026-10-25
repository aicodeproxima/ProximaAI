-- Multi-user P4 definer audit: backups and restores judge "gone" and "in use" in the caller's own account only
-- (review round 3 of the P4 walls). Task, History and favorite ids are unique across accounts (their key is (id)), so a
-- member who learns a deleted id (an archived output's public path holds its task id) can create a row with it. Until
-- now that row kept the deleted item in the other account's backups (_drain_backup_scrubs and the restore's own scrub
-- asked "does a row with this id exist" in every account) and made that account's restore of any backup holding the id
-- fail on the duplicate key. Now the scrubs look in the account's own rows, and the restore leaves such ids out and
-- reports them as skipped_in_use, and never scrubs anything the restored backup holds (review round 4). A left-out id
-- stays deleted in this account: its tombstone stays, so the account's other devices drop it instead of uploading it
-- into a refused batch (review round 6), and its backup copies stay until a later scrub applies that delete again
-- (switching Automatic backups off). The root fix (those tables keyed (device_id, id)) needs the client's upserts to
-- name the new key first, and its step (c) removes the left-out filter again; until then this keeps one account from
-- touching another's backups. For one account nothing changes.
-- Both functions belong to the lockdown session (backup and restore area): only the lines below change, and the
-- migration refuses if either body moved since 2026-10-25.
-- Rollback: supabase/rollback/20261025400000_mu_p4_squat_proof_backups.rollback.sql
set local lock_timeout = '5s';   -- an apply that cannot take its locks within 5 s stops instead of queueing the app

do $guard$
begin
  if md5(pg_get_functiondef('public._drain_backup_scrubs(text)'::regprocedure)) <> '9da18e78ab73b9d1395bd7997bb1dd49'
     or md5(pg_get_functiondef('public.restore_my_backup_phase2(text,uuid)'::regprocedure)) <> '78079d1b4ab6d4178f05295e4d9b3661' then
    raise exception 'a backup or restore function changed since 20261025400000 was written: rebase it on the live bodies';
  end if;
end $guard$;

CREATE OR REPLACE FUNCTION public._drain_backup_scrubs(p_username text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_user text; v_t text[]; v_l text[]; v_o text[]; v_all boolean; v_n int := 0;
begin
  for v_user in select distinct q.username from backup_scrub_queue q where p_username is null or q.username = p_username loop
    begin
      insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
      perform 1 from settings where device_id = v_user and key = 'last_restore_at' for share;   -- the account's restore marker first
      with taken as (
        delete from backup_scrub_queue q where q.username = v_user
        returning q.task_ids, q.log_ids, q.outputs, q.all_tombstones)
      select coalesce((select array_agg(distinct x) from taken, unnest(taken.task_ids) x), '{}'),
             coalesce((select array_agg(distinct x) from taken, unnest(taken.log_ids) x), '{}'),
             coalesce((select array_agg(distinct x) from taken, unnest(taken.outputs) x), '{}'),
             coalesce((select bool_or(taken.all_tombstones) from taken), false)
        into v_t, v_l, v_o, v_all;
      if v_all then
        v_t := v_t || array(select st.id from sync_tombstones st
                             where st.device_id = v_user and st.kind = 'task'
                               and not exists (select 1 from tasks t where t.id = st.id and t.device_id = v_user));
        v_l := v_l || array(select st.id from sync_tombstones st
                             where st.device_id = v_user and st.kind = 'history'
                               and not exists (select 1 from history h where h.id = st.id and h.device_id = v_user));
      end if;
      -- Only what is gone: a generation (its tasks row, or an item of a live History entry), an entry or an output that
      -- is still live keeps its backup copies. 20261025400000: gone or live in THIS account; a row of another account
      -- with the same id (ids are unique across accounts until those tables are keyed by account) keeps nothing here.
      v_t := array(select x from unnest(v_t) x where not exists (select 1 from tasks t where t.id = x and t.device_id = v_user)
                    and not (x in (select e.item->>'id' from history h,
                                     jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                                    where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')   -- no NULLs: x in (.., null) is never false
                             and not exists (select 1 from sync_tombstones st where st.device_id = v_user and st.kind = 'task'
                                                and st.id = x and not coalesce(st.by_restore, false))));
      v_l := array(select x from unnest(v_l) x where not exists (select 1 from history h where h.id = x and h.device_id = v_user));
      v_o := array(select o from unnest(v_o) o
                    where not exists (select 1 from tasks t where t.device_id = v_user and position(o in t.outputs::text) > 0)
                      and not exists (select 1 from history h where h.device_id = v_user and position(o in h.tasks::text) > 0));
      v_n := v_n + public._scrub_backups(v_user, v_t, v_l, v_o);
      if v_all then
        v_n := v_n + public._scrub_backups_to_live_items(v_user);
      end if;
    exception when others then
      update backup_scrub_queue set attempts = attempts + 1, last_error = left(sqlerrm, 500) where username = v_user;
    end;
  end loop;
  return v_n;
end $function$
;

CREATE OR REPLACE FUNCTION public.restore_my_backup_phase2(p_session_token text, p_backup_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_acc      proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_username text := v_acc.scope;
  v_backup   record;
  v_tasks int := 0; v_history int := 0; v_favorites int := 0;
  v_rt text[]; v_rl text[]; v_prev_items text[];
  v_skip_t int := 0; v_skip_h int := 0; v_skip_f int := 0;   -- 20261025400000: snapshot ids another account holds
  v_keep_t text[]; v_keep_h text[];                            -- 20261025400000: ids the restored backup holds
  v_skip_ids_t text[]; v_skip_ids_h text[]; v_skip_ids_f text[];  -- 20261025400000: the ids left out
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Restores and replayed deletes take this account's restore marker first (delete_queued_rows): a delete queued before
  -- this restore waits for it and is then refused; it can never run in the middle of it.
  insert into settings (device_id, key, value) values (v_username, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  perform 1 from settings where device_id = v_username and key = 'last_restore_at' for update;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have moved the account
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_username then raise exception 'session token revoked'; end if;
  perform public._drain_backup_scrubs(v_username);
  if exists (select 1 from backup_scrub_queue q where q.username = v_username) then
    return json_build_object('ok', false, 'reason', 'Deleted items are still being removed from your backups. Try again in a minute.');
  end if;
  select * into v_backup from data_backups where id = p_backup_id and username = v_username;
  if not found then return json_build_object('ok', false, 'reason', 'backup_not_found'); end if;
  begin
    if public._auto_backups_on() then
      insert into data_backups (id, username, backup_type, task_count, history_count, settings_snapshot,
                                favorites_snapshot, tasks_snapshot, history_snapshot, note)
      select gen_random_uuid(), v_username, 'pre-restore',
        (select count(*) from tasks where device_id = v_username),
        (select count(*) from history where device_id = v_username),
        coalesce((select jsonb_object_agg(key, value) from settings where device_id = v_username and key not like 'form-inputs:%'), '{}'::jsonb),
        coalesce((select jsonb_agg(row_to_json(f)) from (select * from favorites where device_id = v_username) f), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(t)) from (select * from tasks where device_id = v_username order by start_time desc limit 500) t), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(h)) from (select * from history where device_id = v_username order by timestamp desc limit 1000) h), '[]'::jsonb),
        'auto safety snapshot before restoring backup ' || p_backup_id::text;
    end if;
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where device_id = v_username;
    -- The History item ids before the replacement (a History-only generation the restore drops is replaced too).
    v_prev_items := array(select distinct e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username and coalesce(e.item->>'id', '') <> '');
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username and key not like 'form-inputs:%' and key <> 'last_restore_at';
    -- 20261025400000 (review round 3): an id another account holds right now (task, History and favorite ids are
    -- unique across accounts until those tables are keyed by account) is left out and counted, instead of failing
    -- the whole restore on its duplicate key. This account's own rows were deleted just above.
    v_skip_ids_t := array(select e->>'id'
      from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e
     where exists (select 1 from tasks t where t.id = e->>'id' and t.device_id <> v_username));
    v_skip_t := cardinality(v_skip_ids_t);
    insert into tasks select r.* from jsonb_populate_recordset(null::tasks, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e)) r
     where not exists (select 1 from tasks t where t.id = r.id and t.device_id <> v_username);
    get diagnostics v_tasks = row_count;
    v_skip_ids_h := array(select e->>'id'
      from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e
     where exists (select 1 from history h where h.id = e->>'id' and h.device_id <> v_username));
    v_skip_h := cardinality(v_skip_ids_h);
    insert into history select r.* from jsonb_populate_recordset(null::history, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e)) r
     where not exists (select 1 from history h where h.id = r.id and h.device_id <> v_username);
    get diagnostics v_history = row_count;
    -- A generation this restore brings back in History is the restore's decision, not a user delete: an older user
    -- tombstone of its id becomes a restore removal (by_restore), so the backup scrub and the History strip treat
    -- it as live while History holds it (review round 5).
    update sync_tombstones st set by_restore = true
     where st.device_id = v_username and st.kind = 'task' and not coalesce(st.by_restore, false)
       and st.id in (select e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username);
    perform set_config('proxima.restore', 'off', true);
    v_skip_ids_f := array(select e->>'id'
      from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e
     where exists (select 1 from favorites f where f.id = e->>'id' and f.device_id <> v_username));
    v_skip_f := cardinality(v_skip_ids_f);
    insert into favorites select r.* from jsonb_populate_recordset(null::favorites, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e)) r
     where not exists (select 1 from favorites f where f.id = r.id and f.device_id <> v_username);
    get diagnostics v_favorites = row_count;
    insert into settings (device_id, key, value)
      select v_username, k.key, k.value from jsonb_each(coalesce(v_backup.settings_snapshot, '{}'::jsonb)) k where k.key <> 'apiKey' and k.key not like 'form-inputs:%' and k.key <> 'last_restore_at'
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
    -- When this restore happened (epoch ms; after the snapshot's own settings, so an older value in it never wins):
    -- every device drops delete intents it queued before it (review round 2), so a clear still pending on the other
    -- device cannot delete what this restore brought back.
    insert into settings (device_id, key, value) values (v_username, 'last_restore_at', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  exception when others then
    perform set_config('proxima.restore', 'off', true);
    return json_build_object('ok', false, 'reason', sqlerrm);
  end;
  -- Owner ruling on review wf_ec400a67-988 #11 (2026-10-22, "Scrub them right away"): with Automatic backups off, the
  -- rows this restore replaced (its by_restore tombstones, stamped in this transaction, not live again) leave every
  -- backup now, as any delete would; the result never depends on a later toggle of the switch.
  if not public._auto_backups_on() then
    v_rt := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'task'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from tasks t where t.id = st.id and t.device_id = v_username));
    v_rt := v_rt || array(select x from unnest(coalesce(v_prev_items, '{}')) x
                          where not exists (select 1 from tasks t where t.id = x and t.device_id = v_username) and not (x = any(v_rt)));
    v_rl := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'history'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from history h where h.id = st.id and h.device_id = v_username));
    -- 20261025400000 (review round 4): nothing the restored backup holds is scrubbed by this restore. An id left out
    -- above because another account holds it would otherwise be judged gone here and removed from every backup.
    v_keep_t := array(select e->>'id' from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e
                       where coalesce(e->>'id', '') <> ''
                      union
                      select i->>'id' from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) hs,
                             jsonb_array_elements(case when jsonb_typeof(hs->'tasks') = 'array' then hs->'tasks' else '[]'::jsonb end) i
                       where coalesce(i->>'id', '') <> '');
    v_keep_h := array(select e->>'id' from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e
                       where coalesce(e->>'id', '') <> '');
    v_rt := array(select x from unnest(v_rt) x where not (x = any(v_keep_t)));
    v_rl := array(select x from unnest(v_rl) x where not (x = any(v_keep_h)));
    if cardinality(v_rt) > 0 or cardinality(v_rl) > 0 then
      insert into backup_scrub_queue (username, task_ids, log_ids) values (v_username, v_rt, v_rl);
      perform public._drain_backup_scrubs(v_username);
    end if;
  end if;
  -- The clock at the restore's end (review round 8): intents queued while it ran are voided too.
  update settings set value = to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), updated_at = now()
   where device_id = v_username and key = 'last_restore_at';
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites,
                           'skipped_in_use', v_skip_t + v_skip_h + v_skip_f);
end $function$
;

set local lock_timeout to default;   -- the 5 s limit covers this migration only, not what runs after it in one transaction
