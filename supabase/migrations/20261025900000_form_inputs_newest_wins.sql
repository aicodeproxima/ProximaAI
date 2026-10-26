-- A browser's form holds keep the newest set it computed, whatever order its writes arrive in (review round 30 #1/#2).
--
-- Each browser publishes settings rows form-inputs:<browser> (the Generate form's input files) and
-- form-inputs:<browser>:unsent (uploads still queued here). Other devices read them before deleting files or WaveSpeed
-- results, so they must name what this browser holds now. Both values carry `at`, the browser's clock when the set was
-- computed. Until now the last write to ARRIVE won. Two tabs of one browser, the page-exit write, or a write answered
-- only after a phone thaws could land after a newer one and erase it. Round 29 serialized the writes within one tab
-- instead, and round 30 found that a frozen page then publishes nothing until it thaws (#1: a live generation's input
-- file deleted; simulator I6-end), and that other tabs are not ordered at all (#2).
--
-- Now an update of a form-inputs:% row whose incoming `at` is older than the stored one is refused (the row keeps the newer
-- set) with SQLSTATE PT409 (HTTP 409 through PostgREST) and the stored stamp as its detail: the writer learns its write did
-- not land, moves its stamp above the stored one and sends again (B17 review #1/#5: a silently skipped write counted as
-- published, so a History upload went out while the cloud row lacked its generation). The app stamps `at` monotonic per
-- browser on the server-aligned clock (storage.js formStamp), so this happens only after a device clock step. Not refused:
-- a value without a numeric `at` (nothing to compare), an equal `at` (last arrival wins, as before), and a stored `at`
-- more than 5 minutes ahead of the server's clock (a browser whose clock was set back must still be able to publish).
-- Other settings keys are unchanged. The trigger runs only on rows the caller may update (row policies decide that first).
--
-- Rollback: supabase/rollback/20261025900000_form_inputs_newest_wins.rollback.sql
-- Tests (rolled back): node scripts/tools/sql-tx.mjs supabase/migrations/20261025900000_form_inputs_newest_wins.sql --test scripts/test-form-inputs-order-db.sql

create function public._settings_form_inputs_newest()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_old numeric;
  v_new numeric;
begin
  if new.key not like 'form-inputs:%' or old.key is distinct from new.key then
    return new;
  end if;
  v_old := case when jsonb_typeof(old.value->'at') = 'number' then (old.value->>'at')::numeric end;
  v_new := case when jsonb_typeof(new.value->'at') = 'number' then (new.value->>'at')::numeric end;
  if v_old is not null and v_new is not null and v_new < v_old
     and v_old <= extract(epoch from clock_timestamp()) * 1000 + 300000 then
    raise exception using errcode = 'PT409', message = 'stale form publication', detail = v_old::text,
      hint = 'the stored form publication is newer; send again with a later stamp';
  end if;
  return new;
end $function$;

revoke execute on function public._settings_form_inputs_newest() from public, anon, authenticated;

create trigger settings_form_inputs_newest before update on public.settings
  for each row execute function public._settings_form_inputs_newest();
