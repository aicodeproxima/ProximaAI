-- Cross-device sync: the server remembers every deleted task/history id, so other devices can drop
-- their cached copy. (A row's absence from the cloud alone can't tell "deleted" from "never uploaded",
-- and guessing wrong either resurrects deletes or destroys a device's only copy.) Idempotent.
create table if not exists public.sync_tombstones (
  id text primary key,
  kind text not null check (kind in ('task', 'history')),
  device_id text not null,
  deleted_at timestamptz not null default now()
);
create index if not exists sync_tombstones_scope_idx on public.sync_tombstones (device_id, kind, id);
alter table public.sync_tombstones enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sync_tombstones'
                 and policyname = 'sync_tombstones_device_access') then
    -- Same access model as tasks/history (scope enforced by device_id in the client).
    create policy sync_tombstones_device_access on public.sync_tombstones for all to anon using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on public.sync_tombstones to anon, authenticated;

-- Triggers keep tombstones exact for every delete path (bulk delete, clear, restore, SQL):
-- a delete records the id, a re-insert (e.g. restoring a backup) clears it.
create or replace function public.sync_tombstone_record() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.sync_tombstones (id, kind, device_id, deleted_at)
  values (old.id, tg_argv[0], old.device_id, now())
  on conflict (id) do update set kind = excluded.kind, device_id = excluded.device_id, deleted_at = excluded.deleted_at;
  return old;
end $$;

create or replace function public.sync_tombstone_clear() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.sync_tombstones where id = new.id;
  return new;
end $$;

drop trigger if exists tasks_sync_tombstone on public.tasks;
create trigger tasks_sync_tombstone after delete on public.tasks
  for each row execute function public.sync_tombstone_record('task');
drop trigger if exists tasks_sync_untombstone on public.tasks;
create trigger tasks_sync_untombstone after insert on public.tasks
  for each row execute function public.sync_tombstone_clear();
drop trigger if exists history_sync_tombstone on public.history;
create trigger history_sync_tombstone after delete on public.history
  for each row execute function public.sync_tombstone_record('history');
drop trigger if exists history_sync_untombstone on public.history;
create trigger history_sync_untombstone after insert on public.history
  for each row execute function public.sync_tombstone_clear();

-- Backfill deletes made before tombstones existed: ids captured in pre-delete backups that are no
-- longer in the cloud were deleted.
insert into public.sync_tombstones (id, kind, device_id, deleted_at)
select distinct on (e->>'id') e->>'id', 'task', coalesce(e->>'device_id', b.username), b.created_at
from public.data_backups b, jsonb_array_elements(coalesce(b.tasks_snapshot, '[]'::jsonb)) e
where e->>'id' is not null and not exists (select 1 from public.tasks t where t.id = e->>'id')
order by e->>'id', b.created_at desc
on conflict (id) do nothing;

insert into public.sync_tombstones (id, kind, device_id, deleted_at)
select distinct on (e->>'id') e->>'id', 'history', coalesce(e->>'device_id', b.username), b.created_at
from public.data_backups b, jsonb_array_elements(coalesce(b.history_snapshot, '[]'::jsonb)) e
where e->>'id' is not null and not exists (select 1 from public.history h where h.id = e->>'id')
order by e->>'id', b.created_at desc
on conflict (id) do nothing;
