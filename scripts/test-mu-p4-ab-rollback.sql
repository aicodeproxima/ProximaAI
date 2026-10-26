-- Rollback of 20261025800000 with members present (review round 8, c2 #2). One sql-tx call, everything rolled back:
--   AB=supabase/migrations/20261025800000_mu_p4_auto_backups_per_account.sql
--   RB=supabase/rollback/20261025800000_mu_p4_auto_backups_per_account.rollback.sql  FX=scripts/fixtures/p4s-ab-members.sql
--   node scripts/tools/sql-tx.mjs $AB $FX $RB --test scripts/test-mu-p4-ab-rollback.sql
--   node scripts/tools/sql-tx.mjs scripts/fixtures/p4s-ab-on.sql $AB $FX $RB --test scripts/test-mu-p4-ab-rollback.sql
--   and both again with FL=scripts/fixtures/p4s-ab-owner-flip.sql after $FX (the owner's switch changes in between)
-- Guards (each run must stop with the quoted refusal; the probe is never reached): G=scripts/fixtures/p4s-ab-guard-
--   sql-tx ${G}noarg-changed.sql $AB --test ${G}noop.sql      "a backup function changed since 20261025800000 was written"
--   sql-tx $AB ${G}set-changed.sql $RB --test ${G}noop.sql    "refusing the 20261025800000 rollback: a function it restores changed"
--   sql-tx $AB ${G}later-reader.sql $RB --test ${G}noop.sql   "refusing the 20261025800000 rollback: another function reads"
--   sql-tx $AB ${G}column-reader.sql $RB --test ${G}noop.sql  "refusing the 20261025800000 rollback: another function reads"
--   sql-tx $AB ${G}index.sql $RB --test ${G}noop.sql          "refusing the 20261025800000 rollback: another object depends"
--   sql-tx $AB ${G}check.sql $RB --test ${G}noop.sql          "refusing the 20261025800000 rollback: another object depends"
--   sql-tx $AB ${G}cron.sql $RB --test ${G}noop.sql           "refusing the 20261025800000 rollback: a cron job reads"
-- After the rollback the global row governs everyone again and holds the owner's switch (its updated_at unchanged when
-- the value is). With the owner's switch off, M (its own switch was on) gets the scrub a switch-off queues, so the drain
-- removes what M deleted from M's backups; N (off all along) keeps only the scrub its delete queued. With the owner's
-- switch on nobody gets a new scrub. Fixture accounts only; counts and md5 fingerprints only.
do $t$
declare
  r text[] := '{}';
  v_owner boolean := current_setting('p4ab.owner_switch', true)::boolean;
  m_all int; n_all int; n_other int; m_new int;
begin
  if v_owner is null then
    raise exception 'RESULT: 0 PASS, 1 FAIL :: FAIL fixture scripts/fixtures/p4s-ab-members.sql did not run between the migration and its rollback';
  end if;
  r := r || format('%s rollback: the global row holds the owner''s switch (%s)',
                   case when public._auto_backups_on() is not distinct from v_owner then 'PASS' else 'FAIL' end, v_owner);
  if current_setting('p4ab.flipped', true) = 'on' then
    r := r || format('%s rollback: the global row took the owner''s new switch, with a new updated_at',
                     case when (select (s.value->>'enabled')::boolean from public.app_secrets s where s.key = 'auto_backups') is not distinct from v_owner
                               and coalesce((select s.updated_at::text from public.app_secrets s where s.key = 'auto_backups'), 'none')
                                   is distinct from current_setting('p4ab.updated_before', true) then 'PASS' else 'FAIL' end);
  else
    r := r || format('%s rollback: the global row''s value and updated_at are unchanged',
                     case when coalesce((select md5(s.value::text || s.updated_at::text) from public.app_secrets s where s.key = 'auto_backups'), 'none')
                               = current_setting('p4ab.row_before', true) then 'PASS' else 'FAIL' end);
  end if;
  select count(*) filter (where username = 'user:__ab_rb_m' and all_tombstones),
         count(*) filter (where username = 'user:__ab_rb_m') - current_setting('p4ab.queued_m', true)::int,
         count(*) filter (where username = 'user:__ab_rb_n' and all_tombstones),
         count(*) filter (where username = 'user:__ab_rb_n' and not all_tombstones)
    into m_all, m_new, n_all, n_other
    from public.backup_scrub_queue where username in ('user:__ab_rb_m', 'user:__ab_rb_n');
  if not v_owner then
    r := r || format('%s rollback: M (own switch was on, the owner''s off) gets one all-tombstones scrub (%s new, %s all)',
                     case when m_all = 1 and m_new = 1 then 'PASS' else 'FAIL' end, m_new, m_all);
  else
    r := r || format('%s rollback: with the owner''s switch on, M gets no new scrub (%s new)',
                     case when m_new = 0 then 'PASS' else 'FAIL' end, m_new);
  end if;
  r := r || format('%s rollback: N (own switch off) keeps only the scrub its delete queued (%s all-tombstones, %s other)',
                   case when n_all = 0 and n_other = current_setting('p4ab.queued_n', true)::int and n_other = 1 then 'PASS' else 'FAIL' end,
                   n_all, n_other);
  perform public._drain_backup_scrubs('user:__ab_rb_m');
  r := r || format('%s rollback: after the drain M''s backup %s the generation M deleted',
                   case when exists (select 1 from public.data_backups b, jsonb_array_elements(b.tasks_snapshot) e
                                      where b.username = 'user:__ab_rb_m' and e->>'id' = 'abrb-m') = v_owner then 'PASS' else 'FAIL' end,
                   case when v_owner then 'still holds (owner on: copies kept)' else 'no longer holds' end);
  r := r || format('%s rollback: its migration record is gone (the fixture recorded it as apply-migration.mjs does)',
                   case when not exists (select 1 from supabase_migrations.schema_migrations where version = '20261025800000')
                        then 'PASS' else 'FAIL' end);
  r := r || format('%s rollback: the column and the one-account overload are gone',
                   case when not exists (select 1 from pg_attribute where attrelid = 'proxima_auth.users'::regclass
                                            and attname = 'auto_backups' and not attisdropped)
                             and to_regprocedure('public._auto_backups_on(text)') is null then 'PASS' else 'FAIL' end);
  raise exception 'RESULT: % PASS, % FAIL :: %', (select count(*) from unnest(r) x where x like 'PASS%'),
    (select count(*) from unnest(r) x where x like 'FAIL%'), array_to_string(r, ' | ');
end $t$;
