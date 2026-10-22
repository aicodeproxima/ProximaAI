-- Review round 10 (2026-10-22), on the clears of 20261022300000:
-- 1. Clear Outputs / Reset bounded their clear by a queue time taken AFTER their purge read: a row another device
--    uploaded during the read was deleted by the bound but never seen, so its WaveSpeed copy and files were never purged.
--    The client now passes a time taken BEFORE the read (less the clock-estimate margin), so every row the bound covers
--    was read; named ids go whenever written. History-only generations are no longer named by the client (a row that
--    appeared for one after the read was deleted unpurged): the server tombstones the ids that entries existing by that
--    time hold without a row (a restore's tombstone becomes a user one), and the History touch strips them.
-- 2. The touch compared every item with every cleared id (items x ids): a large account neared anon's 3 s statement
--    timeout (1.9 s for 3000 rows). Ids are now sets the planner can size (one array per unnest, custom plans forced:
--    a generic plan guesses 10 elements and nested-loops), and the entries all of whose items go are deleted in ONE
--    statement instead of each by its own drop-emptied trigger statement (6000 rows: about 0.5 s).
-- 3. Reset's settings clear had no time bound: settings another device wrote after the reset began were wiped.
--    settings.updated_at is now stamped by the server, and the settings clear takes only rows written by that time.
-- 4. Reset made four restore-checked calls: a restore landing between them voided the later ones after the earlier ones
--    had deleted. reset_queued_rows clears all four kinds in one transaction under one restore check.
-- Shared body: _clear_kind (security invoker, not executable by browser roles; the definer RPCs call it as postgres).
-- Tests: test-queued-deletes-db.sql cases clear-snapshot, clear-perf, settings-stamped, reset-queued.
create or replace function public._clear_kind(p_user text, p_kind text, p_upto timestamptz, p_ids text[])
returns int language plpgsql set search_path = public, pg_catalog set plan_cache_mode = force_custom_plan as $$
declare
  v_ids     text[] := coalesce(p_ids, '{}');
  v_gone    text[] := '{}';
  v_orphans text[] := '{}';
  v_set     text[];
  v_drop    text[];
  v_touch   text[];
  v_n       int := 0;
begin
  if p_kind = 'task' then
    with d as (delete from tasks t
                where t.device_id = p_user
                  and (coalesce(t.created_at, '-infinity') <= p_upto or t.id in (select unnest(v_ids)))
                returning t.id)
    select coalesce(array_agg(id), '{}') into v_gone from d;
    v_n := cardinality(v_gone);
    -- Generations without a tasks row that this account's History holds, in entries that existed by p_upto (or named):
    -- user tombstones, so their items go here and every later upload is stripped of them.
    select coalesce(array_agg(distinct x.id), '{}') into v_orphans
      from (select e.item->>'id' as id
              from history h,
                   jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
             where h.device_id = p_user and coalesce(e.item->>'id', '') <> ''
               and (coalesce(h.created_at, '-infinity') <= p_upto or e.item->>'id' in (select unnest(v_ids)))) x
     where not exists (select 1 from tasks t where t.id = x.id);
    update sync_tombstones set by_restore = false, deleted_at = now()
     where device_id = p_user and kind = 'task' and coalesce(by_restore, false) and id in (select unnest(v_orphans));
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select o, 'task', p_user, now(), false from unnest(v_orphans) o
     where not exists (select 1 from sync_tombstones st where st.id = o)
    on conflict (id) do nothing;
    -- The History half in this transaction, over the entries holding a cleared or tombstoned id: those with no other item
    -- are deleted in one statement (the delete triggers record their tombstones and queue their scrubs, as the
    -- drop-emptied path would); the rest are touched, so the strip trigger removes the gone items and recomputes the cost.
    v_set := array(select distinct x from unnest(v_gone || v_orphans) x);
    select coalesce(array_agg(s.id) filter (where s.all_gone), '{}'), coalesce(array_agg(s.id) filter (where not s.all_gone), '{}')
      into v_drop, v_touch
      from (select h.id, bool_and(g.id is not null) as all_gone
              from history h
              cross join lateral jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
              left join unnest(v_set) g(id) on g.id = e.item->>'id'
             where h.device_id = p_user
             group by h.id
            having bool_or(g.id is not null)) s;
    delete from history h where h.device_id = p_user and h.id = any(v_drop);
    update history h set tasks = h.tasks where h.device_id = p_user and h.id = any(v_touch);
  elsif p_kind = 'history' then
    delete from history h
     where h.device_id = p_user and (coalesce(h.created_at, '-infinity') <= p_upto or h.id in (select unnest(v_ids)));
    get diagnostics v_n = row_count;
  elsif p_kind = 'settings' then
    -- The restore marker and the form holds are the server's and the other device's: never cleared.
    delete from settings s
     where s.device_id = p_user and s.key <> 'last_restore_at' and s.key not like 'form-inputs:%'
       and coalesce(s.updated_at, '-infinity') <= p_upto;
    get diagnostics v_n = row_count;
  elsif p_kind = 'favorites' then
    delete from favorites f
     where f.device_id = p_user and (coalesce(f.created_at, '-infinity') <= p_upto or f.id in (select unnest(v_ids)));
    get diagnostics v_n = row_count;
  else
    raise exception '_clear_kind: unknown kind %', p_kind;
  end if;
  return v_n;
end $$;
revoke execute on function public._clear_kind(text, text, timestamptz, text[]) from public, anon, authenticated;

create or replace function public.clear_queued_rows(p_session_token text, p_kind text, p_queued_at bigint, p_ids text[] default null)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if p_kind not in ('task', 'history', 'settings', 'favorites') then
    raise exception 'clear_queued_rows: unknown kind %', p_kind;
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'deleted', 0);
  end if;
  return json_build_object('ok', true, 'voided', false,
    'deleted', public._clear_kind(v_user, p_kind, to_timestamp(coalesce(p_queued_at, 0) / 1000.0), p_ids));
end $$;
revoke execute on function public.clear_queued_rows(text, text, bigint, text[]) from public;
grant execute on function public.clear_queued_rows(text, text, bigint, text[]) to anon, authenticated, service_role;

-- Reset Everything: History, generations, settings and favorites of this account in one transaction, one restore check.
create or replace function public.reset_queued_rows(p_session_token text, p_queued_at bigint, p_task_ids text[] default null,
                                                    p_history_ids text[] default null)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
  v_upto    timestamptz := to_timestamp(coalesce(p_queued_at, 0) / 1000.0);
  v_h int; v_t int; v_s int; v_f int;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true);
  end if;
  v_h := public._clear_kind(v_user, 'history', v_upto, p_history_ids);
  v_t := public._clear_kind(v_user, 'task', v_upto, p_task_ids);
  v_s := public._clear_kind(v_user, 'settings', v_upto, null);
  v_f := public._clear_kind(v_user, 'favorites', v_upto, null);
  return json_build_object('ok', true, 'voided', false,
    'deleted', json_build_object('history', v_h, 'task', v_t, 'settings', v_s, 'favorites', v_f));
end $$;
revoke execute on function public.reset_queued_rows(text, bigint, text[], text[]) from public;
grant execute on function public.reset_queued_rows(text, bigint, text[], text[]) to anon, authenticated, service_role;

-- settings.updated_at is the server's: the client sent its own clock, which the settings clear cannot compare with.
create or replace function public._settings_stamp_updated_at()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public._settings_stamp_updated_at() from public;
update settings set updated_at = now() where updated_at > now();   -- a client clock ahead of the server's
drop trigger if exists settings_stamp_updated_at on public.settings;
create trigger settings_stamp_updated_at before insert or update on public.settings
  for each row execute function public._settings_stamp_updated_at();
notify pgrst, 'reload schema';
