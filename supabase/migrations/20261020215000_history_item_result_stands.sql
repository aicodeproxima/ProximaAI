-- Round-3 review wf_393b4699-2d7 #2 (Low), server guard: a device that expired its stale copies on load (more than
-- 48 h after the batch) could close a History entry with those failures and upload it over the entry another device
-- had already finished correctly; closed -> closed was always allowed. A result stands per item too now: a later
-- version never turns an item the entry records as completed (same item id) back into failed, and the total is
-- recomputed from the kept items. (The client also waits for its first cloud sync before finishing entries.)
create or replace function public._history_keep_finished() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
declare
  v_dev   text := new.device_id;
  v_tasks jsonb;
begin
  if not public._history_is_open(old.tasks) and public._history_is_open(new.tasks) then
    new := old;
    new.device_id := v_dev;   -- whether the row may change scope is the ownership trigger's call
    return new;
  end if;
  if jsonb_typeof(old.tasks) = 'array' and jsonb_typeof(new.tasks) = 'array' then
    select coalesce(jsonb_agg(case when n.e->>'status' = 'failed' and o.e->>'status' = 'completed' then o.e else n.e end
                              order by n.ord), '[]'::jsonb)
      into v_tasks
      from jsonb_array_elements(new.tasks) with ordinality as n(e, ord)
      left join lateral (select x as e from jsonb_array_elements(old.tasks) x
                          where x->>'id' is not null and x->>'id' = n.e->>'id' limit 1) o on true;
    if v_tasks is distinct from new.tasks then
      new.tasks := v_tasks;
      new.total_cost := (select coalesce(sum(case when jsonb_typeof(e->'cost') = 'number' then (e->>'cost')::numeric else 0 end), 0)
                           from jsonb_array_elements(v_tasks) e where e->>'status' = 'completed');
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._history_keep_finished() from public, anon, authenticated;
