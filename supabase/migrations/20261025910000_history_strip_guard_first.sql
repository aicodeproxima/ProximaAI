-- Browser writes into another account's History scope are refused before any History trigger reads that scope
-- (review round 30 #7).
--
-- _history_strip_deleted_items (BEFORE INSERT/UPDATE on history, SECURITY DEFINER) read the named scope's tombstones and
-- stored entry, stripped items and recomputed the total before the row policies refused a browser writing into a scope
-- that is not its session's. A crafted entry whose item costs overflow the total then answered 22003 when one of its ids
-- was tombstoned in that scope and 28000/42501 otherwise: anyone with the public anon key could learn which ids are
-- deleted (or removed by a restore) in any account.
--
-- New: history_0_scope_guard, a BEFORE INSERT OR UPDATE trigger that fires before every other History trigger (name order).
-- Its function is SECURITY INVOKER, so current_user is the role that ran the statement: a direct browser write runs as
-- anon/authenticated and is checked against its session's scope (refused with the row policies' own errors, 28000
-- without a valid header, else 42501); a SECURITY DEFINER RPC's statement runs as the function's owner and is trusted with
-- the scope its own token proved (rename_my_account's moves, upsert_queued_history, the delete RPCs, restores), as is
-- service_role (the webhook) and postgres (cron). The emptied-new-entry guard 20261024100000 added inside the strip
-- function goes: it read the role GUC, which is the browser's role inside a definer RPC too, so it refused a definer RPC
-- called without the header (test-tombstone-rowless-db T12 (f); test-mu-auth's header-less rename, B17 review).
--
-- Rollback: supabase/rollback/20261025910000_history_strip_guard_first.rollback.sql (the strip body live before it).
-- Tests (rolled back): node scripts/tools/sql-tx.mjs supabase/migrations/20261025910000_history_strip_guard_first.sql --test scripts/test-history-strip-guard-db.sql
--   and with it: test-history-strip-db, test-history-strip-restore-db, test-history-emptied-db, test-tombstone-rowless-db,
--   test-mu-auth (header-less rename), test-rls-queued-rpcs, test-queued-deletes-db.

do $guard$
declare got text := md5(pg_get_functiondef('public._history_strip_deleted_items()'::regprocedure));
begin
  if got is distinct from '0a136484d6d3e9f4bed82d04221fe401' then
    raise exception '20261025910000: _history_strip_deleted_items changed since this migration was written (live %, expected 0a136484)', got;
  end if;
  if exists (select 1 from pg_trigger where tgname = 'history_0_scope_guard') then
    raise exception '20261025910000: history_0_scope_guard exists already';
  end if;
end $guard$;

create function public._history_browser_scope_guard()
 returns trigger
 language plpgsql
 security invoker
 set search_path to 'public', 'pg_catalog'
as $function$
begin
  -- SECURITY INVOKER: current_user is the role that ran the statement (a definer RPC's statement runs as its owner).
  if current_user in ('anon', 'authenticated') and new.device_id is distinct from proxima_auth.session_scope(false) then
    perform proxima_auth.session_scope(true);   -- 28000 without a valid header
    raise exception using errcode = '42501', message = 'new row violates row-level security policy for table "history"';
  end if;
  return new;
end $function$;
revoke execute on function public._history_browser_scope_guard() from public, anon, authenticated;

create trigger history_0_scope_guard before insert or update on public.history
  for each row execute function public._history_browser_scope_guard();

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
    -- 20261025910000: a browser naming a scope other than its session's never gets here: history_0_scope_guard refuses it
    -- first (before 20261025910000 this branch had its own copy of that guard). A SECURITY DEFINER caller (rename,
    -- upsert_queued_history, the delete RPCs) writes in the scope its own token proved.
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (new.id, 'history', new.device_id, now(), not v_user)
      on conflict (device_id, id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = excluded.by_restore and sync_tombstones.by_restore
        where sync_tombstones.device_id = excluded.device_id;
    return null;
  end if;
  new.tasks := v_tasks;
  new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                       from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
  return new;
end $function$;
