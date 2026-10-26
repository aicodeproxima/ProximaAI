-- Rollback of supabase/migrations/20261025800000_mu_p4_auto_backups_per_account.sql (exact inverse: the eight bodies
-- below are the live pg_get_functiondef text of 2026-10-25). Kept OUT of supabase/migrations/. The owner's switch goes
-- back into app_secrets 'auto_backups' first, so the global switch keeps the owner's value. With members, their own
-- switches are lost (the global one governs everyone again): an account whose own switch was on while the owner's is
-- off gets the scrub a switch-off queues, so its backups lose what it deleted while its switch was on.
set local lock_timeout = '2s';   -- a rollback that cannot take its locks within 2 s stops; a browser call is cancelled after 3 s
do $applied$
begin
  if to_regprocedure('public._auto_backups_on(text)') is null then
    raise exception 'refusing the 20261025800000 rollback: 20261025800000 is not applied (no public._auto_backups_on(text))';
  end if;
  -- 20261025820000 changes two of the bodies restored below: it is rolled back first (review round 12).
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261025820000') then
    raise exception 'refusing the 20261025800000 rollback: 20261025820000 is applied; run its rollback first';
  end if;
end $applied$;
-- Every switch read below happens under this lock, so no toggle can commit between those reads and the column's drop
-- (review round 9, c2 #1); the migration's own ALTER comes before its seed read for the same reason.
lock table proxima_auth.users in access exclusive mode;

-- md5 guard: the bodies this file restores or drops must still be the ones 20261025800000 installed. References guard
-- (review rounds 8 and 9, c2): nothing else may read the switch, or dropping the overload and the column would break it
-- at its next call (a function, a cron command) or take it along silently (an index, a check constraint) instead of
-- stopping here. Objects that depend on the column in pg_depend (a view, policy, trigger) would also stop the DROP.
do $rbguard$
declare
  v_cron boolean := false;
  v_att smallint := (select a.attnum from pg_attribute a
                      where a.attrelid = 'proxima_auth.users'::regclass and a.attname = 'auto_backups' and not a.attisdropped);
begin
  if md5(pg_get_functiondef('public._tasks_queue_backup_scrub()'::regprocedure)) <> '98c11f0beb2ffd743726cbe07b82dda0'
     or md5(pg_get_functiondef('public._history_queue_backup_scrub()'::regprocedure)) <> 'c3f158ccfe30da1b9a2ca496463bc5f3'
     or md5(pg_get_functiondef('public._history_queue_item_scrub()'::regprocedure)) <> 'ea573c190b948a82b6c07e465e0d6328'
     or md5(pg_get_functiondef('public.create_auto_backup()'::regprocedure)) <> '47ed1202174aef4a2ec7ff4c0322b5f3'
     or md5(pg_get_functiondef('public.get_auto_backups(text)'::regprocedure)) <> '48dbd7fe8e0a4472c2b24c7c2d9c2c81'
     or md5(pg_get_functiondef('public.set_auto_backups(text,boolean)'::regprocedure)) <> '82e9f8b8e41fa9f078ec93d5d5814710'
     or md5(pg_get_functiondef('public.snapshot_my_data_phase2(text,text,text)'::regprocedure)) <> '62f80166c1500e10b54c7ced6a6b7552'
     or md5(pg_get_functiondef('public.restore_my_backup_phase2(text,uuid)'::regprocedure)) <> 'ff31a8bb291d708e7cd89e8819b81d1e'
     or md5(pg_get_functiondef('public._auto_backups_on()'::regprocedure)) <> '09a5bef7489f75b4617e6da4d1e7ede4'
     or md5(pg_get_functiondef('public._auto_backups_on(text)'::regprocedure)) <> '321b60490f4a8c416470068f96232806' then
    raise exception 'refusing the 20261025800000 rollback: a function it restores changed since the migration (if 20261025820000 is applied, run its rollback first; otherwise write a new rollback from the live body)';
  end if;
  if exists (select 1 from pg_proc p
              where p.prosrc ~* 'auto_backups'
                and p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
                and p.oid not in ('public._tasks_queue_backup_scrub()'::regprocedure,
                                  'public._history_queue_backup_scrub()'::regprocedure,
                                  'public._history_queue_item_scrub()'::regprocedure,
                                  'public.create_auto_backup()'::regprocedure,
                                  'public.get_auto_backups(text)'::regprocedure,
                                  'public.set_auto_backups(text,boolean)'::regprocedure,
                                  'public.snapshot_my_data_phase2(text,text,text)'::regprocedure,
                                  'public.restore_my_backup_phase2(text,uuid)'::regprocedure,
                                  'public._auto_backups_on()'::regprocedure,
                                  'public._auto_backups_on(text)'::regprocedure)) then
    raise exception 'refusing the 20261025800000 rollback: another function reads the Automatic backups switch (%)',
      (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
        where p.prosrc ~* 'auto_backups' and p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
          and p.oid not in ('public._tasks_queue_backup_scrub()'::regprocedure, 'public._history_queue_backup_scrub()'::regprocedure, 'public._history_queue_item_scrub()'::regprocedure, 'public.create_auto_backup()'::regprocedure, 'public.get_auto_backups(text)'::regprocedure, 'public.set_auto_backups(text,boolean)'::regprocedure, 'public.snapshot_my_data_phase2(text,text,text)'::regprocedure, 'public.restore_my_backup_phase2(text,uuid)'::regprocedure, 'public._auto_backups_on()'::regprocedure, 'public._auto_backups_on(text)'::regprocedure));
  end if;
  -- Everything that depends on the column except the column's own default and (Postgres 18+) its own NOT NULL
  -- constraint, which go with it (review round 10, c1 #2).
  if exists (select 1 from pg_depend d
              where d.refobjid = 'proxima_auth.users'::regclass and d.refobjsubid = v_att
                and not (d.classid = 'pg_attrdef'::regclass
                         and d.objid in (select ad.oid from pg_attrdef ad where ad.adrelid = 'proxima_auth.users'::regclass and ad.adnum = v_att))
                and not (d.classid = 'pg_constraint'::regclass
                         and d.objid in (select c.oid from pg_constraint c where c.conrelid = 'proxima_auth.users'::regclass
                                            and c.contype = 'n' and c.conkey = array[v_att]))) then
    raise exception 'refusing the 20261025800000 rollback: another object depends on proxima_auth.users.auto_backups (%)',
      (select string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), ', ') from pg_depend d
        where d.refobjid = 'proxima_auth.users'::regclass and d.refobjsubid = v_att
          and not (d.classid = 'pg_attrdef'::regclass
                   and d.objid in (select ad.oid from pg_attrdef ad where ad.adrelid = 'proxima_auth.users'::regclass and ad.adnum = v_att))
          and not (d.classid = 'pg_constraint'::regclass
                   and d.objid in (select c.oid from pg_constraint c where c.conrelid = 'proxima_auth.users'::regclass
                                      and c.contype = 'n' and c.conkey = array[v_att])));
  end if;
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where command ~* ''auto_backups'')' into v_cron;
  end if;
  if v_cron then
    raise exception 'refusing the 20261025800000 rollback: a cron job reads the Automatic backups switch';
  end if;
end $rbguard$;

-- The owner's switch back into the global row (its updated_at kept when the value is unchanged, review round 8 c2 #4).
insert into public.app_secrets (key, value, updated_at)
  values ('auto_backups', jsonb_build_object('enabled', coalesce((select u.auto_backups from proxima_auth.users u where u.role = 'owner'), false)), now())
  on conflict (key) do update set value = excluded.value,
    updated_at = case when public.app_secrets.value = excluded.value then public.app_secrets.updated_at else now() end;
-- The global switch reads the owner's value again. An account whose own switch was on while the owner's is off kept the
-- copies of what it deleted meanwhile (its deletes queued no scrub), so it gets the scrub a switch-off queues (review
-- round 8, c2 #2). An account whose switch was off while the owner's is on simply has backups again.
insert into public.backup_scrub_queue (username, all_tombstones)
select distinct b.username, true
  from public.data_backups b
  join proxima_auth.users u on u.scope = b.username
 where u.auto_backups
   and not coalesce((select o.auto_backups from proxima_auth.users o where o.role = 'owner'), false);

CREATE OR REPLACE FUNCTION public._tasks_queue_backup_scrub()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public._history_queue_backup_scrub()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if coalesce(current_setting('proxima.restore', true), '') = 'on' or public._auto_backups_on() then return null; end if;
  insert into backup_scrub_queue (username, log_ids, task_ids)
  select g.device_id, array_agg(distinct g.id),
         coalesce(array_agg(distinct nullif(e.item->>'id', '')) filter (where coalesce(e.item->>'id', '') <> ''), '{}')
    from gone g
    left join lateral jsonb_array_elements(case when jsonb_typeof(g.tasks) = 'array' then g.tasks else '[]'::jsonb end) e(item) on true
   where g.device_id like 'user:%'
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
end $function$
;

CREATE OR REPLACE FUNCTION public.create_auto_backup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ DECLARE rec RECORD; backup_count integer := 0; BEGIN
  IF NOT public._auto_backups_on() THEN RETURN 0; END IF;
  FOR rec IN SELECT DISTINCT device_id AS username FROM public.tasks WHERE device_id LIKE 'user:%' LOOP INSERT INTO public.data_backups (username, backup_type, task_count, history_count, settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot) VALUES (rec.username, 'auto-2day', (SELECT count(*) FROM public.tasks WHERE device_id = rec.username), (SELECT count(*) FROM public.history WHERE device_id = rec.username), COALESCE((SELECT jsonb_object_agg(key, value) FROM public.settings WHERE device_id = rec.username AND key NOT LIKE 'form-inputs:%'), '{}'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(f.*)) FROM public.favorites f WHERE device_id = rec.username), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(t.*)) FROM (SELECT * FROM public.tasks WHERE device_id = rec.username ORDER BY start_time DESC LIMIT 500) t), '[]'::jsonb), COALESCE((SELECT jsonb_agg(row_to_json(h.*)) FROM (SELECT * FROM public.history WHERE device_id = rec.username ORDER BY timestamp DESC LIMIT 1000) h), '[]'::jsonb)); backup_count := backup_count + 1; END LOOP; DELETE FROM public.data_backups WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username ORDER BY created_at DESC) AS rn FROM public.data_backups WHERE backup_type = 'auto-2day') s WHERE rn > 30); RETURN backup_count; END; $function$
;

CREATE OR REPLACE FUNCTION public.get_auto_backups(p_session_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  -- The switch is global until P4: the owner's alone.
  if (proxima_auth.current_account(p_session_token)).role is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public._auto_backups_on();
end $function$
;

CREATE OR REPLACE FUNCTION public.set_auto_backups(p_session_token text, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  -- The switch is global until P4: the owner's alone.
  if (proxima_auth.current_account(p_session_token)).role is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into app_secrets (key, value, updated_at) values ('auto_backups', jsonb_build_object('enabled', coalesce(p_enabled, false)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if not coalesce(p_enabled, false) then
    -- The switch is global (app_secrets): every account's backups lose what that account deleted so far.
    insert into backup_scrub_queue (username, all_tombstones)
    select distinct b.username, true from data_backups b;
  end if;
  return public._auto_backups_on();
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
  IF coalesce(p_type, '') LIKE 'pre-%' AND NOT public._auto_backups_on() THEN
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

CREATE OR REPLACE FUNCTION public._auto_backups_on()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select coalesce((select (value->>'enabled')::boolean from app_secrets where key = 'auto_backups'), false)
$function$
;

drop function public._auto_backups_on(text);
alter table proxima_auth.users drop column auto_backups;
-- The 2 s limit is for this file's own statements; run this rollback on its own (one transaction). Whatever follows it
-- in the same transaction gets the connection's default (no limit) while the users lock is held.
set local lock_timeout to default;

-- The migration's own record goes with it, in the same transaction, so a later apply re-applies it.
delete from supabase_migrations.schema_migrations where version = '20261025800000' and name = 'mu_p4_auto_backups_per_account';
