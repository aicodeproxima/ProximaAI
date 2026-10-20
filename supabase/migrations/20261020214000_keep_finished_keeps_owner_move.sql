-- Regression review wf_9ad3cd3b-5c8 #2 (Low): _tasks_keep_finished and _history_keep_finished kept a finished row by
-- returning OLD, which also discarded the row's proposed device_id. BEFORE triggers fire in name order, so the
-- ownership trigger (tasks_keep_owner / history_keep_owner, next) never saw an allowed move into the live account's
-- scope: a row left under a renamed-away scope could never heal and was re-uploaded on every reconcile (the ping-pong
-- 20261020000010 fixed). Now the finished content is kept and the proposed owner passes on to the ownership rule.

create or replace function public._tasks_keep_finished() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
declare
  v_dev text := new.device_id;
begin
  -- A finished row is never turned back into a running one, and a result stands over a later failure.
  if (old.status in ('completed', 'failed') and new.status in ('pending', 'processing'))
     or (old.status = 'completed' and new.status = 'failed') then
    new := old;
    new.device_id := v_dev;   -- whether the row may change scope is the ownership trigger's call
    return new;
  end if;
  -- Archived outputs are never swapped back to WaveSpeed's temporary URLs by a late poll.
  if old.status = 'completed' and new.status = 'completed'
     and public._outputs_archived(old.outputs) and not public._outputs_archived(new.outputs) then
    new.outputs := old.outputs;
  end if;
  return new;
end $$;
revoke execute on function public._tasks_keep_finished() from public, anon, authenticated;

create or replace function public._history_keep_finished() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
declare
  v_dev text := new.device_id;
begin
  if not public._history_is_open(old.tasks) and public._history_is_open(new.tasks) then
    new := old;
    new.device_id := v_dev;
    return new;
  end if;
  return new;
end $$;
revoke execute on function public._history_keep_finished() from public, anon, authenticated;
