-- Tests for supabase/migrations/20261025900000_form_inputs_newest_wins.sql (review round 30 #1/#2): a form-inputs:% row
-- keeps the newest set its browser computed (value.at), whatever order the writes arrive in. Before it is applied:
--   node scripts/tools/sql-tx.mjs supabase/migrations/20261025900000_form_inputs_newest_wins.sql --test scripts/test-form-inputs-order-db.sql
-- One DO block, always rolled back. F1-F5 run as the table owner in fixture scope 'user:__fio_test'. F7 runs the app's
-- own write path: anon with a token minted for the owner, an upsert in the owner's scope, on keys '__fio_<txid>'.
do $t$
declare
  out text := '';
  u constant text := 'user:__fio_test';
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v jsonb; ok boolean; tk text; s text; k text := 'form-inputs:__fio_' || txid_current();
  put constant text := 'insert into public.settings (device_id, key, value) values ($1, $2, $3)
                        on conflict (device_id, key) do update set value = excluded.value';
begin
  -- F1. A newer set replaces an older one (the normal order).
  begin
    execute put using u, 'form-inputs:b1', jsonb_build_object('at', now_ms - 2000, 'paths', '["a"]'::jsonb);
    execute put using u, 'form-inputs:b1', jsonb_build_object('at', now_ms - 1000, 'paths', '["b"]'::jsonb);
    select value into v from settings where device_id = u and key = 'form-inputs:b1';
    out := out || case when v->'paths' = '["b"]' then 'ok F1 newer-replaces; ' else format('FAIL F1 %s; ', v) end;
  exception when others then out := out || format('FAIL F1 %s %s; ', sqlstate, sqlerrm); end;

  -- F2. An older set arriving after a newer one is refused with PT409 and the stored stamp as detail; the row keeps the
  --     newer set. Also for the :unsent row.
  declare st text; det text;
  begin
    st := 'none';
    begin execute put using u, 'form-inputs:b1', jsonb_build_object('at', now_ms - 1500, 'paths', '["stale"]'::jsonb);
    exception when others then get stacked diagnostics st = returned_sqlstate, det = pg_exception_detail; end;
    select value into v from settings where device_id = u and key = 'form-inputs:b1';
    ok := v->'paths' = '["b"]' and st = 'PT409' and det = (now_ms - 1000)::text;
    execute put using u, 'form-inputs:b1:unsent', jsonb_build_object('at', now_ms - 1000, 'ids', '["t2","t5"]'::jsonb);
    st := 'none';
    begin execute put using u, 'form-inputs:b1:unsent', jsonb_build_object('at', now_ms - 3000, 'ids', '["t2"]'::jsonb);
    exception when others then st := sqlstate; end;
    select value into v from settings where device_id = u and key = 'form-inputs:b1:unsent';
    ok := ok and v->'ids' = '["t2","t5"]' and st = 'PT409';
    out := out || case when ok then 'ok F2 older-refused-PT409; ' else format('FAIL F2 %s %s %s; ', v, st, det) end;
  exception when others then out := out || format('FAIL F2 %s %s; ', sqlstate, sqlerrm); end;

  -- F3. An equal `at` still writes (last arrival wins, as before); so does a value without a numeric `at`.
  begin
    execute put using u, 'form-inputs:b1', jsonb_build_object('at', now_ms - 1000, 'paths', '["c"]'::jsonb);
    select value into v from settings where device_id = u and key = 'form-inputs:b1';
    ok := v->'paths' = '["c"]';
    execute put using u, 'form-inputs:b1', jsonb_build_object('paths', '["no-at"]'::jsonb);
    select value into v from settings where device_id = u and key = 'form-inputs:b1';
    ok := ok and v->'paths' = '["no-at"]';
    execute put using u, 'form-inputs:b1', jsonb_build_object('at', 'soon', 'paths', '["text-at"]'::jsonb);
    select value into v from settings where device_id = u and key = 'form-inputs:b1';
    ok := ok and v->'paths' = '["text-at"]';
    out := out || case when ok then 'ok F3 equal-or-no-at-writes; ' else format('FAIL F3 %s; ', v) end;
  exception when others then out := out || format('FAIL F3 %s %s; ', sqlstate, sqlerrm); end;

  -- F4. A stored `at` far ahead of the server (the browser's clock was set back since): an older `at` still writes.
  begin
    execute put using u, 'form-inputs:b2', jsonb_build_object('at', now_ms + 3600000, 'paths', '["future"]'::jsonb);
    execute put using u, 'form-inputs:b2', jsonb_build_object('at', now_ms, 'paths', '["fixed"]'::jsonb);
    select value into v from settings where device_id = u and key = 'form-inputs:b2';
    out := out || case when v->'paths' = '["fixed"]' then 'ok F4 future-stored-yields; ' else format('FAIL F4 %s; ', v) end;
  exception when others then out := out || format('FAIL F4 %s %s; ', sqlstate, sqlerrm); end;

  -- F5. Other settings keys are unchanged: an older `at` overwrites as before.
  begin
    execute put using u, 'theme', jsonb_build_object('at', now_ms, 'v', 'dark');
    execute put using u, 'theme', jsonb_build_object('at', now_ms - 9999, 'v', 'light');
    select value into v from settings where device_id = u and key = 'theme';
    out := out || case when v->>'v' = 'light' then 'ok F5 other-keys-unchanged; ' else format('FAIL F5 %s; ', v) end;
  exception when others then out := out || format('FAIL F5 %s %s; ', sqlstate, sqlerrm); end;

  -- F7. The app's path: anon with the owner's minted token, upserts in the owner's scope; the older one is refused (PT409)
  --     and the newer stays.
  declare st text;
  begin
    execute 'select scope, proxima_auth.mint_token(id) from proxima_auth.users where role = ''owner''' into s, tk;
    execute 'set local role anon';
    perform set_config('request.headers', json_build_object('x-proxima-session', tk)::text, true);
    execute put using s, k, jsonb_build_object('at', now_ms, 'paths', '["new"]'::jsonb);
    st := 'none';
    begin execute put using s, k, jsonb_build_object('at', now_ms - 5000, 'paths', '["old"]'::jsonb);
    exception when others then st := sqlstate; end;
    execute 'reset role';
    select value into v from settings where device_id = s and key = k;
    out := out || case when v->'paths' = '["new"]' and st = 'PT409' then 'ok F7 app-path; ' else format('FAIL F7 %s %s; ', v, st) end;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    out := out || format('FAIL F7 %s %s; ', sqlstate, sqlerrm);
  end;

  raise exception 'RESULT: %', out;
end $t$;
