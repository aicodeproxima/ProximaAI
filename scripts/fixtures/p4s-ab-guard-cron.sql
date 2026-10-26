-- After 20261025800000: a cron job whose command reads the switch column itself, spelled in capitals (plain text, no
-- recorded dependency; the guard must match any case and the column, not only the function's name). Rolled back with
-- the rest, so it never runs. The rollback must refuse.
select cron.schedule('__ab_guard_job', '0 0 1 1 *', 'select count(*) from proxima_auth.users where AUTO_BACKUPS');
