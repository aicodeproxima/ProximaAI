-- Delete means delete, for WaveSpeed result deliveries (review finding #8, 2026-10-22).
-- A generation deleted while it was still running on WaveSpeed got its result later: ws_webhook_apply stored it with
-- its output URLs and, finding no tasks row, left it 'queued' for 30 days. The same happened to a generation deleted
-- before its row ever reached the cloud, and to rows a restore removed (the purge trigger skips restores).
--
-- ws_deleted_predictions lists prediction ids deleted in the last 7 days. It is filled by the tasks AFTER DELETE trigger
-- (cloud rows; during a restore too, so every task_id the restore deleted is listed, and the rows it puts back are
-- unaffected because they exist) and by ws_predictions_deleted, which api/ws-proxy.ts calls with every delete the app
-- sends to WaveSpeed (this covers rows that never reached the cloud). A delivery for a listed id that has no tasks row
-- is not kept: ws_webhook_apply stores nothing and answers 'deleted', and ws_webhook_sweep removes any that slipped in
-- (a restore, or a delete committing at the same instant). A listed id whose row still exists is handled as before;
-- the row's own delete then purges the delivery.
-- Owner ruling 2026-10-22: the sweep also keeps removing deliveries that waited more than 2 days for a row that never
-- came (a delete that never reached the server, e.g. site data cleared offline), instead of keeping them 30 days.

create table if not exists public.ws_deleted_predictions (
  task_id    text primary key,
  deleted_at timestamptz not null default now()
);
alter table public.ws_deleted_predictions enable row level security;  -- no policies: browser roles see nothing
revoke all on public.ws_deleted_predictions from public, anon, authenticated;

-- A deleted generation leaves no webhook delivery behind, and one delivered later is not kept either. During a
-- restore the delivery stays for the rows the restore puts back; ws_webhook_sweep removes the rest.
create or replace function public._tasks_purge_webhook_events() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if old.task_id is not null then
    insert into ws_deleted_predictions (task_id) values (old.task_id)
      on conflict (task_id) do update set deleted_at = excluded.deleted_at;
    if coalesce(current_setting('proxima.restore', true), '') <> 'on' then
      delete from ws_webhook_events where task_id = old.task_id;
    end if;
  end if;
  return old;
end $$;
revoke execute on function public._tasks_purge_webhook_events() from public, anon, authenticated;
-- (trigger tasks_purge_webhook_events from 20261021171500 is unchanged and keeps calling this function)

-- The proxy records the predictions the app deletes on WaveSpeed (api/ws-proxy.ts, before forwarding the delete).
-- It also removes stored deliveries of those ids, applied ones included: for a row that still exists, that only
-- forgets the duplicate check of a delivery whose row is being deleted. Returns how many deliveries it removed.
create or replace function public.ws_predictions_deleted(p_ids text[]) returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_rows int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 500 then
    raise exception 'ws_predictions_deleted: at most 500 ids, got %', cardinality(p_ids);
  end if;
  insert into ws_deleted_predictions (task_id)
    select distinct i from unnest(p_ids) i where i is not null and i <> '' and length(i) <= 200
    on conflict (task_id) do update set deleted_at = excluded.deleted_at;
  delete from ws_webhook_events where task_id = any(p_ids);
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;
revoke execute on function public.ws_predictions_deleted(text[]) from public, anon, authenticated;
grant execute on function public.ws_predictions_deleted(text[]) to service_role;

-- 'applied' | 'finished' | 'queued' | 'duplicate' as before (20261020212826), plus 'deleted': the app deleted this
-- prediction and no row carries it, so nothing from the delivery is kept (WaveSpeed's retries get the same answer).
create or replace function public.ws_webhook_apply(
  p_webhook_id text, p_task_id text, p_status text, p_outputs jsonb, p_error text, p_end_time bigint,
  p_inference_ms integer default null, p_nsfw jsonb default null
) returns text
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_rows int;
begin
  if p_status not in ('completed', 'failed') then
    raise exception 'ws_webhook_apply: status must be completed or failed, got %', p_status;
  end if;
  if exists (select 1 from ws_deleted_predictions where task_id = p_task_id)
     and not exists (select 1 from tasks where task_id = p_task_id) then
    return 'deleted';
  end if;
  insert into ws_webhook_events (webhook_id, task_id, status, outputs, error, end_time, inference_ms, nsfw)
    values (p_webhook_id, p_task_id, p_status, p_outputs, p_error, p_end_time, p_inference_ms, p_nsfw)
    on conflict (webhook_id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  update tasks t set
      status        = p_status,
      outputs       = coalesce(p_outputs, t.outputs),
      error         = p_error,
      end_time      = p_end_time,
      wall_clock_ms = least(greatest(p_end_time - coalesce(t.start_time, p_end_time), 0), 2147483647)::int,
      inference_ms  = coalesce(p_inference_ms, least(greatest(p_end_time - coalesce(t.start_time, p_end_time), 0), 2147483647)::int),
      nsfw          = coalesce(p_nsfw, t.nsfw)
    where t.task_id = p_task_id
      and (t.status in ('pending', 'processing') or (p_status = 'completed' and t.status = 'failed'));
  get diagnostics v_rows = row_count;

  if v_rows = 0 and not exists (select 1 from tasks where task_id = p_task_id) then
    return 'queued';
  end if;
  update ws_webhook_events set applied_at = now(), outputs = null, error = null, nsfw = null where webhook_id = p_webhook_id;
  return case when v_rows > 0 then 'applied' else 'finished' end;
end $$;
revoke execute on function public.ws_webhook_apply(text, text, text, jsonb, text, bigint, integer, jsonb) from public, anon, authenticated;
grant execute on function public.ws_webhook_apply(text, text, text, jsonb, text, bigint, integer, jsonb) to service_role;

-- As before (20261020212826), plus: removes deliveries of deleted predictions that no row carries (rows a restore did
-- not bring back; a delivery and a delete that committed at the same instant), removes deliveries that have waited
-- more than 2 days for a row that never came (owner ruling 2026-10-22: a device uploads its row as soon as WaveSpeed
-- accepts the submit, and WaveSpeed keeps a prediction ~2 days), and forgets deletes older than 7 days.
-- Returns how many task rows it rewrote.
create or replace function public.ws_webhook_sweep() returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_rows int;
begin
  delete from ws_webhook_events where received_at < now() - interval '30 days';
  delete from ws_deleted_predictions where deleted_at < now() - interval '7 days';
  delete from ws_webhook_events e
    where exists (select 1 from ws_deleted_predictions d where d.task_id = e.task_id)
      and not exists (select 1 from tasks t where t.task_id = e.task_id);
  delete from ws_webhook_events e
    where e.applied_at is null and e.received_at < now() - interval '2 days'
      and not exists (select 1 from tasks t where t.task_id = e.task_id);
  update tasks t set status = t.status
    where t.task_id in (select e.task_id from ws_webhook_events e where e.applied_at is null)
      and (t.status in ('pending', 'processing')
           or (t.status = 'failed' and exists (select 1 from ws_webhook_events e
                where e.task_id = t.task_id and e.applied_at is null and e.status = 'completed')));
  get diagnostics v_rows = row_count;
  update ws_webhook_events e set applied_at = now(), outputs = null, error = null, nsfw = null
    where e.applied_at is null
      and exists (select 1 from tasks t where t.task_id = e.task_id
                  and (t.status = 'completed' or (t.status = 'failed' and e.status = 'failed')));
  return v_rows;
end $$;
revoke execute on function public.ws_webhook_sweep() from public, anon, authenticated;
-- (cron job 'ws-webhook-sweep' from 20261020212826 is unchanged)

-- One-time: deliveries kept before this fix for generations deleted while running (nothing recorded their ids). A
-- delivery that has waited over a day for a row that never came is treated as one of them: a device uploads its row as
-- soon as WaveSpeed accepts the submit, and a lost submit is adopted within the hour.
delete from public.ws_webhook_events e
  where e.applied_at is null and e.received_at < now() - interval '1 day'
    and not exists (select 1 from public.tasks t where t.task_id = e.task_id);
