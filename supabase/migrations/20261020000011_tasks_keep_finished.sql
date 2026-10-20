-- A running task is uploaded as "processing" right after submit, so another open device can finish it while the
-- first one is frozen or closed. Uploads can land out of order, and a queued "processing" upload can replay after the
-- result was saved, so a finished row (completed / failed) is never turned back into a running one. Finished rows can
-- still change (a recovered task goes failed -> completed; the archive swaps in permanent output URLs).
create or replace function public._tasks_keep_finished() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if old.status in ('completed', 'failed') and new.status in ('pending', 'processing') then
    return old;
  end if;
  return new;
end $$;

revoke execute on function public._tasks_keep_finished() from public, anon, authenticated;

drop trigger if exists tasks_keep_finished on public.tasks;
create trigger tasks_keep_finished before update on public.tasks
  for each row execute function public._tasks_keep_finished();
