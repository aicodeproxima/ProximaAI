-- Cross-device sync: broadcast tasks/history changes so open devices reconcile immediately
-- (the client also re-syncs on focus and every 20s; realtime just makes it instant). Idempotent.
do $$
declare t text;
begin
  foreach t in array array['tasks', 'history'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
