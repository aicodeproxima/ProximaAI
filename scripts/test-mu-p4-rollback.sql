-- Rollback proof for the P4 walls: supabase/migrations/20261025100000_mu_p4_storage_folders.sql (A),
-- 20261025200000_mu_p4_topic_per_account.sql (C), 20261025300000_mu_p4_tombstone_key.sql (D) and
-- 20261025400000_mu_p4_squat_proof_backups.sql (E), with their rollbacks RBa / RBc / RBd / RBe. This ONE file runs between the steps of ONE sql-tx call (everything rolled back); a temp table
-- carries the steps:
--   T=scripts/test-mu-p4-rollback.sql F=scripts/fixtures/p4s-final.sql (marks the last run, which reports)
--   unapplied: node scripts/tools/sql-tx.mjs $T $A $T $C $T $D $T $RBd $T $RBc $T $RBa $T $A $C $D $F --test $T
--   live:      node scripts/tools/sql-tx.mjs $T $RBd $T $RBc $T $RBa $T $A $T $C $T $D $F --test $T
--   E alone while A, C, D are live and E is not: node scripts/tools/sql-tx.mjs $T $E $T $RBe $T $E $F --test $T
-- Each step snapshots the storage policies, every proxima_auth function (md5 of its definition, ACL, config,
-- volatility, definer), the eight public functions the walls redefine the same way, sync_tombstones' constraints and
-- indexes, the proxima_auth tables with their ACLs and the triggers on proxima_auth.users. Every snapshot taken in the
-- same state (which walls are on) must be identical, and the owner's live topic must be one value throughout: the walls
-- never rotate it. Nothing secret is printed.
do $t$
declare
  v_snap text; v_state text; v_step int; v_out text; n int; v_topic text;
begin
  v_state := concat_ws('+', case when to_regclass('proxima_auth.account_folders') is not null then 'folders' end,
                            case when to_regprocedure('proxima_auth.account_topic(uuid)') is not null then 'topic' end,
                            case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                                        where c.conrelid = 'public.sync_tombstones'::regclass and c.contype = 'p')
                                      = 'PRIMARY KEY (device_id, id)' then 'tombkey' end,
                            case when pg_get_functiondef('public.restore_my_backup_phase2(text,uuid)'::regprocedure) ~ 'skipped_in_use'
                                 then 'squat' end);
  v_state := coalesce(nullif(v_state, ''), 'none');
  v_snap := concat_ws(E'\n',
    (select string_agg(concat_ws('|', policyname, permissive, roles::text, cmd, qual, with_check), E'\n' order by policyname)
       from pg_policies where schemaname = 'storage' and tablename = 'objects'),
    (select string_agg(concat_ws('|', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), p.proacl::text,
                                 p.proconfig::text, p.provolatile, p.prosecdef), E'\n' order by p.oid::regprocedure::text)
       from pg_proc p where p.pronamespace = 'proxima_auth'::regnamespace
         or p.oid in ('public.get_my_account(text)'::regprocedure, 'public.rename_my_account(text,text,text)'::regprocedure,
                      'public._clear_kind(text,text,timestamp with time zone,text[])'::regprocedure,
                      'public.delete_queued_rows(text,text,text[],bigint)'::regprocedure,
                      'public._history_strip_deleted_items()'::regprocedure, 'public.sync_tombstone_record()'::regprocedure,
                      'public._drain_backup_scrubs(text)'::regprocedure, 'public.restore_my_backup_phase2(text,uuid)'::regprocedure)),
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), E'\n' order by conname)
       from pg_constraint where conrelid = 'public.sync_tombstones'::regclass),
    (select string_agg(pg_get_indexdef(indexrelid), E'\n' order by indexrelid::regclass::text)
       from pg_index where indrelid = 'public.sync_tombstones'::regclass),
    (select string_agg(concat_ws('|', c.relname, c.relkind, c.relacl::text, c.relrowsecurity), E'\n' order by c.relname)
       from pg_class c where c.relnamespace = 'proxima_auth'::regnamespace),
    (select string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.tgname)
       from pg_trigger t where t.tgrelid = 'proxima_auth.users'::regclass and not t.tgisinternal));
  v_topic := proxima_auth.sync_topic();
  if to_regclass('pg_temp.p4_rb') is null then
    create temp table p4_rb (step int, state text, snap text, topic text) on commit drop;
    create temp table p4_acc (acc text) on commit drop;
    insert into p4_acc values ('');
  end if;
  select coalesce(max(x.step), -1) + 1 into v_step from p4_rb x;
  select a.acc into v_out from p4_acc a;
  if exists (select 1 from p4_rb x where x.state = v_state) then
    select count(*) into n from p4_rb x where x.state = v_state and x.snap <> v_snap;
    v_out := v_out || format('%s step%s (%s) catalog identical to the earlier same-state snapshot | ',
                             case when n = 0 then 'PASS' else 'FAIL' end, v_step, v_state);
  else
    v_out := v_out || format('PASS step%s (%s) first snapshot of this state | ', v_step, v_state);
  end if;
  select count(*) into n from p4_rb x where x.topic is distinct from v_topic;
  v_out := v_out || format('%s step%s owner topic unchanged | ', case when n = 0 then 'PASS' else 'FAIL' end, v_step);
  insert into p4_rb values (v_step, v_state, v_snap, v_topic);
  update p4_acc set acc = v_out;
  if current_setting('p4s.final', true) = 'on' then   -- set by scripts/fixtures/p4s-final.sql just before the last run
    raise exception 'RESULT: % PASS, % FAIL :: %',
      (select count(*) from unnest(string_to_array(v_out, ' | ')) x where x like 'PASS%'),
      (select count(*) from unnest(string_to_array(v_out, ' | ')) x where x like 'FAIL%'), rtrim(v_out, ' | ');
  end if;
end $t$;
