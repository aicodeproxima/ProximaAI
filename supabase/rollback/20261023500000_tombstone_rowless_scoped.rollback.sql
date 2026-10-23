-- Rollback of supabase/migrations/20261023500000_tombstone_rowless_scoped.sql. Kept OUT of supabase/migrations/. One transaction, no
-- transaction control:
--   0) compare-and-swap: each of the six functions must have the migration's post-apply md5, owner postgres and its
--      grants (and sync_tombstones' key still (id)); otherwise nothing changes.
--   1) the six functions recreated from their pre-migration pg_get_functiondef text, verbatim (captured 2026-10-23 from
--      the live database by a script, not retyped). md5 after -> restored:
--        public.delete_queued_rows(text,text,text[],bigint)             03e6c0037cae1b799acd8958594b0297 -> 0a0684db11559e26e42109a2c22d5ad2
--        public._clear_kind(text,text,timestamp with time zone,text[])  6f4ebd0c7bbdfe6f994d5705054e1df4 -> 32d2620d2b859e0b860f2d32f7264020
--        public._rows_not_tombstoned()                                  47a9f89fa644b291e5f2fffdb8da24eb -> 28459f90f099134f5eba9487152cb54a
--        public.sync_tombstone_record()                                 512467f0f3caa41566dccaa1d01a4fb1 -> cb47c9f00d728476b61ae2f7f766a3fb
--        public.sync_tombstone_clear()                                  7909d202728ef4b4baf03b2e941faf62 -> 8eaf29a81363d1451d0b2f9a5417f2f4
--        public._history_strip_deleted_items()                          b8a79e1bbae42745db22415003deec6e -> 3e0587629f113442d7d95852e8dc166f
--      _rows_not_tombstoned's pre-migration text is SECURITY DEFINER again (the migration made it SECURITY INVOKER,
--      RLS review item 6), so its post md5 above is that of the invoker version.
--   2) post-check: each md5 equals the pre-migration capture, owner and grants unchanged.
--   3) the migration's own record is deleted (supabase_migrations.schema_migrations, version 20261023500000, name tombstone_rowless_scoped),
--      so a later apply-migration.mjs re-applies it instead of printing "already recorded". Zero rows is fine.
-- Tombstones recorded while the migration was live are KEPT. Each records a delete the user confirmed (a named id with
-- no row, in the caller's scope) and only keeps that id deleted, which is what the restored global rule also does. While
-- one account exists (no member before P4/P5) every tombstone is in its scope, so the restored global rule reads them
-- exactly as the scoped one did. Deleting them would bring back the F1/F4 resurrections for ids already confirmed deleted.
-- (With member accounts, the restored global rule would let a tombstone of A's drop B's upload of the same id: roll this
-- back only before members exist, or accept that.)
-- ORDER: this rollback runs BEFORE M4's (20261023400000_mu_p1_end_dual_accept) and M1's rollbacks: delete_queued_rows is
-- in M1's compare-and-swap set (M1 post md5 0a0684db11559e26e42109a2c22d5ad2, restored by step 1), so M1's rollback
-- refuses while this migration is live. Full order: this -> M4 -> M3 -> M2 -> M1b -> M1.

-- ── 0. Guards ──
do $pk$
begin
  if to_regclass('public.sync_tombstones') is null
     or (select pg_get_constraintdef(c.oid) from pg_constraint c
          where c.conrelid = 'public.sync_tombstones'::regclass and c.contype = 'p') is distinct from 'PRIMARY KEY (id)' then
    raise exception '20261023500000 rollback: sync_tombstones'' primary key is no longer (id); P4 changed it, rebuild this file for (device_id, id)';
  end if;
end $pk$;

do $guard$
declare
  v_want constant jsonb := '{
    "public.delete_queued_rows(text,text,text[],bigint)": "03e6c0037cae1b799acd8958594b0297",
    "public._clear_kind(text,text,timestamp with time zone,text[])": "6f4ebd0c7bbdfe6f994d5705054e1df4",
    "public._rows_not_tombstoned()": "47a9f89fa644b291e5f2fffdb8da24eb",
    "public.sync_tombstone_record()": "512467f0f3caa41566dccaa1d01a4fb1",
    "public.sync_tombstone_clear()": "7909d202728ef4b4baf03b2e941faf62",
    "public._history_strip_deleted_items()": "b8a79e1bbae42745db22415003deec6e"
  }';
  v_acl constant jsonb := '{
    "public.delete_queued_rows(text,text,text[],bigint)": "{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
    "public._clear_kind(text,text,timestamp with time zone,text[])": "{postgres=X/postgres,service_role=X/postgres}",
    "public._rows_not_tombstoned()": "{postgres=X/postgres,service_role=X/postgres}",
    "public.sync_tombstone_record()": "{postgres=X/postgres,service_role=X/postgres}",
    "public.sync_tombstone_clear()": "{postgres=X/postgres,service_role=X/postgres}",
    "public._history_strip_deleted_items()": "{postgres=X/postgres,service_role=X/postgres}"
  }';
  k text; v_have text; v_bad text := '';
begin
  for k in select jsonb_object_keys(v_want) order by 1 loop
    if to_regprocedure(k) is null then
      v_bad := v_bad || k || ' missing; ';
      continue;
    end if;
    v_have := md5(pg_get_functiondef(to_regprocedure(k)));
    if v_have <> v_want->>k then v_bad := v_bad || format('%s md5 %s (expected %s); ', k, v_have, v_want->>k); end if;
    if (select pg_get_userbyid(p.proowner) <> 'postgres' or coalesce(p.proacl::text, '') <> v_acl->>k
          from pg_proc p where p.oid = to_regprocedure(k)) then
      v_bad := v_bad || k || ' owner/grants changed; ';
    end if;
  end loop;
  if v_bad <> '' then
    raise exception '20261023500000 rollback refused, a function is not as this migration left it: %', v_bad;
  end if;
end $guard$;

-- ── 1. Functions, pre-migration text ──

-- public.delete_queued_rows(text,text,text[],bigint)
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
  if p_kind = 'task' then
    delete from tasks where device_id = v_user and id = any(p_ids);
  else
    delete from history where device_id = v_user and id = any(p_ids);
  end if;
  get diagnostics v_n = row_count;
  if p_kind = 'task' then
    -- A user delete of a generation without a tasks row (History-only, e.g. after a restore) records a user tombstone
    -- too, so other devices drop its History item and uploads are stripped of it; a restore's tombstone of it becomes a
    -- user one (review round 6). Only ids a live History item of this account holds, or a tombstone already names.
    update sync_tombstones set by_restore = false, deleted_at = now()
     where device_id = v_user and kind = 'task' and id = any(p_ids) and coalesce(by_restore, false);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select x, 'task', v_user, now(), false from unnest(p_ids) x
     where not exists (select 1 from sync_tombstones st where st.id = x)
       and not exists (select 1 from tasks t where t.id = x)
       and x in (select e.item->>'id' from history h,
                   jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                  where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')
    on conflict (id) do nothing;
    -- The History half of the delete, in this same transaction (review round 8): touching the entries that hold these
    -- ids lets history_strip_deleted_items remove their items (they now carry user tombstones) and recompute the cost,
    -- history_drop_emptied delete an entry left empty, and the scrub triggers queue what left. A restore can no longer
    -- land between the row delete and the History change, and no client upload of a trimmed copy is needed.
    update history h set tasks = h.tasks
     where h.device_id = v_user and jsonb_typeof(h.tasks) = 'array'
       and exists (select 1 from jsonb_array_elements(h.tasks) e where e->>'id' = any(p_ids));
  end if;
  return json_build_object('ok', true, 'voided', false, 'deleted', v_n);
end $function$;

-- public._clear_kind(text,text,timestamp with time zone,text[])
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
end $function$;

-- public._rows_not_tombstoned()
CREATE OR REPLACE FUNCTION public._rows_not_tombstoned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if coalesce(current_setting('proxima.restore', true), '') <> 'on'
     and exists (select 1 from sync_tombstones where id = new.id and kind = tg_argv[0]) then
    return null;
  end if;
  return new;
end $function$;

-- public.sync_tombstone_record()
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
                                 by_restore = excluded.by_restore;
  return old;
end $function$;

-- public.sync_tombstone_clear()
CREATE OR REPLACE FUNCTION public.sync_tombstone_clear()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  delete from public.sync_tombstones where id = new.id;
  return new;
end $function$;

-- public._history_strip_deleted_items()
CREATE OR REPLACE FUNCTION public._history_strip_deleted_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_tasks jsonb;
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or coalesce(jsonb_typeof(new.tasks), '') <> 'array' then
    return new;
  end if;
  if not exists (select 1 from jsonb_array_elements(new.tasks) e
                   join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and not st.by_restore) then
    return new;
  end if;
  select coalesce(jsonb_agg(x.e order by x.o), '[]'::jsonb) into v_tasks
    from jsonb_array_elements(new.tasks) with ordinality x(e, o)
   where not exists (select 1 from sync_tombstones st where st.id = x.e->>'id' and st.kind = 'task' and not st.by_restore);
  if tg_op = 'INSERT' and jsonb_array_length(v_tasks) = 0 and not exists (select 1 from history h where h.id = new.id) then
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (new.id, 'history', new.device_id, now(), false)
      on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = false;
    return null;
  end if;
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $function$;

-- ── 2. Post-check ──
do $post$
declare
  v_want constant jsonb := '{
    "public.delete_queued_rows(text,text,text[],bigint)": "0a0684db11559e26e42109a2c22d5ad2",
    "public._clear_kind(text,text,timestamp with time zone,text[])": "32d2620d2b859e0b860f2d32f7264020",
    "public._rows_not_tombstoned()": "28459f90f099134f5eba9487152cb54a",
    "public.sync_tombstone_record()": "cb47c9f00d728476b61ae2f7f766a3fb",
    "public.sync_tombstone_clear()": "8eaf29a81363d1451d0b2f9a5417f2f4",
    "public._history_strip_deleted_items()": "3e0587629f113442d7d95852e8dc166f"
  }';
  v_acl constant jsonb := '{
    "public.delete_queued_rows(text,text,text[],bigint)": "{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
    "public._clear_kind(text,text,timestamp with time zone,text[])": "{postgres=X/postgres,service_role=X/postgres}",
    "public._rows_not_tombstoned()": "{postgres=X/postgres,service_role=X/postgres}",
    "public.sync_tombstone_record()": "{postgres=X/postgres,service_role=X/postgres}",
    "public.sync_tombstone_clear()": "{postgres=X/postgres,service_role=X/postgres}",
    "public._history_strip_deleted_items()": "{postgres=X/postgres,service_role=X/postgres}"
  }';
  k text; v_have text; v_bad text := '';
begin
  for k in select jsonb_object_keys(v_want) order by 1 loop
    if to_regprocedure(k) is null then
      v_bad := v_bad || k || ' missing; ';
      continue;
    end if;
    v_have := md5(pg_get_functiondef(to_regprocedure(k)));
    if v_have <> v_want->>k then v_bad := v_bad || format('%s md5 %s (expected %s); ', k, v_have, v_want->>k); end if;
    if (select pg_get_userbyid(p.proowner) <> 'postgres' or coalesce(p.proacl::text, '') <> v_acl->>k
          from pg_proc p where p.oid = to_regprocedure(k)) then
      v_bad := v_bad || k || ' owner/grants changed; ';
    end if;
  end loop;
  if v_bad <> '' then
    raise exception '20261023500000 rollback post-check: %', v_bad;
  end if;
end $post$;

-- ── 3. The migration's record ──
delete from supabase_migrations.schema_migrations where version = '20261023500000' and name = 'tombstone_rowless_scoped';
