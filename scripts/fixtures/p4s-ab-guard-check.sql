-- After 20261025800000: a check constraint on the switch column (a DROP COLUMN would drop it silently, with any other
-- rule it carried). The rollback must refuse.
alter table proxima_auth.users add constraint __ab_guard_chk check (auto_backups is not null);
