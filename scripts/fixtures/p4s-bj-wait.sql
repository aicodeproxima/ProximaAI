-- Test-run fixture, after a prepended migration: its `set local lock_timeout = '2s'` is for its own statements at apply
-- time and would otherwise stay set for the suite that follows in the same transaction, which then fails with 55P03
-- whenever another session's test transaction holds a lock on a fixture table for over 2 s. Rolled back with the rest.
set local lock_timeout = '60s';
