-- After 20261025800000: a later function reads the per-account switch, spelled in capitals (the guard must match any
-- case). The rollback must refuse.
create function public.__later_reader(p text) returns boolean language sql stable as $$ select public._AUTO_BACKUPS_ON(p) $$;
