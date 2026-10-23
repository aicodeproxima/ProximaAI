-- The account and backup RPCs, called the way the signed-in app calls them under RLS phase 2 (role anon, session header
-- present, token as p_session_token). Everything rolls back, including the snapshot and the restore. Run alone (live).
do $pt$
declare
  u text;   -- the owner's name, set first thing below
  s text; tok text; r json; n_before int; h_before int; n_after int; h_after int; bid uuid; rr text[] := '{}';
begin
  -- The owner: proxima_auth.users from P1's M1 on, app_secrets before it (this suite runs in both states).
  if to_regclass('proxima_auth.users') is not null then
    execute 'select username from proxima_auth.users where role = ''owner''' into u;
  else
    u := (select value->>'username' from public.app_secrets where key = 'admin_username');
  end if;
  s := 'user:' || u;
  tok := public._sign_session_token('admin:' || u, now() + interval '12 hours');
  select count(*) into n_before from public.tasks where device_id = s;
  select count(*) into h_before from public.history where device_id = s;
  execute 'set local role anon';
  perform set_config('request.headers', json_build_object('x-proxima-session', tok)::text, true);
  r := public.get_my_account(tok);
  rr := rr || format('%s get_my_account ok, topic present', case when (r->>'ok')::boolean and r->>'sync_topic' like 'proxima-sync-%' then 'PASS' else 'FAIL' end);
  r := public.snapshot_my_data_phase2(tok, 'manual', 'rls-phase2 test');
  bid := (r->>'id')::uuid;
  rr := rr || format('%s manual snapshot (%s)', case when (r->>'ok')::boolean and bid is not null then 'PASS' else 'FAIL' end, left(r::text, 80));
  rr := rr || format('%s list shows it', case when exists (select 1 from public.list_my_backups_phase2(tok, 5) l where l.id = bid) then 'PASS' else 'FAIL' end);
  r := public.restore_my_backup_phase2(tok, bid);
  rr := rr || format('%s restore (%s)', case when (r->>'ok')::boolean then 'PASS' else 'FAIL' end, left(r::text, 120));
  execute 'reset role';
  select count(*) into n_after from public.tasks where device_id = s;
  select count(*) into h_after from public.history where device_id = s;
  rr := rr || format('%s restore kept the same rows (tasks %s->%s, history %s->%s)',
    case when n_after = n_before and h_after = h_before then 'PASS' else 'FAIL' end, n_before, n_after, h_before, h_after);
  execute 'set local role anon';
  r := public.delete_my_backup_phase2(tok, bid);
  rr := rr || format('%s delete the snapshot', case when (r->>'ok')::boolean then 'PASS' else 'FAIL' end);
  -- RPCs need the token argument, not the header: a call without the header still works (sign-in, unlock run before one exists)
  perform set_config('request.headers', '{}', true);
  r := public.get_my_account(tok);
  rr := rr || format('%s RPC without header still answers', case when (r->>'ok')::boolean then 'PASS' else 'FAIL' end);
  execute 'reset role';
  raise exception 'RESULT: % PASS, % FAIL :: %',
    (select count(*) from unnest(rr) x where x like 'PASS%'), (select count(*) from unnest(rr) x where x like 'FAIL%'),
    array_to_string(rr, ' | ');
end $pt$;
