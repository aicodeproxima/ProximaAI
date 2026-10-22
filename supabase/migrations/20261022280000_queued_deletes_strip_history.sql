-- Review round 8 (2026-10-22): the row delete was restore-checked (delete_queued_rows), but the History half of a delete
-- (trimmed entries uploaded, emptied ones deleted) was sent by the client separately, seconds later and unchecked: a
-- restore landing in between had its History stripped or deleted again (and, with backups OFF, scrubbed from every
-- backup). delete_queued_rows now does the History half itself, in the same transaction, through the existing triggers
-- (strip items with user tombstones, drop emptied entries, queue scrubs). Body: the live definition with only this
-- edit; grants kept. Test: test-queued-deletes-db.sql case history-in-same-transaction.

CREATE OR REPLACE FUNCTION public.delete_queued_rows(p_session_token text, p_kind text, p_ids text[], p_queued_at bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
  v_n       int := 0;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
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
