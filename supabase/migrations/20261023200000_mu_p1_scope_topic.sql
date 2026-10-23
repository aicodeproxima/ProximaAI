-- Multi-user P1, migration M2 (RLS session; docs/P1-AUTH-DESIGN.md §3, §4 rows session_scope and sync_topic, §7).
-- Lands after M1 (20261023100000_mu_p1_accounts) and before M3 (which mints 'u:' tokens for the owner too).
-- 1. proxima_auth.session_scope takes the account from proxima_auth.current_account, so both token formats work:
--    'u:<uuid>', and 'admin:<owner name>' until M4. It returns the account's own scope (proxima_auth.users.scope),
--    which for the owner is the same 'user:<name>' as before. The 28000 wrapper and every message stay; 'not
--    admin-scoped' stays only as a guard, since from M1 the verifier raises 'malformed session token' for any other
--    subject. M4 needs no change here: current_account drops its admin: branch.
-- 2. proxima_auth.sync_topic reads the owner row instead of the app_secrets rows M1 froze. It hashes the owner's name
--    and sessions_valid_after + 1. While the owner row has not moved since M1 that is the same text as before (M1
--    seeds the epoch as app_secrets' at - 1), so the topic the devices hold does not change. A password change,
--    backup-code unlock or rename in the M1-only window moves only the owner row (M1's guard freezes the app_secrets
--    rows); the topic then rotates once at this apply, and every device picks it up on its next reconcile
--    (checkSession reads get_my_account at most 20 s apart while the app is visible, and on focus). That is never a
--    reason to refuse: anyone who knows the name can force an unlock (review round 18 #1). From here the topic rotates
--    on a password change, a backup-code unlock and a rename (the owner row's epoch and name), and on a signing-key
--    rotation as before. One topic, the owner's, until P4.
-- Both keep their owner, grants, STABLE, SECURITY DEFINER and search_path ''.
-- Rollback: supabase/rollback/20261023200000_mu_p1_scope_topic.rollback.sql (refuses while M3 is live).
-- Gate: node scripts/tools/sql-tx.mjs <M1> <this file> --test scripts/test-mu-scope-topic.sql (all PASS); with M1
-- alone the same suite fails the 'u:' cases and the owner-row topic cases.

-- ── 0. Preconditions: M1 is live and both bodies are the reviewed ones. Whether the topic rotates is reported, never a
--      reason to refuse (review round 18 #1).
do $pre$
declare
  v_expect constant jsonb := '{
    "proxima_auth.session_scope(boolean)": "2ec561e92dcbe45ff5171d3576765a9e",
    "proxima_auth.sync_topic()": "04def7fb9d177998a6c568319f149052"
  }';
  v_bad text; v_frozen text; v_owner text;
begin
  if to_regclass('proxima_auth.users') is null or to_regprocedure('proxima_auth.current_account(text)') is null then
    raise exception 'M2: M1 is not applied (proxima_auth.users or current_account is missing)';
  end if;
  select string_agg(e.k, ', ' order by e.k) into v_bad from jsonb_each_text(v_expect) e(k, m)
   where to_regprocedure(e.k) is null or md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m;
  if v_bad is not null then
    raise exception 'M2 compare-and-swap: live body differs from the reviewed capture: %', v_bad;
  end if;
  -- The text the topic hashes, from the frozen rows (today's body) and from the owner row (the new body). Compared,
  -- never printed.
  v_frozen := 'sync-ping:'
    || coalesce((select value->>'username' from public.app_secrets where key = 'admin_username'), '')
    || ':' || coalesce((select value->>'at' from public.app_secrets where key = 'admin_sessions_valid_after'), '0');
  select 'sync-ping:' || u.username || ':' || (u.sessions_valid_after + 1)::text into v_owner
    from proxima_auth.users u where u.role = 'owner';
  if v_owner is distinct from v_frozen then
    raise notice 'M2: the owner row moved since M1 (a rename, password change or unlock), so the topic rotates once now; devices pick it up on their next reconcile';
  end if;
end $pre$;

-- ── 1. session_scope: both token formats, the account's own scope ──
create or replace function proxima_auth.session_scope(p_required boolean default false)
 returns text
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_raw text := nullif(current_setting('request.headers', true), '');   -- '' after a RESET on a pooled connection
  v_tok text;
  v_acc proxima_auth.account;
begin
  if v_raw is not null then
    begin
      v_tok := nullif(btrim((v_raw::jsonb) ->> 'x-proxima-session'), '');
    exception when others then
      v_tok := null;                                      -- unparsable request.headers = no header
    end;
  end if;
  if v_tok is null then
    if p_required then
      raise exception using errcode = '28000', message = 'session token missing',
        hint = 'send the x-proxima-session header';
    end if;
    return null;                                          -- realtime / cron / headerless reads: no rows, no error
  end if;
  begin
    v_acc := proxima_auth.current_account(v_tok);         -- exp, HMAC (current|previous key), live account, epoch
  exception when others then
    raise exception using errcode = '28000', message = sqlerrm;
  end;
  if v_acc.scope is null then
    raise exception using errcode = '28000', message = 'not admin-scoped';   -- unreachable: the verifier raises first
  end if;
  return v_acc.scope;
end $function$;

-- ── 2. sync_topic: the owner row's name and epoch + 1 instead of the frozen app_secrets rows (same text) ──
create or replace function proxima_auth.sync_topic()
 returns text
 language sql
 stable security definer
 set search_path to ''
as $function$
  select 'proxima-sync-' || encode(extensions.hmac(
           'sync-ping:' || u.username || ':' || (u.sessions_valid_after + 1)::text,
           (select value->>'key' from public.app_secrets where key = 'session_signing_key'),
           'sha256'), 'hex')
    from proxima_auth.users u
   where u.role = 'owner'
$function$;

-- ── 3. Post-check, same transaction: the owner's 'admin:' and 'u:' tokens both give the owner's scope, sync_topic is
--      the owner row's topic, and the grants are unchanged. Nothing here can refuse over a topic rotation (review round
--      18 #1); that the topic equals the frozen rows' topic while the owner row has not moved is proved before the
--      apply by the gate (test-mu-scope-topic.sql, case T2). The tokens live in variables only, never printed.
do $post$
declare
  v_id uuid; v_name text; v_scope text; v_ep bigint; v_exp timestamptz; v_key text;
begin
  select u.id, u.username, u.scope, u.sessions_valid_after into v_id, v_name, v_scope, v_ep
    from proxima_auth.users u where u.role = 'owner';
  v_exp := to_timestamp(greatest(extract(epoch from clock_timestamp())::bigint, v_ep + 1) + 43200);
  perform set_config('request.headers', json_build_object('x-proxima-session', public._sign_session_token('admin:' || v_name, v_exp))::text, true);
  if proxima_auth.session_scope(true) is distinct from v_scope then
    raise exception 'M2 post-check: the owner''s admin: token does not give the owner''s scope';
  end if;
  perform set_config('request.headers', json_build_object('x-proxima-session', public._sign_session_token('u:' || v_id::text, v_exp))::text, true);
  if proxima_auth.session_scope(true) is distinct from v_scope then
    raise exception 'M2 post-check: the owner''s u: token does not give the owner''s scope';
  end if;
  perform set_config('request.headers', '', true);
  v_key := (select value->>'key' from public.app_secrets where key = 'session_signing_key');
  if proxima_auth.sync_topic() is distinct from
     'proxima-sync-' || encode(extensions.hmac('sync-ping:' || v_name || ':' || (v_ep + 1)::text, v_key, 'sha256'), 'hex') then
    raise exception 'M2 post-check: sync_topic is not the owner row''s topic';
  end if;
  if (select p.proacl::text from pg_proc p where p.oid = 'proxima_auth.session_scope(boolean)'::regprocedure)
       is distinct from '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres}'
     or (select p.proacl::text from pg_proc p where p.oid = 'proxima_auth.sync_topic()'::regprocedure)
       is distinct from '{postgres=X/postgres}' then
    raise exception 'M2 post-check: grants changed';
  end if;
end $post$;
