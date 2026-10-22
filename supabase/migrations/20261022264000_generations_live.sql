-- Review round 6 (2026-10-22): the WaveSpeed delete queue held a prediction only while a tasks row held its id
-- (predictionsInUseRemote). A generation a restore brought back History-only (a backup keeps 500 tasks rows but up to
-- 1000 entries) is live by the liveness rule (20261022240000), but History items carry no prediction id, so its WaveSpeed
-- copy, and the media its restored History item points at, was deleted. generations_live answers which of these
-- generation ids are live: a tasks row of the account, or an item of a live History entry with no user tombstone. The
-- client's queue entries now keep their generation's id and hold those. Tests: test-queued-deletes-db.sql case
-- generations-live.
create or replace function public.generations_live(p_session_token text, p_ids text[]) returns text[]
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare
  v_subject text := public._verify_session_token(p_session_token);
  v_user    text;
begin
  if v_subject not like 'admin:%' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_user := 'user:' || substring(v_subject from 7);
  if p_ids is null or cardinality(p_ids) = 0 then
    return '{}';
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'generations_live: at most 200 ids, got %', cardinality(p_ids);
  end if;
  return coalesce(array(
    select x from unnest(p_ids) x
     where coalesce(x, '') <> ''
       and (exists (select 1 from tasks t where t.device_id = v_user and t.id = x)
            or (x in (select e.item->>'id' from history h,
                        jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                       where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')
                and not exists (select 1 from sync_tombstones st where st.device_id = v_user and st.kind = 'task'
                                   and st.id = x and not coalesce(st.by_restore, false))))
  ), '{}');
end $$;
revoke execute on function public.generations_live(text, text[]) from public;
grant execute on function public.generations_live(text, text[]) to anon, authenticated, service_role;
