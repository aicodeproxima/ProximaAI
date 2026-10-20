-- A batch's History entry is uploaded when the batch starts (tasks still pending/processing) and again once every
-- task has finished. Uploads can land out of order and a queued open version can replay late, so a finished entry is
-- never turned back into an open one. (Same rule as tasks_keep_finished.)
create or replace function public._history_is_open(t jsonb) returns boolean
language sql immutable set search_path = public, pg_catalog as $$
  -- CASE, not AND: SQL does not promise short-circuit order, and a non-array would make jsonb_array_elements raise.
  select case when jsonb_typeof(t) = 'array'
    then exists (select 1 from jsonb_array_elements(t) e where e->>'status' in ('pending', 'processing'))
    else false end
$$;

create or replace function public._history_keep_finished() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if not public._history_is_open(old.tasks) and public._history_is_open(new.tasks) then
    return old;
  end if;
  return new;
end $$;

revoke execute on function public._history_keep_finished() from public, anon, authenticated;

drop trigger if exists history_keep_finished on public.history;
create trigger history_keep_finished before update on public.history
  for each row execute function public._history_keep_finished();
