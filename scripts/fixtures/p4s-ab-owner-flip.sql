-- Fixture for scripts/test-mu-p4-ab-rollback.sql, after scripts/fixtures/p4s-ab-members.sql: the owner turns its own
-- switch the other way between 20261025800000 and its rollback, so the rollback must write the NEW value into the
-- global row (review round 8, c3 #1). Rolled back with the rest.
do $fx$
begin
  update proxima_auth.users set auto_backups = not auto_backups where role = 'owner';
  perform set_config('p4ab.owner_switch', public._auto_backups_on()::text, true);
  perform set_config('p4ab.flipped', 'on', true);
end $fx$;
