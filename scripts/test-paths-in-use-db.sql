-- Tests for supabase/migrations/20261022140000_paths_in_use.sql: which bucket paths a tasks or History row of the
-- signed-in account still references (review wf_ec400a67-988 #7). Same harness as test-backup-scrub-db.sql: one DO
-- block that always ends in an exception, so everything rolls back (the admin_username swap included). Run before the
-- migration exists as "begin;" + migration + this file; afterwards this file alone. Fixtures only: account
-- '__paths_test' (scope 'user:__paths_test'), ids 'pu-'. Each case catches its own errors.
do $t$
declare
  out text := '';
  u constant text := 'user:__paths_test';
  base constant text := 'https://x.supabase.co/storage/v1/object/public/generations/';
  v_tok text; r text[];
begin
  if to_regclass('proxima_auth.users') is null then   -- from P1's M1 the app_secrets admin rows are frozen; the owner row is the account
    update app_secrets set value = jsonb_set(value, '{username}', '"__paths_test"') where key = 'admin_username';
    v_tok := _sign_session_token('admin:__paths_test', now() + interval '12 hours 5 minutes');
  else
    execute 'update proxima_auth.users set username = $1, scope = ''user:'' || $1 where role = ''owner''' using '__paths_test';
    -- From M1 the owner's token comes from the account, after the rename above (M3 mints 'u:<id>'; M4 revokes every
    -- 'admin:' token, so a hand-signed 'admin:' one would fail every case: review m4crit #3).
    execute 'select proxima_auth.mint_token((select id from proxima_auth.users where role = ''owner''))' into v_tok;
  end if;
  insert into tasks (id, device_id, status, start_time, source_image_url, outputs) values
    ('pu-t1', u, 'completed', 1000, base || 'uploads/user___paths_test/s1.png', jsonb_build_array(base || 'user___paths_test/o1.png')),
    ('pu-o1', 'user:__other', 'completed', 1000, base || 'uploads/user___paths_test/gone.png', '[]');
  insert into history (id, device_id, timestamp, tasks, total_cost) values
    ('pu-L1', u, 1000, jsonb_build_array(jsonb_build_object('id', 'pu-x', 'status', 'completed', 'outputs', jsonb_build_array(base || 'user___paths_test/h%201.png'))), 0);

  -- 1. As the app calls it (anon + session token): inputs, outputs and History items count; others' rows do not.
  begin
    set local role anon;
    r := paths_in_use(v_tok, array['uploads/user___paths_test/s1.png', 'user___paths_test/o1.png',
                                   'user___paths_test/h 1.png', 'uploads/user___paths_test/gone.png', '']);
    reset role;
    out := out || case when r = array['uploads/user___paths_test/s1.png', 'user___paths_test/o1.png', 'user___paths_test/h 1.png']
      then 'ok in-use; ' else format('FAIL in-use %s; ', r) end;
  exception when others then out := out || format('FAIL in-use %s; ', sqlstate); end;

  -- 2. "_" is not a wildcard: a path differing only where the name has "_" is not in use.
  begin
    r := paths_in_use(v_tok, array['uploads/userX__paths_test/s1.png']);
    out := out || case when r = '{}' then 'ok no-wildcard; ' else format('FAIL no-wildcard %s; ', r) end;
  exception when others then out := out || format('FAIL no-wildcard %s; ', sqlstate); end;

  -- 3. Only admin sessions may ask.
  begin
    perform paths_in_use(_sign_session_token(u, now() + interval '5 minutes'), array['x']);
    out := out || 'FAIL non-admin; ';
  exception when insufficient_privilege then out := out || 'ok non-admin; ';   -- before P1's M1 (42501)
            when raise_exception then                 -- from M1 the verifier fails closed on a non-account subject
              out := out || case when sqlerrm = 'malformed session token' then 'ok non-admin; ' else format('FAIL non-admin %s; ', sqlstate) end;
            when others then out := out || format('FAIL non-admin %s; ', sqlstate); end;

  -- 4. Empty asks answer empty; more than 200 paths are refused.
  begin
    r := paths_in_use(v_tok, '{}');
    if r <> '{}' then out := out || 'FAIL limits empty; ';
    else
      begin
        perform paths_in_use(v_tok, array(select 'p' || g from generate_series(1, 201) g));
        out := out || 'FAIL limits 201; ';
      exception when raise_exception then out := out || 'ok limits; '; end;
    end if;
  exception when others then out := out || format('FAIL limits %s; ', sqlstate); end;

  -- 5. Review round 2: end frame, audio, driving video and reference video uploads travel with the row and count too.
  begin
    execute $q$insert into tasks (id, device_id, status, start_time, outputs, end_frame_url, source_audio_url, source_video_url, ref_video_url)
      values ('pu-t2', 'user:__paths_test', 'completed', 1000, '[]',
              'https://x.supabase.co/storage/v1/object/public/generations/uploads/user___paths_test/end.png',
              'https://x.supabase.co/storage/v1/object/public/generations/uploads/user___paths_test/voice.mp3',
              'https://x.supabase.co/storage/v1/object/public/generations/uploads/user___paths_test/drive.mp4',
              'https://x.supabase.co/storage/v1/object/public/generations/uploads/user___paths_test/ref.mp4')$q$;
    r := paths_in_use(v_tok, array['uploads/user___paths_test/end.png', 'uploads/user___paths_test/voice.mp3',
                                   'uploads/user___paths_test/drive.mp4', 'uploads/user___paths_test/ref.mp4']);
    out := out || case when cardinality(r) = 4 then 'ok input-urls; ' else format('FAIL input-urls %s; ', r) end;
  exception when others then out := out || format('FAIL input-urls %s; ', sqlstate); end;

  -- 6. The browser's own path: as anon with the session header, an upload carrying the four columns inserts, an
  --    upsert of the same id changes them, and the row reads back with them (row policies and grants allow them).
  begin
    set local role anon;
    perform set_config('request.headers', json_build_object('x-proxima-session', v_tok)::text, true);
    insert into tasks (id, device_id, status, start_time, outputs, end_frame_url, source_audio_url)
      values ('pu-a1', u, 'completed', 1000, '[]', 'e1', 'a1');
    insert into tasks (id, device_id, status, start_time, outputs, end_frame_url, source_audio_url, source_video_url, ref_video_url)
      values ('pu-a1', u, 'completed', 1000, '[]', 'e2', 'a2', 'v2', 'r2')
      on conflict (device_id, id) do update set end_frame_url = excluded.end_frame_url, source_audio_url = excluded.source_audio_url,
        source_video_url = excluded.source_video_url, ref_video_url = excluded.ref_video_url;
    out := out || case when (select array[end_frame_url, source_audio_url, source_video_url, ref_video_url] from tasks where id = 'pu-a1')
                            = array['e2', 'a2', 'v2', 'r2'] then 'ok anon-upsert; ' else 'FAIL anon-upsert values; ' end;
    reset role;
  exception when others then reset role; out := out || format('FAIL anon-upsert %s %s; ', sqlstate, sqlerrm); end;

  raise exception 'RESULT: %', out;
end $t$;
