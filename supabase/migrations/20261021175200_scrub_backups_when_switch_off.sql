-- Owner rulings on review #7 (2026-10-22): when Automatic backups is switched OFF, every existing backup loses what was
-- deleted so far; while OFF every delete scrubs backups (20261021175100); switching back ON restores nothing.
--   "yes, scrub them": every tombstoned task and History id of the account that is not live again.
--   "Scrub them too": rows a restore replaced count as well, so a restore can no longer be undone after switching OFF.
--   "Yes, remove them": a backed-up History entry that still exists keeps only the items its live version still has
--     (items whose task never reached the cloud, and items saved without an id, leave no tombstone).
-- sync_tombstones.by_restore still marks tombstones a restore left: the History strip guard (20261021175300) must not
-- strip the items a restore re-inserts, and a later real delete overwrites the mark.
alter table public.sync_tombstones add column if not exists by_restore boolean not null default false;

create or replace function public.sync_tombstone_record() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.sync_tombstones (id, kind, device_id, deleted_at, by_restore)
  values (old.id, tg_argv[0], old.device_id, now(), coalesce(current_setting('proxima.restore', true), '') = 'on')
  on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                 by_restore = excluded.by_restore;
  return old;
end $$;

alter table public.backup_scrub_queue add column if not exists all_tombstones boolean not null default false;

-- A backed-up History entry whose entry is still live keeps only the items the live entry still has: items with an id
-- by id, items without one (saved before 2026-10-20) by an equal element or an output they share. An entry left with no
-- items goes, total_cost is recomputed (batchLog totalOf). Returns how many backups changed.
create or replace function public._scrub_backups_to_live_items(p_username text) returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
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
end $$;
revoke execute on function public._scrub_backups_to_live_items(text) from public, anon, authenticated;

-- As 20261021175100, plus all_tombstones (queued by switching OFF): every task and History id the account deleted,
-- restore-replaced ones included, that is not live again; then History items absent from their live entry.
create or replace function public._drain_backup_scrubs(p_username text default null) returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_user text; v_t text[]; v_l text[]; v_o text[]; v_all boolean; v_n int := 0;
begin
  for v_user in select distinct q.username from backup_scrub_queue q where p_username is null or q.username = p_username loop
    begin
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
                               and not exists (select 1 from tasks t where t.id = st.id));
        v_l := v_l || array(select st.id from sync_tombstones st
                             where st.device_id = v_user and st.kind = 'history'
                               and not exists (select 1 from history h where h.id = st.id));
      end if;
      v_n := v_n + public._scrub_backups(v_user, v_t, v_l, v_o);
      if v_all then
        v_n := v_n + public._scrub_backups_to_live_items(v_user);
      end if;
    exception when others then
      update backup_scrub_queue set attempts = attempts + 1, last_error = left(sqlerrm, 500) where username = v_user;
    end;
  end loop;
  return v_n;
end $$;
revoke execute on function public._drain_backup_scrubs(text) from public, anon, authenticated;

create or replace function public.set_auto_backups(p_session_token text, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform public._verify_session_token(p_session_token);
  insert into app_secrets (key, value, updated_at) values ('auto_backups', jsonb_build_object('enabled', coalesce(p_enabled, false)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if not coalesce(p_enabled, false) then
    -- The switch is global (app_secrets): every account's backups lose what that account deleted so far.
    insert into backup_scrub_queue (username, all_tombstones)
    select distinct b.username, true from data_backups b;
  end if;
  return public._auto_backups_on();
end $$;
revoke execute on function public.set_auto_backups(text, boolean) from public;
grant execute on function public.set_auto_backups(text, boolean) to anon, authenticated;

-- Once: the switch is off now (the owner's choice), so existing backups lose what was already deleted.
insert into public.backup_scrub_queue (username, all_tombstones)
select distinct b.username, true from public.data_backups b where not public._auto_backups_on();
