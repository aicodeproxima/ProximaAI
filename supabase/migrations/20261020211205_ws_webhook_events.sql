-- WaveSpeed result webhook (api/ws-webhook.ts). WaveSpeed POSTs each submit's outcome; the function verifies the
-- signature and calls ws_webhook_apply, which writes it into the running cloud `tasks` row with that prediction id
-- (task_id). The result then lands even when every device is closed past WaveSpeed's retention (~48-54 h measured
-- 2026-10-20), and the devices take it from the cloud on their next sync (planTaskSync `finish`).
--
-- ws_webhook_events records every delivery once (webhook_id = Standard Webhooks message id, the same on WaveSpeed's
-- retries), so a replay is a no-op. A delivery whose row has not landed yet (a fast image beats the "processing"
-- upload, or the phone that submitted it went offline first) waits there, and the trigger below applies it when that
-- row is written. Rows a device already finished are never touched: the poll's own answer or the user's cancel stands.
-- Only the service role reaches the table and the function; the trigger runs with its owner's rights (browser roles
-- write tasks as anon, which has no access to the table).

create table if not exists public.ws_webhook_events (
  webhook_id   text primary key,
  task_id      text not null,
  status       text not null check (status in ('completed', 'failed')),
  outputs      jsonb,
  error        text,
  end_time     bigint not null,
  inference_ms integer,
  nsfw         jsonb,
  received_at  timestamptz not null default now(),
  applied_at   timestamptz
);
create index if not exists ws_webhook_events_waiting on public.ws_webhook_events (task_id) where applied_at is null;
alter table public.ws_webhook_events enable row level security;  -- no policies: browser roles see nothing
revoke all on public.ws_webhook_events from public, anon, authenticated;

create index if not exists tasks_task_id on public.tasks (task_id) where task_id is not null;

-- The webhook and a device's upload of the same task serialize on this lock, so neither can miss the other: whichever
-- runs second sees what the first committed.
create or replace function public._ws_webhook_lock(p_task_id text) returns void
language sql set search_path = public, pg_catalog as $$
  select pg_advisory_xact_lock(73110, hashtext(p_task_id));
$$;
revoke execute on function public._ws_webhook_lock(text) from public, anon, authenticated;

-- 'applied' (a running row finished) | 'finished' (the row was already finished: left alone) | 'queued' (no row
-- yet) | 'duplicate' (this webhook id was handled before).
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
  perform _ws_webhook_lock(p_task_id);
  delete from ws_webhook_events where received_at < now() - interval '30 days';
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
    where t.task_id = p_task_id and t.status in ('pending', 'processing');
  get diagnostics v_rows = row_count;

  if v_rows = 0 and not exists (select 1 from tasks where task_id = p_task_id) then
    return 'queued';
  end if;
  -- Handled: keep only the id (for replays), not the result.
  update ws_webhook_events set applied_at = now(), outputs = null, error = null, nsfw = null where webhook_id = p_webhook_id;
  return case when v_rows > 0 then 'applied' else 'finished' end;
end $$;
revoke execute on function public.ws_webhook_apply(text, text, text, jsonb, text, bigint, integer, jsonb) from public, anon, authenticated;
grant execute on function public.ws_webhook_apply(text, text, text, jsonb, text, bigint, integer, jsonb) to service_role;

-- A running row written after its webhook arrived takes the waiting outcome on the way in. Only NEW changes here:
-- an upsert fires this BEFORE INSERT trigger on the proposed row even when it turns into an update, and the update
-- keeps only the columns its SET list copies from `excluded`, so the delivery is marked handled after the write
-- (below), from the row as stored.
create or replace function public._tasks_take_webhook() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  e ws_webhook_events;
begin
  if new.task_id is null or new.status is null or new.status not in ('pending', 'processing') then
    return new;
  end if;
  perform _ws_webhook_lock(new.task_id);
  select * into e from ws_webhook_events
    where task_id = new.task_id and applied_at is null
    order by received_at limit 1;
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

-- A stored finished row settles its waiting deliveries: the one just copied in, or the device's own poll answer
-- that got there first.
create or replace function public._tasks_settle_webhook() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.task_id is not null and new.status in ('completed', 'failed') then
    perform _ws_webhook_lock(new.task_id);
    update ws_webhook_events set applied_at = now(), outputs = null, error = null, nsfw = null
      where task_id = new.task_id and applied_at is null;
  end if;
  return null;
end $$;
revoke execute on function public._tasks_settle_webhook() from public, anon, authenticated;

-- Runs after tasks_keep_finished (BEFORE triggers fire in name order), so a stale "processing" upload of a finished
-- row is already turned back into the finished row and is left alone here.
drop trigger if exists tasks_take_webhook on public.tasks;
create trigger tasks_take_webhook before insert or update on public.tasks
  for each row execute function public._tasks_take_webhook();
drop trigger if exists tasks_settle_webhook on public.tasks;
create trigger tasks_settle_webhook after insert or update on public.tasks
  for each row execute function public._tasks_settle_webhook();
