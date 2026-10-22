-- "Delete means delete" (owner, 2026-10-21). Review findings #5, #6, #9, #11 (2026-10-21):
-- Backup copies of deleted generations and History are removed by the server, queued in the change's own transaction.
-- Statement-level triggers queue the deleted ids (and the deleted rows' outputs) whenever Automatic backups is off and
-- the change is not a restore:
--   tasks   AFTER DELETE  - every generation deleted (bulk delete, Clear Outputs, Reset, a replayed delete, any device);
--   history AFTER DELETE  - every History entry deleted (log delete, Clear Logs, Reset, a generation delete);
--   history AFTER UPDATE  - items a rewrite dropped (a partly deleted batch, including items whose task row never
--                           reached the cloud, and items saved before 2026-10-20 without an id, matched by outputs).
-- pg_cron drains the queue every minute; restore drains it first and refuses while anything is left, so a backup is
-- never restored with a deleted generation still in it. Scrubbing inline would run under anon's 3 s statement_timeout,
-- and a timeout would roll back the owner's delete. The scrub mirrors batchLog.js purgeLogsForDeleted: an entry left
-- without items goes, and total_cost is the sum of cost over completed items (batchLog totalOf).

create table if not exists public.backup_scrub_queue (
  id         bigint generated always as identity primary key,
  username   text        not null,
  task_ids   text[]      not null default '{}',
  log_ids    text[]      not null default '{}',
  outputs    text[]      not null default '{}',
  attempts   integer     not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists backup_scrub_queue_user_idx on public.backup_scrub_queue (username, id);
alter table public.backup_scrub_queue enable row level security;   -- no policies: browser roles see nothing
revoke all on public.backup_scrub_queue from public, anon, authenticated;

create or replace function public._jlen(j jsonb) returns integer
language sql immutable set search_path = public, pg_catalog as $$
  select case when jsonb_typeof(j) = 'array' then jsonb_array_length(j) else 0 end
$$;

-- An item stays unless its id was removed or, when it has no id, its outputs overlap the removed outputs.
create or replace function public._backup_item_kept(i jsonb, p_task_ids text[], p_outputs text[]) returns boolean
language sql immutable set search_path = public, pg_catalog as $$
  select case
    when coalesce(i->>'id', '') <> '' then not (i->>'id' = any(p_task_ids))
    else not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(i->'outputs') = 'array' then i->'outputs' else '[]'::jsonb end) u
                      where u.value = any(p_outputs))
  end
$$;

create or replace function public._scrub_tasks_snapshot(snap jsonb, p_task_ids text[]) returns jsonb
language sql immutable set search_path = public, pg_catalog as $$
  select case when coalesce(jsonb_typeof(snap), '') <> 'array' or cardinality(coalesce(p_task_ids, '{}')) = 0 then snap
    else coalesce((select jsonb_agg(x.e order by x.o) from jsonb_array_elements(snap) with ordinality x(e, o)
                    where not coalesce(x.e->>'id' = any(p_task_ids), false)), '[]'::jsonb) end
$$;

create or replace function public._scrub_history_snapshot(snap jsonb, p_task_ids text[], p_log_ids text[], p_outputs text[]) returns jsonb
language sql immutable set search_path = public, pg_catalog as $$
  select case when coalesce(jsonb_typeof(snap), '') <> 'array' then snap else coalesce((
    select jsonb_agg(z.e order by z.o) from (
      select x.o,
             case when jsonb_typeof(x.e->'tasks') = 'array' and k.n_kept < k.n_all
                  then jsonb_set(jsonb_set(x.e, '{tasks}', k.kept), '{total_cost}', to_jsonb(k.cost))
                  else x.e end as e,
             (jsonb_typeof(x.e->'tasks') = 'array' and k.n_all > 0 and k.n_kept = 0) as emptied
        from jsonb_array_elements(snap) with ordinality x(e, o)
        cross join lateral (
          select count(*) as n_all,
                 count(*) filter (where kk.keep) as n_kept,
                 coalesce(jsonb_agg(y.i order by y.io) filter (where kk.keep), '[]'::jsonb) as kept,
                 coalesce(sum(case when kk.keep and y.i->>'status' = 'completed' and jsonb_typeof(y.i->'cost') = 'number'
                                   then (y.i->>'cost')::numeric else 0 end), 0) as cost
            from jsonb_array_elements(case when jsonb_typeof(x.e->'tasks') = 'array' then x.e->'tasks' else '[]'::jsonb end) with ordinality y(i, io)
            cross join lateral (select public._backup_item_kept(y.i, coalesce(p_task_ids, '{}'), coalesce(p_outputs, '{}')) as keep) kk
        ) k
       where not coalesce(x.e->>'id' = any(coalesce(p_log_ids, '{}')), false)
    ) z where not z.emptied), '[]'::jsonb) end
$$;

-- Removes the given generations, History entries and History items from every backup of one account. The removed
-- outputs also include those the backups themselves recorded for these task ids, so a scrub that knows only ids
-- (tombstones) still matches id-less items. Returns how many backups changed.
create or replace function public._scrub_backups(p_username text, p_task_ids text[], p_log_ids text[], p_outputs text[])
returns integer language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_tasks text[] := coalesce(p_task_ids, '{}');
  v_logs  text[] := coalesce(p_log_ids, '{}');
  v_outs  text[];
  v_n     int;
begin
  if cardinality(v_tasks) = 0 and cardinality(v_logs) = 0 and cardinality(coalesce(p_outputs, '{}')) = 0 then return 0; end if;
  select coalesce(array_agg(distinct s.u), '{}') into v_outs from (
    select unnest(coalesce(p_outputs, '{}')) as u
    union
    select o.value
      from data_backups b
      cross join lateral jsonb_array_elements(case when jsonb_typeof(b.tasks_snapshot) = 'array' then b.tasks_snapshot else '[]'::jsonb end) e
      cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e->'outputs') = 'array' then e->'outputs' else '[]'::jsonb end) o
     where b.username = p_username and e->>'id' = any(v_tasks)
  ) s where s.u is not null and s.u <> '';

  with s as (
    select b.id,
           public._scrub_tasks_snapshot(b.tasks_snapshot, v_tasks) as t,
           public._scrub_history_snapshot(b.history_snapshot, v_tasks, v_logs, v_outs) as h
      from data_backups b where b.username = p_username
  )
  update data_backups b set
    tasks_snapshot   = s.t,
    history_snapshot = s.h,
    task_count    = greatest(coalesce(b.task_count, 0)    - (public._jlen(b.tasks_snapshot)   - public._jlen(s.t)), 0),
    history_count = greatest(coalesce(b.history_count, 0) - (public._jlen(b.history_snapshot) - public._jlen(s.h)), 0)
  from s
  where b.id = s.id and (s.t is distinct from b.tasks_snapshot or s.h is distinct from b.history_snapshot);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Drains queued scrubs (all accounts, or one). Each account is taken and scrubbed in its own subtransaction: a failure
-- keeps that account's rows (attempts, last_error) for the next run and never blocks the other accounts.
create or replace function public._drain_backup_scrubs(p_username text default null) returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_user text; v_t text[]; v_l text[]; v_o text[]; v_n int := 0;
begin
  for v_user in select distinct q.username from backup_scrub_queue q where p_username is null or q.username = p_username loop
    begin
      with taken as (
        delete from backup_scrub_queue q where q.username = v_user
        returning q.task_ids, q.log_ids, q.outputs)
      select coalesce((select array_agg(distinct x) from taken, unnest(taken.task_ids) x), '{}'),
             coalesce((select array_agg(distinct x) from taken, unnest(taken.log_ids) x), '{}'),
             coalesce((select array_agg(distinct x) from taken, unnest(taken.outputs) x), '{}')
        into v_t, v_l, v_o;
      v_n := v_n + public._scrub_backups(v_user, v_t, v_l, v_o);
    exception when others then
      update backup_scrub_queue set attempts = attempts + 1, last_error = left(sqlerrm, 500) where username = v_user;
    end;
  end loop;
  return v_n;
end $$;

create or replace function public._tasks_queue_backup_scrub() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or public._auto_backups_on() then return null; end if;
  insert into backup_scrub_queue (username, task_ids, outputs)
  select g.device_id,
         array_agg(distinct g.id),
         coalesce(array_agg(distinct u.value) filter (where u.value is not null and u.value <> ''), '{}')
    from gone g
    left join lateral jsonb_array_elements_text(case when jsonb_typeof(g.outputs) = 'array' then g.outputs else '[]'::jsonb end) u on true
   where g.device_id like 'user:%'
   group by g.device_id;
  return null;
end $$;

create or replace function public._history_queue_backup_scrub() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or public._auto_backups_on() then return null; end if;
  insert into backup_scrub_queue (username, log_ids)
  select g.device_id, array_agg(distinct g.id) from gone g where g.device_id like 'user:%' group by g.device_id;
  return null;
end $$;

-- Items a History rewrite dropped are deleted generations (a purge rewrite, another device's delete, the server's strip
-- of tombstoned items): id'd ones by id, id-less ones (before 2026-10-20) by the outputs they carried.
create or replace function public._history_queue_item_scrub() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on'
     or coalesce(current_setting('proxima.rescope', true), '') = 'on'
     or public._auto_backups_on() then return null; end if;
  insert into backup_scrub_queue (username, task_ids, outputs)
  select x.device_id,
         coalesce(array_agg(distinct x.item_id) filter (where x.item_id is not null), '{}'),
         coalesce(array_agg(distinct x.out) filter (where x.out is not null and x.out <> ''), '{}')
    from (
      select o.device_id, nullif(oe.e->>'id', '') as item_id, u.value as out
        from was o
        join became n on n.id = o.id
        cross join lateral jsonb_array_elements(case when jsonb_typeof(o.tasks) = 'array' then o.tasks else '[]'::jsonb end) oe(e)
        left join lateral jsonb_array_elements_text(case when coalesce(oe.e->>'id', '') = '' and jsonb_typeof(oe.e->'outputs') = 'array' then oe.e->'outputs' else '[]'::jsonb end) u on true
       where o.device_id like 'user:%'
         and not exists (
           select 1 from jsonb_array_elements(case when jsonb_typeof(n.tasks) = 'array' then n.tasks else '[]'::jsonb end) ne(e)
            where case when coalesce(oe.e->>'id', '') <> '' then ne.e->>'id' = oe.e->>'id' else ne.e = oe.e end)
    ) x
   group by x.device_id
  having count(x.item_id) > 0 or count(x.out) > 0;
  return null;
end $$;

-- rename_my_account moves data_backups to the new name: queued scrubs follow, or they would scrub nothing.
create or replace function public._backup_scrub_follow_rename() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.username is distinct from old.username then
    update backup_scrub_queue set username = new.username where username = old.username;
  end if;
  return null;
end $$;

revoke execute on function public._jlen(jsonb) from public, anon, authenticated;
revoke execute on function public._backup_item_kept(jsonb, text[], text[]) from public, anon, authenticated;
revoke execute on function public._scrub_tasks_snapshot(jsonb, text[]) from public, anon, authenticated;
revoke execute on function public._scrub_history_snapshot(jsonb, text[], text[], text[]) from public, anon, authenticated;
revoke execute on function public._scrub_backups(text, text[], text[], text[]) from public, anon, authenticated;
revoke execute on function public._drain_backup_scrubs(text) from public, anon, authenticated;
revoke execute on function public._tasks_queue_backup_scrub() from public, anon, authenticated;
revoke execute on function public._history_queue_backup_scrub() from public, anon, authenticated;
revoke execute on function public._history_queue_item_scrub() from public, anon, authenticated;
revoke execute on function public._backup_scrub_follow_rename() from public, anon, authenticated;

drop trigger if exists tasks_queue_backup_scrub on public.tasks;
create trigger tasks_queue_backup_scrub after delete on public.tasks
  referencing old table as gone for each statement execute function public._tasks_queue_backup_scrub();
drop trigger if exists history_queue_backup_scrub on public.history;
create trigger history_queue_backup_scrub after delete on public.history
  referencing old table as gone for each statement execute function public._history_queue_backup_scrub();
drop trigger if exists history_queue_item_scrub on public.history;
create trigger history_queue_item_scrub after update on public.history
  referencing old table as was new table as became for each statement execute function public._history_queue_item_scrub();
drop trigger if exists data_backups_scrub_follow_rename on public.data_backups;
create trigger data_backups_scrub_follow_rename after update of username on public.data_backups
  for each row execute function public._backup_scrub_follow_rename();

select cron.schedule('backup-scrub-drain', '* * * * *', 'select public._drain_backup_scrubs()');

-- Kept callable for app builds still cached on a device; now the same scrub (with the id-less item fix).
create or replace function public.purge_my_backups_of(p_session_token text, p_task_ids text[], p_log_ids text[])
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject  text := public._verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
begin
  return json_build_object('ok', true, 'backups', public._scrub_backups(v_username, p_task_ids, p_log_ids, '{}'));
end $$;
revoke execute on function public.purge_my_backups_of(text, text[], text[]) from public;
grant execute on function public.purge_my_backups_of(text, text[], text[]) to anon, authenticated;

-- Restore: same body as 20261021171500, plus this account's queued scrubs are applied first, and the restore is refused
-- while any is left (a failing scrub), so a backup is never restored with a deleted generation still in it.
CREATE OR REPLACE FUNCTION public.restore_my_backup_phase2(p_session_token text, p_backup_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_subject  text := _verify_session_token(p_session_token);
  v_username text := case when v_subject like 'admin:%' then 'user:' || substring(v_subject from 7) else v_subject end;
  v_backup   record;
  v_tasks int := 0; v_history int := 0; v_favorites int := 0;
begin
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
        coalesce((select jsonb_object_agg(key, value) from settings where device_id = v_username), '{}'::jsonb),
        coalesce((select jsonb_agg(row_to_json(f)) from (select * from favorites where device_id = v_username) f), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(t)) from (select * from tasks where device_id = v_username order by start_time desc limit 500) t), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(h)) from (select * from history where device_id = v_username order by timestamp desc limit 1000) h), '[]'::jsonb),
        'auto safety snapshot before restoring backup ' || p_backup_id::text;
    end if;
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where device_id = v_username;
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username;
    insert into tasks select * from jsonb_populate_recordset(null::tasks, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e));
    get diagnostics v_tasks = row_count;
    insert into history select * from jsonb_populate_recordset(null::history, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e));
    get diagnostics v_history = row_count;
    perform set_config('proxima.restore', 'off', true);
    insert into favorites select * from jsonb_populate_recordset(null::favorites, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e));
    get diagnostics v_favorites = row_count;
    insert into settings (device_id, key, value)
      select v_username, k.key, k.value from jsonb_each(coalesce(v_backup.settings_snapshot, '{}'::jsonb)) k where k.key <> 'apiKey'
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  exception when others then
    perform set_config('proxima.restore', 'off', true);
    return json_build_object('ok', false, 'reason', sqlerrm);
  end;
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites);
end $function$;
