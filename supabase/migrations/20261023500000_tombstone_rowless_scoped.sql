-- Tombstones for rowless named ids, scoped to the caller's account (simulator findings F1, F2, F4; scripts/sim,
-- commit b0b9878). Design agreed with the RLS session (which owns P4 and will change sync_tombstones' key to
-- (device_id, id) later):
--   1. delete_queued_rows and _clear_kind (clear_queued_rows, reset_queued_rows) record a user tombstone for EVERY named
--      id, task and History kind, that has no row in any account, with device_id = the caller's scope
--      (current_account(token).scope, which both already resolve). Before, a rowless task id got one only if a live
--      History item of the account held it, and a rowless History id never, so a row that landed later (another
--      device's queued upload, the page's own in-flight upload) brought a confirmed delete back on every device (F1, F4).
--      "on conflict (id) do nothing" while the key is (id): an update would move another account's real tombstone into
--      this scope and let that account's devices re-upload the id.
--   2. _clear_kind turns a restore's tombstone (by_restore) of a named id into a user tombstone, as delete_queued_rows
--      does (F2); before, only History-held orphans were flipped. Task kind only, as in delete_queued_rows (by_restore
--      is read for task tombstones only, outside restore_my_backup_phase2's own transaction).
--   3. _rows_not_tombstoned is scope-aware: only a tombstone with device_id = new.device_id drops an insert or upsert, so
--      account A's tombstone can never silence account B's row of the same id. The restore bypass (proxima.restore) and
--      rename_my_account's move of tombstones are unchanged.
--   4. Needed with 3 (beyond the agreed list, same reason as "do nothing" in 1), all scope guards only:
--      - sync_tombstone_clear removes only the inserting scope's tombstone: once A may insert an id B tombstoned, the
--        old "delete where id = new.id" let A's insert erase B's tombstone (B's devices would then re-upload it);
--      - sync_tombstone_record updates an existing tombstone only in the same scope ("do update ... where device_id =
--        excluded.device_id"): otherwise A's delete of that row would move B's tombstone into A's scope;
--      - _history_strip_deleted_items strips only items with a user tombstone of the entry's own scope, and its
--        "brand-new entry left empty" tombstone does not move another scope's: with 1, naming B's generation id would
--        otherwise let A strip it from B's History uploads (and drop a new single-item entry of B's).
--   5. Review tombcrit #1: the rowless "no row, so tombstone" check raced an insert of the same id (READ COMMITTED: the
--      delete saw no uncommitted row, the insert's trigger no uncommitted tombstone; both committed, row live next to a
--      user tombstone of its scope). Both sides now take one transaction-scoped advisory lock per (kind, scope),
--      hashtextextended('proxima-rows:' || kind || ':' || scope, 0): delete_queued_rows and _clear_kind exclusively,
--      before their first row read (the task kind takes task then history, as it changes History entries too);
--      _rows_not_tombstoned shared, before its tombstone read (skipped under the restore bypass). Delete first: the
--      insert waits, then reads the committed tombstone and is dropped. Insert first: the delete waits, then sees the
--      row and deletes it normally (its delete trigger records the tombstone). Each statement after the lock takes a new
--      snapshot (READ COMMITTED, volatile plpgsql), so the read after the wait sees the other side's commit.
--      Why per scope, not per id: a per-id key costs one shared-lock-table slot per id (64 x 60 connections = 3840 slots
--      measured 2026-10-23), and Clear Outputs names every local generation (no server cap) while an upload batch is not
--      chunked; 20261020212826 removed per-row advisory locks for that reason. Per scope it is at most 2 locks per delete
--      call and 1 per (kind, scope) per insert transaction. Only the scope's tombstones drop its inserts (rule 3), so the
--      scope key covers every pair that can conflict. Cost: within one account, an upload of a kind waits while a delete
--      RPC of that kind runs (and the delete waits for uploads in flight), typically milliseconds; other accounts never
--      wait; inserts never wait for each other (shared). Lock order is fixed (task before history; inserts take one key
--      and touch no row first), so the locks add no deadlock cycle between a delete call and an upload.
--      Within one scope (all live data today: one account, every row and tombstone in its scope) every rule is the same
--      as before. The one cross-account case the key (id) cannot serve: a tombstone A wrote for an id before B's row of
--      it existed stays A's, so B's later delete of that row records none (B's other devices could re-upload it). That
--      needs A to name B's id before B has it; P4's key (device_id, id) removes the case.
--   6. RLS review of 5: the trigger runs before the row policies' WITH CHECK, so a sessionless or forged browser insert
--      naming another account's scope ('user:<name>' is guessable) held that scope's shared key until its statement
--      failed, delaying that account's delete RPCs (no data effect). _rows_not_tombstoned is now SECURITY INVOKER (its
--      only attribute change), so current_user is the inserting statement's user, and a policy-checked insert
--      (row_security_active: anon, authenticated) whose device_id is not its session's scope
--      (proxima_auth.session_scope(false): null without a session, 28000 for a bad token, as the policy) returns before
--      the lock and is refused by WITH CHECK as before. Server inserts take the key as in 5 whatever the header says:
--      service_role (webhook) and postgres (cron) bypass RLS, and a SECURITY DEFINER RPC's insert (upsert_queued_history,
--      token in its argument) runs as postgres. A permitted browser insert reads tombstones as itself, through
--      sync_tombstones' select policy (device_id = session scope = new.device_id): the same rows as before. The delete
--      paths, the restore bypass and the lock order are unchanged.
-- Every other line of the six bodies (and every attribute but _rows_not_tombstoned's SECURITY DEFINER, item 6) is the
-- live text (pg_get_functiondef, captured 2026-10-23 by a script; the changes are counted replacements). md5 of
-- pg_get_functiondef, live -> after this file:
--   public.delete_queued_rows(text,text,text[],bigint)             0a0684db11559e26e42109a2c22d5ad2 -> 03e6c0037cae1b799acd8958594b0297
--   public._clear_kind(text,text,timestamp with time zone,text[])  32d2620d2b859e0b860f2d32f7264020 -> 6f4ebd0c7bbdfe6f994d5705054e1df4
--   public._rows_not_tombstoned()                                  28459f90f099134f5eba9487152cb54a -> 47a9f89fa644b291e5f2fffdb8da24eb
--   public.sync_tombstone_record()                                 cb47c9f00d728476b61ae2f7f766a3fb -> 512467f0f3caa41566dccaa1d01a4fb1
--   public.sync_tombstone_clear()                                  8eaf29a81363d1451d0b2f9a5417f2f4 -> 7909d202728ef4b4baf03b2e941faf62
--   public._history_strip_deleted_items()                          3e0587629f113442d7d95852e8dc166f -> b8a79e1bbae42745db22415003deec6e
-- One transaction (apply-migration.mjs, one file per transaction); no transaction control here.
-- 0. compare-and-swap: every function above still has its live md5, owner postgres and its grants, and sync_tombstones'
--    key is still (id); otherwise nothing changes. M4 (20261023400000_mu_p1_end_dual_accept, applied before this file)
--    does not touch any of the six (it replaces _verify_session_token and current_account only).
-- 1. the six functions (CREATE OR REPLACE keeps owner, grants and triggers).
-- 2. post-check: each has exactly the post md5, owner and grants.
-- Rollback: supabase/rollback/20261023500000_tombstone_rowless_scoped.rollback.sql (run it BEFORE M4's and M1's rollbacks).
-- Tests: node scripts/tools/sql-tx.mjs supabase/migrations/20261023500000_tombstone_rowless_scoped.sql --test scripts/test-tombstone-rowless-db.sql

-- ── 0. Preconditions ──
do $pk$
begin
  if to_regclass('public.sync_tombstones') is null
     or (select pg_get_constraintdef(c.oid) from pg_constraint c
          where c.conrelid = 'public.sync_tombstones'::regclass and c.contype = 'p') is distinct from 'PRIMARY KEY (id)' then
    raise exception '20261023500000: sync_tombstones'' primary key is no longer (id); P4 changed it, rebuild this file for (device_id, id)';
  end if;
end $pk$;

do $pre$
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
    raise exception '20261023500000 refused, a function differs from the capture: % -- rebuild this migration from the live bodies', v_bad;
  end if;
end $pre$;

-- ── 1. Functions ──

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
end $function$;

-- public._rows_not_tombstoned()
CREATE OR REPLACE FUNCTION public._rows_not_tombstoned()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' then
    return new;
  end if;
  -- 20261023500000 (RLS review): SECURITY INVOKER, so current_user is the statement's own user: anon or authenticated
  -- for a browser insert (row policies apply), postgres inside a SECURITY DEFINER RPC (upsert_queued_history) and for
  -- cron, service_role for the webhook. A policy-checked insert naming any scope but its session's own (no session, a
  -- forged or another account's device_id) is refused by the policy's WITH CHECK right after this trigger: it returns
  -- here, before the lock, so it never holds another scope's lock while its statement fails. session_scope(false) is
  -- null without a session and raises 28000 for a bad token, as the policy would. Its tombstone read below then runs
  -- as that user, through sync_tombstones' select policy (device_id = session scope = new.device_id: the same rows).
  if row_security_active(tg_relid) and new.device_id is distinct from proxima_auth.session_scope(false) then
    return new;
  end if;
  -- 20261023500000 (tombcrit #1): the scope's row lock, shared (inserts never wait for each other), before the tombstone
  -- is read: a delete RPC of this scope and kind that is running finishes first, and the check below then sees its
  -- tombstones; one that starts later waits for this insert and then sees the row.
  perform pg_advisory_xact_lock_shared(hashtextextended('proxima-rows:' || tg_argv[0] || ':' || coalesce(new.device_id, ''), 0));
  if exists (select 1 from sync_tombstones where id = new.id and kind = tg_argv[0] and device_id = new.device_id) then
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
                                 by_restore = excluded.by_restore
   where sync_tombstones.device_id = excluded.device_id;
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
  delete from public.sync_tombstones where id = new.id and device_id = new.device_id;
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
                   join sync_tombstones st on st.id = e->>'id' and st.kind = 'task' and not st.by_restore
                                          and st.device_id = new.device_id) then
    return new;
  end if;
  select coalesce(jsonb_agg(x.e order by x.o), '[]'::jsonb) into v_tasks
    from jsonb_array_elements(new.tasks) with ordinality x(e, o)
   where not exists (select 1 from sync_tombstones st where st.id = x.e->>'id' and st.kind = 'task' and not st.by_restore
                        and st.device_id = new.device_id);
  if tg_op = 'INSERT' and jsonb_array_length(v_tasks) = 0 and not exists (select 1 from history h where h.id = new.id) then
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
      values (new.id, 'history', new.device_id, now(), false)
      on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at,
                                     by_restore = false
        where sync_tombstones.device_id = excluded.device_id;
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
    raise exception '20261023500000 post-check: %', v_bad;
  end if;
end $post$;
