-- Rollback of supabase/migrations/20261025300000_mu_p4_tombstone_key.sql (exact inverse: the four bodies below are the
-- live pg_get_functiondef text of 2026-10-25). Kept OUT of supabase/migrations/. It refuses once two accounts hold a
-- tombstone of the same id: the old key (id) cannot hold both.
-- md5 guard (review round 2, c3 #2): the bodies this file restores must still be the ones 20261025300000 installed;
-- otherwise someone changed them since, and restoring the old text would undo that change.
do $rbguard$
begin
  if md5(pg_get_functiondef('public._clear_kind(text,text,timestamp with time zone,text[])'::regprocedure)) <> '9567a3d27e733c75301187c940137d7d'
     or md5(pg_get_functiondef('public.delete_queued_rows(text,text,text[],bigint)'::regprocedure)) <> 'e1476aa2435728a6f77e60195bea9c75'
     or md5(pg_get_functiondef('public._history_strip_deleted_items()'::regprocedure)) <> '0a136484d6d3e9f4bed82d04221fe401'
     or md5(pg_get_functiondef('public.sync_tombstone_record()'::regprocedure)) <> '470ecff896b9ef7b50845dfcdadf9a87' then
    raise exception 'refusing the 20261025300000 rollback: a function it restores changed since the migration (write a new rollback from the live body)';
  end if;
end $rbguard$;

do $rb$
begin
  if exists (select 1 from public.sync_tombstones group by id having count(*) > 1) then
    raise exception 'refusing the tombstone-key rollback: an id is tombstoned in more than one account';
  end if;
end $rb$;

alter table public.sync_tombstones drop constraint sync_tombstones_pkey;
alter table public.sync_tombstones add constraint sync_tombstones_pkey primary key (id);

CREATE OR REPLACE FUNCTION public._clear_kind(p_user text, p_kind text, p_upto timestamp with time zone, p_ids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_ids     text[] := coalesce(p_ids, '{}');
  v_gone    text[] := '{}';
  v_orphans text[] := '{}';
  v_set     text[];
  v_drop    text[];
  v_touch   text[];
  v_n       int := 0;
begin
  -- 20261023500000 (tombcrit #1): the scope's row lock before any row is read (as delete_queued_rows); the task kind
  -- takes the History key too, in this order (task, history), because it changes History entries and reset_queued_rows
  -- calls the History kind next in the same transaction.
  if p_kind in ('task', 'history') then
    perform pg_advisory_xact_lock(hashtextextended('proxima-rows:' || p_kind || ':' || p_user, 0));
  end if;
  if p_kind = 'task' then
    perform pg_advisory_xact_lock(hashtextextended('proxima-rows:history:' || p_user, 0));
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
    -- 20261023500000: and every NAMED id without a tasks row (in any account), History-held or not, as delete_queued_rows
    -- does: a row that lands later is dropped (sim F1). A restore's tombstone of a named or orphan id becomes a user one
    -- (sim F2). "do nothing" while the key is (id): another account's tombstone is never moved into this scope.
    update sync_tombstones set by_restore = false, deleted_at = now()
     where device_id = p_user and kind = 'task' and coalesce(by_restore, false) and id in (select unnest(v_orphans || v_ids));
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select distinct o, 'task', p_user, now(), false from unnest(v_orphans || v_ids) o
     where coalesce(o, '') <> ''
       and not exists (select 1 from sync_tombstones st where st.id = o)
       and not exists (select 1 from tasks t where t.id = o)
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
    -- 20261023500000: a named History id without a row (in any account) gets a user tombstone in this scope (sim F4).
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select distinct x, 'history', p_user, now(), false from unnest(v_ids) x
     where coalesce(x, '') <> ''
       and not exists (select 1 from sync_tombstones st where st.id = x)
       and not exists (select 1 from history h where h.id = x)
    on conflict (id) do nothing;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_queued_rows(p_session_token text, p_kind text, p_ids text[], p_queued_at bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc     proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_user    text := v_acc.scope;
  v_restore bigint;
  v_n       int := 0;
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind not in ('task', 'history') then
    raise exception 'delete_queued_rows: unknown kind %', p_kind;
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return json_build_object('ok', true, 'voided', false, 'deleted', 0);
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'delete_queued_rows: at most 200 ids, got %', cardinality(p_ids);
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have moved the account
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_user then raise exception 'session token revoked'; end if;
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'deleted', 0);
  end if;
  -- 20261023500000 (tombcrit #1): this scope's row lock, before any row is read, so the "no row" checks below and an
  -- insert of a named id in this scope are serialised (_rows_not_tombstoned takes it shared). Task kind also takes the
  -- History key: this branch changes History entries, and an upload of one waits so its strip sees the new tombstones.
  perform pg_advisory_xact_lock(hashtextextended('proxima-rows:' || p_kind || ':' || v_user, 0));
  if p_kind = 'task' then
    perform pg_advisory_xact_lock(hashtextextended('proxima-rows:history:' || v_user, 0));
  end if;
  if p_kind = 'task' then
    delete from tasks where device_id = v_user and id = any(p_ids);
  else
    delete from history where device_id = v_user and id = any(p_ids);
  end if;
  get diagnostics v_n = row_count;
  if p_kind = 'task' then
    -- A user delete of a generation without a tasks row (History-only, e.g. after a restore) records a user tombstone
    -- too, so other devices drop its History item and uploads are stripped of it; a restore's tombstone of it becomes a
    -- user one (review round 6).
    -- 20261023500000: EVERY named id without a tasks row (in any account) gets one, in this account's scope, not only
    -- ids a live History item holds: a row that lands later (another device's queued upload, this page's own upload
    -- still in flight) is then dropped by _rows_not_tombstoned instead of bringing the confirmed delete back (sim F1/F4).
    -- "do nothing" while the key is (id): another account's tombstone of the same id is never moved into this scope.
    update sync_tombstones set by_restore = false, deleted_at = now()
     where device_id = v_user and kind = 'task' and id = any(p_ids) and coalesce(by_restore, false);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select distinct x, 'task', v_user, now(), false from unnest(p_ids) x
     where coalesce(x, '') <> ''
       and not exists (select 1 from sync_tombstones st where st.id = x)
       and not exists (select 1 from tasks t where t.id = x)
    on conflict (id) do nothing;
    -- The History half of the delete, in this same transaction (review round 8): touching the entries that hold these
    -- ids lets history_strip_deleted_items remove their items (they now carry user tombstones) and recompute the cost,
    -- history_drop_emptied delete an entry left empty, and the scrub triggers queue what left. A restore can no longer
    -- land between the row delete and the History change, and no client upload of a trimmed copy is needed.
    update history h set tasks = h.tasks
     where h.device_id = v_user and jsonb_typeof(h.tasks) = 'array'
       and exists (select 1 from jsonb_array_elements(h.tasks) e where e->>'id' = any(p_ids));
  else
    -- 20261023500000: a named History id without a row (in any account) gets a user tombstone in this account's scope,
    -- so an upload of it that lands later (this page's own, still in flight) is dropped (sim F4).
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select distinct x, 'history', v_user, now(), false from unnest(p_ids) x
     where coalesce(x, '') <> ''
       and not exists (select 1 from sync_tombstones st where st.id = x)
       and not exists (select 1 from history h where h.id = x)
    on conflict (id) do nothing;
  end if;
  return json_build_object('ok', true, 'voided', false, 'deleted', v_n);
end $function$
;

CREATE OR REPLACE FUNCTION public._history_strip_deleted_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_tasks jsonb;
  v_have  text[];
  v_user  boolean;
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or coalesce(jsonb_typeof(new.tasks), '') <> 'array' then
    return new;
  end if;
  -- 20261024100000: the item ids the stored copy of this entry holds (an upsert's BEFORE INSERT sees the row it updates).
  -- Id-less items are left out (a NULL in the set made `id = any(...)` NULL: the strip was skipped; migration review).
  select coalesce(array_agg(e->>'id'), '{}') into v_have
    from history h,
         jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e
   where h.id = new.id and h.device_id = new.device_id and coalesce(e->>'id', '') <> '';
  -- Stripped: an item of a user's delete, or (20261024100000) of a restore's removal the stored entry does not hold.
  if not exists (select 1 from jsonb_array_elements(new.tasks) e
                   join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and st.device_id = new.device_id
                  where not st.by_restore or not ((e->>'id') = any (v_have))) then
    return new;
  end if;
  v_user := exists (select 1 from jsonb_array_elements(new.tasks) e
                      join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and not st.by_restore
                                             and st.device_id = new.device_id);
  select coalesce(jsonb_agg(x.e order by x.o), '[]'::jsonb) into v_tasks
    from jsonb_array_elements(new.tasks) with ordinality x(e, o)
   where not exists (select 1 from sync_tombstones st
                      where st.id = x.e->>'id' and st.kind = 'task' and st.device_id = new.device_id
                        and (not st.by_restore or not ((x.e->>'id') = any (v_have))));
  if tg_op = 'INSERT' and jsonb_array_length(v_tasks) = 0
     and not exists (select 1 from history h where h.id = new.id and h.device_id = new.device_id) then
    -- 20261024100000 (RLS session's review): this branch returns NULL, so the row policies' WITH CHECK never runs for it.
    -- A browser role (the role GUC: inside SECURITY DEFINER current_user is the owner) naming a scope other than its
    -- session's gets nothing written: it is refused with the policies' own errors (28000 / 42501). Before,
    -- any caller could write History tombstones into another scope and learn which of its ids are tombstoned there.
    -- It raises what the row policies would (28000 without a valid header, else 42501, same message), so a direct insert
    -- gets the same answer as any other refused row, and a SECURITY DEFINER caller (upsert_queued_history, where no
    -- policy runs) fails instead of storing an empty entry (migration review #2/#3).
    if coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated')
       and new.device_id is distinct from proxima_auth.session_scope(false) then
      perform proxima_auth.session_scope(true);
      raise exception using errcode = '42501', message = 'new row violates row-level security policy for table "history"';
    end if;
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (new.id, 'history', new.device_id, now(), not v_user)
      on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = excluded.by_restore and sync_tombstones.by_restore
        where sync_tombstones.device_id = excluded.device_id;
    return null;
  end if;
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.sync_tombstone_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.sync_tombstones (id, kind, device_id, deleted_at, by_restore)
  values (old.id, tg_argv[0], old.device_id, now(), coalesce(current_setting('proxima.restore', true), '') = 'on')
  on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                 by_restore = excluded.by_restore
   where sync_tombstones.device_id = excluded.device_id;
  return old;
end $function$
;

-- The migration's own record goes with it, in the same transaction, so a later apply re-applies it.
delete from supabase_migrations.schema_migrations where version = '20261025300000' and name = 'mu_p4_tombstone_key';
