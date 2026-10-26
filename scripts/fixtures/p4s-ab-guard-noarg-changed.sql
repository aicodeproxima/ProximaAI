-- Before 20261025800000: someone changed the no-arg _auto_backups_on() (same result, other text). The migration must refuse.
create or replace function public._auto_backups_on() returns boolean
  language sql stable security definer set search_path to 'public', 'pg_catalog'
as $$ select coalesce((select (value->>'enabled')::boolean from public.app_secrets where key = 'auto_backups'), false) /* changed */ $$;
