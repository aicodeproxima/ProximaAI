-- Multi-user P4, Automatic backups per account (docs/MULTI-USER-PLAN.md §5 P4 "auto_backups becomes per account"): every
-- account has its own switch, proxima_auth.users.auto_backups, instead of the owner's app_secrets row that governed every
-- account (and refused members with 42501). Every existing account starts with today's global value, so nothing changes
-- for the owner. The delete triggers decide per account, the 2-day cron backs up each account whose switch is on (one
-- account's failure no longer stops the others), and switching off scrubs only the caller's own backups. The no-arg
-- _auto_backups_on() stays as the owner's switch; nothing in the app reads app_secrets 'auto_backups' any more.
-- Scale (review round 10): the 2-day run backs up each account in its own subtransaction, so one account's error never
-- stops the others; a transaction keeps only 64 subtransactions in its process's cache, so past about 60 switched-on
-- accounts the run makes other sessions' visibility checks slower while it runs (measured 2026-10-25: 70 overflowed the
-- cache, 50 did not). Then the run should become a procedure that commits after each account (untestable in the
-- rolled-back test runs, so not now).
-- Seven of the functions belong to the lockdown session (backup area), restore_my_backup_phase2 to this session since
-- 20261025400000; only the lines below change, and the migration refuses if any body moved since 2026-10-25.
-- Rollback: supabase/rollback/20261025800000_mu_p4_auto_backups_per_account.rollback.sql
set local lock_timeout = '2s';   -- an apply that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s

do $guard$
begin
  if exists (select 1 from pg_attribute where attrelid = 'proxima_auth.users'::regclass and attname = 'auto_backups' and not attisdropped) then
    raise exception '20261025800000 is already applied (proxima_auth.users.auto_backups exists)';
  end if;
  if md5(pg_get_functiondef('public._tasks_queue_backup_scrub()'::regprocedure)) <> 'bf7d7f472a7d4d1a4d1c4a8120e96b0f'
     or md5(pg_get_functiondef('public._history_queue_backup_scrub()'::regprocedure)) <> 'd49baa3c3b8f80e2a1b1bf2d836548df'
     or md5(pg_get_functiondef('public._history_queue_item_scrub()'::regprocedure)) <> 'a9e4053e4cecdc1553428da3af520b20'
     or md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) <> '0b09301b4fdb8aad58d13a1624f8b42f'
     or md5(pg_get_functiondef('public.get_auto_backups(text)'::regprocedure)) <> '4b9bb02a32f53b6003d36b5ba52297a3'
     or md5(pg_get_functiondef('public.set_auto_backups(text,boolean)'::regprocedure)) <> '165cb99a909a0cfacce4a85d63d2f26a'
     or md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) <> 'cd5cfa09ae0b77204709bc230e287069'
     or md5(pg_get_functiondef('public.restore_my_backup_phase2(text,uuid)'::regprocedure)) <> '73ad6d26b1d87e713123311ad3db931b'
     or md5(pg_get_functiondef('public._auto_backups_on()'::regprocedure)) <> '53ea821054c058132019a67131b8600e' then
    raise exception 'a backup function changed since 20261025800000 was written: rebase it on the live bodies';
  end if;
end $guard$;

alter table proxima_auth.users add column auto_backups boolean not null default false;
update proxima_auth.users
   set auto_backups = coalesce((select (s.value->>'enabled')::boolean from public.app_secrets s where s.key = 'auto_backups'), false);

-- One account's switch.
create function public._auto_backups_on(p_scope text) returns boolean
  language sql stable security definer set search_path to 'public', 'pg_catalog'
as $$
  select coalesce((select u.auto_backups from proxima_auth.users u where u.scope = p_scope), false)
$$;
revoke all on function public._auto_backups_on(text) from public, anon, authenticated;
grant execute on function public._auto_backups_on(text) to service_role;

-- The owner's switch (the no-arg form, kept for the suites and tools that ask it).
create or replace function public._auto_backups_on() returns boolean
  language sql stable security definer set search_path to 'public', 'pg_catalog'
as $$
  select coalesce((select u.auto_backups from proxima_auth.users u where u.role = 'owner'), false)
$$;

CREATE OR REPLACE FUNCTION public._tasks_queue_backup_scrub()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  -- 20261025800000: the switch is per account, so the rows of an account whose own switch is on are left out below.
  if coalesce(current_setting('proxima.restore', true), '') = 'on' then return null; end if;
  insert into backup_scrub_queue (username, task_ids, outputs)
  select g.device_id,
         array_agg(distinct g.id),
         coalesce(array_agg(distinct u.value) filter (where u.value is not null and u.value <> ''), '{}')
    from gone g
    left join lateral jsonb_array_elements_text(case when jsonb_typeof(g.outputs) = 'array' then g.outputs else '[]'::jsonb end) u on true
    left join proxima_auth.users acc on acc.scope = g.device_id   -- 20261025800000: the account's own switch
   where g.device_id like 'user:%' and not coalesce(acc.auto_backups, false)
   group by g.device_id;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public._history_queue_backup_scrub()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  -- 20261025800000: the switch is per account, so the rows of an account whose own switch is on are left out below.
  if coalesce(current_setting('proxima.restore', true), '') = 'on' then return null; end if;
  insert into backup_scrub_queue (username, log_ids, task_ids)
  select g.device_id, array_agg(distinct g.id),
         coalesce(array_agg(distinct nullif(e.item->>'id', '')) filter (where coalesce(e.item->>'id', '') <> ''), '{}')
    from gone g
    left join lateral jsonb_array_elements(case when jsonb_typeof(g.tasks) = 'array' then g.tasks else '[]'::jsonb end) e(item) on true
    left join proxima_auth.users acc on acc.scope = g.device_id   -- 20261025800000: the account's own switch
   where g.device_id like 'user:%' and not coalesce(acc.auto_backups, false)
   group by g.device_id;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public._history_queue_item_scrub()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on'
     or coalesce(current_setting('proxima.rescope', true), '') = 'on' then return null; end if;
  -- 20261025800000: the switch is per account; the rows of an account whose own switch is on are left out below.
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
        left join proxima_auth.users acc on acc.scope = o.device_id   -- 20261025800000: the account's own switch
       where o.device_id like 'user:%' and not coalesce(acc.auto_backups, false)
         and not exists (
           select 1 from jsonb_array_elements(case when jsonb_typeof(n.tasks) = 'array' then n.tasks else '[]'::jsonb end) ne(e)
            where case when coalesce(oe.e->>'id', '') <> '' then ne.e->>'id' = oe.e->>'id' else ne.e = oe.e end)
    ) x
   group by x.device_id
  having count(x.item_id) > 0 or count(x.out) > 0;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.create_auto_backup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ DECLARE rec RECORD; backup_count integer := 0; BEGIN
  -- 20261025800000: every account whose own switch is on (and that has generations), one at a time; one account's
  -- failure is logged and never stops the others' backups.
  FOR rec IN SELECT u.id, u.scope AS username FROM proxima_auth.users u WHERE u.auto_backups AND u.disabled_at IS NULL AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.device_id = u.scope) ORDER BY u.scope LOOP BEGIN INSERT INTO public.data_backups (username, backup_type, task_count, history_count, settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot) VALUES (rec.username, 'auto-2day', (SELECT count(*) FROM public.tasks WHERE device_id = rec.username), (SELECT count(*) FROM public.history WHERE device_id = rec.username), COALESCE((SELECT jsonb_object_agg(key, value) FROM public.settings WHERE device_id = rec.username AND key NOT LIKE 'form-inputs:%'), '{}'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(f.*)) FROM public.favorites f WHERE device_id = rec.username), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(t.*)) FROM (SELECT * FROM public.tasks WHERE device_id = rec.username ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(h.*)) FROM (SELECT * FROM public.history WHERE device_id = rec.username ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb)); backup_count := backup_count + 1;
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'create_auto_backup: account % failed: % %', rec.id, sqlstate, sqlerrm; END; END LOOP; DELETE FROM public.data_backups WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username ORDER BY created_at DESC) AS rn FROM public.data_backups WHERE backup_type = 'auto-2day') s WHERE rn > 30); RETURN backup_count; END; $function$
;

CREATE OR REPLACE FUNCTION public.get_auto_backups(p_session_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  -- 20261025800000: every account has its own switch (proxima_auth.users.auto_backups), read by the account's id so a
  -- rename committing meanwhile never reads as off (review round 8).
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((select u.auto_backups from proxima_auth.users u where u.id = v_acc.id), false);
end $function$
;

CREATE OR REPLACE FUNCTION public.set_auto_backups(p_session_token text, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  -- 20261025800000: every account has its own switch (proxima_auth.users.auto_backups).
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update proxima_auth.users set auto_backups = coalesce(p_enabled, false), updated_at = now() where id = v_acc.id;
  perform public._verify_session_token(p_session_token);   -- again, now that the account row is held: a rename may have moved the account
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_acc.scope then raise exception 'session token revoked'; end if;
  if not coalesce(p_enabled, false) then
    -- Switching off: this account's backups lose what this account deleted so far (never another account's).
    -- Queued whether or not a backup is visible yet (review rounds 12-14). A backup still being written when this
    -- commits is reached only if no drain starts before it commits: a drain starting in between takes this row, and
    -- that backup keeps those copies (a window as long as the backup, accepted). With no backup, the drain has nothing
    -- to do.
    insert into backup_scrub_queue (username, all_tombstones) values (v_acc.scope, true);
  else
    -- Switching on: a switch-off's scrub still queued runs now, before this commits. Drained later, it would also take
    -- what this account deletes from here on, its pre-delete copies included, which an ON switch keeps (review round
    -- 17). It waits for a restore or a drain of this account; if it still cannot run, the switch stays off. Meanwhile
    -- the account row stays held, so this account's sign-in, unlock, password checks and key saves wait (at most this
    -- call's 3 s); draining before the UPDATE would take the restore marker before the row, the reverse of rename's
    -- order, and could deadlock with it (review round 18).
    perform public._drain_backup_scrubs(v_acc.scope);
    if exists (select 1 from backup_scrub_queue q where q.username = v_acc.scope and q.all_tombstones) then
      raise exception 'the last switch-off is still being applied to your backups; try again in a minute'
        using errcode = '55000';
    end if;
  end if;
  return coalesce((select u.auto_backups from proxima_auth.users u where u.id = v_acc.id), false);
end $function$
;

CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(p_session_token text, p_type text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_username text;
  v_id uuid := gen_random_uuid();
  v_tasks  jsonb;
  v_hist   jsonb;
  v_set    jsonb;
  v_fav    jsonb;
  v_ct     int;
  v_ch     int;
BEGIN
  v_username := (proxima_auth.current_account(p_session_token)).scope;
  IF v_username IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF coalesce(p_type, '') LIKE 'pre-%' AND NOT public._auto_backups_on(v_username) THEN   -- 20261025800000: this account's switch
    RETURN json_build_object('ok', true, 'skipped', true);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    INTO v_tasks
    FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t;
  SELECT COALESCE(jsonb_agg(row_to_json(h)), '[]'::jsonb)
    INTO v_hist
    FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_set
    FROM settings WHERE device_id = v_username AND key NOT LIKE 'form-inputs:%';
  SELECT COALESCE(jsonb_agg(row_to_json(f)), '[]'::jsonb)
    INTO v_fav
    FROM (SELECT * FROM favorites WHERE device_id = v_username) f;   -- aliased now

  SELECT count(*) INTO v_ct FROM tasks WHERE device_id = v_username;
  SELECT count(*) INTO v_ch FROM history WHERE device_id = v_username;

  INSERT INTO data_backups (
    id, username, backup_type, task_count, history_count,
    settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot, note
  ) VALUES (
    v_id, v_username, p_type, v_ct, v_ch,
    v_set, v_fav, v_tasks, v_hist, p_note
  );

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$function$
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
    if public._auto_backups_on(v_username) then   -- 20261025800000: this account's switch
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
  if not public._auto_backups_on(v_username) then   -- 20261025800000: this account's switch
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

-- The 2 s limit is for this file's own statements. It goes back to the connection's default (no limit) for whatever
-- follows in the same transaction: apply-migration.mjs's own schema_migrations insert (which waits on nothing the app
-- holds; it applies each file in its own transaction), or more files in a rolled-back test run, whose statements a
-- leftover limit failed.
set local lock_timeout to default;
