-- Review of 20261020211205_ws_webhook_events (two reviewers, 2026-10-20), measured before this change:
--
-- 1. Advisory locks. Every task write with a task_id took a transaction-long advisory lock (the AFTER trigger for
--    finished rows), and ws_webhook_apply took it before the row lock while an upsert takes the row lock first: a
--    device saving its own result while the webhook arrived could deadlock (one side aborted after ~1 s), and a single
--    50-row upload held 56 advisory locks in the shared lock table (a "save all" of hundreds of rows could exhaust it).
--    The locks are gone. Their only job was to stop a delivery and its row, committing at the same instant, from
--    missing each other; ws_webhook_sweep (pg_cron, every 5 minutes) now applies any such delivery instead.
-- 2. A result was dropped when the cloud row already said failed ("Poll error" from a poll refusal, a cancel, an older
--    build's "Failed to fetch"): the webhook only updated running rows and then discarded the outputs. A completed
--    delivery now replaces a failure, as everywhere else (tasks_keep_finished, the client's "result stands" rule);
--    a failed delivery still never replaces anything finished.
--
-- Leaves tasks_keep_finished, _rows_not_tombstoned and _rows_keep_owner (20261020210500, ...13) untouched.

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

-- A running row written after its delivery arrived takes the waiting outcome on the way in, and a failed row takes a
-- waiting result. Only NEW changes here; the AFTER trigger settles the delivery from the row as stored.
create or replace function public._tasks_take_webhook() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  e ws_webhook_events;
begin
  if new.task_id is null or new.status is null then
    return new;
  elsif new.status in ('pending', 'processing') then
    select * into e from ws_webhook_events where task_id = new.task_id and applied_at is null
      order by (status = 'completed') desc, received_at limit 1;
  elsif new.status = 'failed' then
    select * into e from ws_webhook_events where task_id = new.task_id and applied_at is null and status = 'completed'
      order by received_at limit 1;
  else
    return new;
  end if;
  if found then
    new.status        := e.status;
    new.outputs       := coalesce(e.outputs, new.outputs);
    new.error         := e.error;
    new.end_time      := e.end_time;
    new.wall_clock_ms := least(greatest(e.end_time - coalesce(new.start_time, e.end_time), 0), 2147483647)::int;
    new.inference_ms  := coalesce(e.inference_ms, new.wall_clock_ms);
    new.nsfw          := coalesce(e.nsfw, new.nsfw);
  end if;
  return new;
end $$;
revoke execute on function public._tasks_take_webhook() from public, anon, authenticated;

-- A stored finished row settles the deliveries it already reflects: a completed row settles all of them, a failed row
-- only failures (a waiting result must still be able to replace it).
create or replace function public._tasks_settle_webhook() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.task_id is not null and new.status in ('completed', 'failed') then
    update ws_webhook_events set applied_at = now(), outputs = null, error = null, nsfw = null
      where task_id = new.task_id and applied_at is null and (new.status = 'completed' or status = 'failed');
  end if;
  return null;
end $$;
revoke execute on function public._tasks_settle_webhook() from public, anon, authenticated;

drop function if exists public._ws_webhook_lock(text);

-- Applies deliveries that missed their row (both committed at the same instant, so neither saw the other) by
-- rewriting the row, which runs tasks_take_webhook again; settles deliveries whose row finished on its own; drops
-- deliveries older than 30 days. Returns how many rows it rewrote.
create or replace function public.ws_webhook_sweep() returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_rows int;
begin
  delete from ws_webhook_events where received_at < now() - interval '30 days';
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

select cron.schedule('ws-webhook-sweep', '*/5 * * * *', 'select public.ws_webhook_sweep()');
