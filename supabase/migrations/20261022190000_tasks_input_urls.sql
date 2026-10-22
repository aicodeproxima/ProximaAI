-- Review round 2 (critics wf_31b1b0e0-bbb, 2026-10-22): a generation's end frame, audio, driving video and reference
-- video uploads were never stored in its cloud row, so the other device could not delete them with the generation
-- ("delete means delete") and paths_in_use could not see that a row still used them. The four URLs now travel with
-- the row (supabase.js taskToRow / rowToTask) and paths_in_use reads them. Rows saved before stay null.
alter table public.tasks
  add column if not exists end_frame_url    text,
  add column if not exists source_audio_url text,
  add column if not exists source_video_url text,
  add column if not exists ref_video_url    text;

-- As 20261022140000, with the four input URLs of tasks rows.
create or replace function public.paths_in_use(p_session_token text, p_paths text[]) returns text[]
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if p_paths is null or cardinality(p_paths) = 0 then
    return '{}';
  end if;
  if cardinality(p_paths) > 200 then
    raise exception 'paths_in_use: at most 200 paths, got %', cardinality(p_paths);
  end if;
  return coalesce(array(
    select p from unnest(p_paths) p
     where coalesce(p, '') <> ''
       and (exists (select 1 from tasks t
                     where t.device_id = v_user
                       and (position(p in concat_ws(' ', t.source_image_url, t.source_image_urls::text, t.outputs::text,
                                                    t.end_frame_url, t.source_audio_url, t.source_video_url, t.ref_video_url)) > 0
                            or position(replace(p, ' ', '%20') in concat_ws(' ', t.source_image_url, t.source_image_urls::text, t.outputs::text,
                                                    t.end_frame_url, t.source_audio_url, t.source_video_url, t.ref_video_url)) > 0))
            or exists (select 1 from history h
                        where h.device_id = v_user
                          and (position(p in concat_ws(' ', h.source_image_url, h.source_image_urls::text, h.tasks::text)) > 0
                               or position(replace(p, ' ', '%20') in concat_ws(' ', h.source_image_url, h.source_image_urls::text, h.tasks::text)) > 0)))
  ), '{}');
end $$;
revoke execute on function public.paths_in_use(text, text[]) from public;
grant execute on function public.paths_in_use(text, text[]) to anon, authenticated;
