-- After 20261025800000: a later function reads the column itself. A plain SQL body records no dependency on it, so the
-- DROP COLUMN would break it silently at its next call. The rollback must refuse.
create function public.__col_reader(p uuid) returns boolean language sql stable
  as $$ select u.auto_backups from proxima_auth.users u where u.id = p $$;
