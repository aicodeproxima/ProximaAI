-- "Delete means delete", without deleting what is kept (review wf_ec400a67-988 #7, 2026-10-22). The file-delete queue
-- (src/lib/fileDelete.js) decided "still used" from this device's loaded rows only (at most 500, never the other
-- device's pending ones), so it could delete an upload or archive an older or remote generation still used. Before
-- deleting, the client now asks which of up to 200 bucket paths any tasks or History row of the signed-in account
-- still references: inputs, outputs, History items. Matched with position() (a path is a substring of its public
-- URL; LIKE would treat the "_" in user_<name> as a wildcard), also in its %20-encoded form. Over-matching only keeps
-- a file; it never deletes one.
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
                       and (position(p in concat_ws(' ', t.source_image_url, t.source_image_urls::text, t.outputs::text)) > 0
                            or position(replace(p, ' ', '%20') in concat_ws(' ', t.source_image_url, t.source_image_urls::text, t.outputs::text)) > 0))
            or exists (select 1 from history h
                        where h.device_id = v_user
                          and (position(p in concat_ws(' ', h.source_image_url, h.source_image_urls::text, h.tasks::text)) > 0
                               or position(replace(p, ' ', '%20') in concat_ws(' ', h.source_image_url, h.source_image_urls::text, h.tasks::text)) > 0)))
  ), '{}');
end $$;
revoke execute on function public.paths_in_use(text, text[]) from public;
grant execute on function public.paths_in_use(text, text[]) to anon, authenticated;
