-- After 20261025800000: an index on the switch column (a DROP COLUMN would take it along silently). The rollback must refuse.
create index __ab_guard_idx on proxima_auth.users (auto_backups);
