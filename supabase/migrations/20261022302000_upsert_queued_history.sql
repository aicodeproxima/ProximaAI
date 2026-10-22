-- Review round 9 (2026-10-22): after round 8 the server strips a deleted generation's History items itself, except items
-- without an id (entries from before 2026-10-20). Those entries are still trimmed by the deleting device and uploaded,
-- and that upload was a plain upsert sent after the restore-checked row delete and the WaveSpeed flush: a restore landing
-- in between had its entry overwritten by the trimmed pre-restore copy (and, with backups OFF, scrubbed from backups).
-- upsert_queued_history sends such rewrites under the same rules as a queued delete: the account's restore marker is
-- taken first (FOR SHARE), the session checked again, and a rewrite queued before the last restore is voided. Entries
-- go into this account only; another account's entry with the same id is left alone. At most 100 per call.
-- Test: test-queued-deletes-db.sql case rewrite-queued.
create or replace function public.upsert_queued_history(p_session_token text, p_entries jsonb, p_queued_at bigint)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
  v_restore bigint;
  v_n       int := 0;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'upsert_queued_history: entries must be an array';
  end if;
  if jsonb_array_length(p_entries) = 0 then
    return json_build_object('ok', true, 'voided', false, 'upserted', 0);
  end if;
  if jsonb_array_length(p_entries) > 100 then
    raise exception 'upsert_queued_history: at most 100 entries, got %', jsonb_array_length(p_entries);
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'upserted', 0);
  end if;
  insert into history (id, device_id, timestamp, prompt, neg_prompt, gen_type, models, resolution, duration, seed,
                       aspect_ratio, source_image_url, source_image_urls, num_images, tasks, total_cost)
  select r.id, v_user, r.timestamp, r.prompt, r.neg_prompt, r.gen_type, coalesce(r.models, '[]'), r.resolution, r.duration,
         r.seed, r.aspect_ratio, r.source_image_url, coalesce(r.source_image_urls, '[]'), coalesce(r.num_images, 1),
         coalesce(r.tasks, '[]'), coalesce(r.total_cost, 0)
    from jsonb_populate_recordset(null::public.history, p_entries) r
   where coalesce(r.id, '') <> ''
  on conflict (id) do update set
    timestamp = excluded.timestamp, prompt = excluded.prompt, neg_prompt = excluded.neg_prompt, gen_type = excluded.gen_type,
    models = excluded.models, resolution = excluded.resolution, duration = excluded.duration, seed = excluded.seed,
    aspect_ratio = excluded.aspect_ratio, source_image_url = excluded.source_image_url,
    source_image_urls = excluded.source_image_urls, num_images = excluded.num_images, tasks = excluded.tasks,
    total_cost = excluded.total_cost
   where history.device_id = v_user;
  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'voided', false, 'upserted', v_n);
end $$;
revoke execute on function public.upsert_queued_history(text, jsonb, bigint) from public;
grant execute on function public.upsert_queued_history(text, jsonb, bigint) to anon, authenticated, service_role;
notify pgrst, 'reload schema';
