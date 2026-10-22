-- Tests for supabase/migrations/20261022160000_restore_scrubs_replaced.sql: a restore made while Automatic backups is
-- OFF removes what it replaced from every other backup at once (owner ruling on review wf_ec400a67-988 #11). Same
-- harness as test-backup-scrub-db.sql (one DO block, always rolled back). Run as "begin;" + the migration + this file
-- before it is applied; afterwards this file alone. Fixtures only: 'user:__rs_test', ids 'rs-'.
do $t$
declare
  out text := '';
  u constant text := 'user:__rs_test';
  v_tok text; v_m1 uuid; v_m2 uuid; r json;
  holds_g boolean; holds_hg boolean; holds_a boolean;
begin
  v_tok := _sign_session_token(u, now() + interval '5 minutes');

  -- 1. Switch OFF: restoring M1 scrubs the replaced generation G (and its History entry) from M2 right away.
  begin
    insert into app_secrets (key, value) values ('auto_backups', '{"enabled": false}') on conflict (key) do update set value = excluded.value;
    insert into tasks (id, device_id, status, start_time, outputs) values ('rs-A', u, 'completed', 1000, '[]');
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
      values (u, 'manual', 1, 0, (select jsonb_agg(row_to_json(t)) from tasks t where t.device_id = u), '[]') returning id into v_m1;
    insert into tasks (id, device_id, status, start_time, outputs) values ('rs-G', u, 'completed', 2000, '[]');
    insert into history (id, device_id, timestamp, tasks, total_cost) values ('rs-HG', u, 2000, '[{"id":"rs-G","status":"completed","cost":1}]', 1);
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
      values (u, 'manual', 2, 1, (select jsonb_agg(row_to_json(t)) from tasks t where t.device_id = u),
              (select jsonb_agg(row_to_json(h)) from history h where h.device_id = u)) returning id into v_m2;
    r := restore_my_backup_phase2(v_tok, v_m1);
    select exists (select 1 from data_backups b, jsonb_array_elements(b.tasks_snapshot) e where b.id = v_m2 and e->>'id' = 'rs-G'),
           exists (select 1 from data_backups b, jsonb_array_elements(b.history_snapshot) e where b.id = v_m2 and e->>'id' = 'rs-HG'),
           exists (select 1 from data_backups b, jsonb_array_elements(b.tasks_snapshot) e where b.id = v_m1 and e->>'id' = 'rs-A')
      into holds_g, holds_hg, holds_a;
    out := out || case when r->>'ok' = 'true' and not holds_g and not holds_hg and holds_a
      and not exists (select 1 from backup_scrub_queue where username = u)
      then 'ok off-scrubs; ' else format('FAIL off-scrubs ok=%s G=%s HG=%s A=%s; ', r->>'ok', holds_g, holds_hg, holds_a) end;
  exception when others then out := out || format('FAIL off-scrubs %s; ', sqlstate); end;

  -- 2. Switch ON: a restore scrubs nothing (the safety copies are the point), regression guard.
  begin
    delete from data_backups where username = u;
    delete from tasks where device_id = u;
    delete from history where device_id = u;
    delete from sync_tombstones where device_id = u;
    update app_secrets set value = '{"enabled": true}' where key = 'auto_backups';
    insert into tasks (id, device_id, status, start_time, outputs) values ('rs-A2', u, 'completed', 1000, '[]');
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
      values (u, 'manual', 1, 0, (select jsonb_agg(row_to_json(t)) from tasks t where t.device_id = u), '[]') returning id into v_m1;
    insert into tasks (id, device_id, status, start_time, outputs) values ('rs-G2', u, 'completed', 2000, '[]');
    insert into data_backups (username, backup_type, task_count, history_count, tasks_snapshot, history_snapshot)
      values (u, 'manual', 2, 0, (select jsonb_agg(row_to_json(t)) from tasks t where t.device_id = u), '[]') returning id into v_m2;
    r := restore_my_backup_phase2(v_tok, v_m1);
    out := out || case when r->>'ok' = 'true'
      and exists (select 1 from data_backups b, jsonb_array_elements(b.tasks_snapshot) e where b.id = v_m2 and e->>'id' = 'rs-G2')
      then 'ok on-keeps; ' else format('FAIL on-keeps %s; ', r) end;
  exception when others then out := out || format('FAIL on-keeps %s; ', sqlstate); end;

  raise exception 'RESULT: %', out;
end $t$;
