-- Sign-in history (owner 2026-10-27: "I will be able to see sign-in history for all accounts. And no one else can
-- see them." Members see none, not even their own). Every sign-in, backup-code unlock, join and password re-entry
-- (proxima_auth._reauth: change password, rename, invite, backup code) leaves an event in proxima_auth.signin_events: the
-- account (null for a name no account has, or a request that names none), when (first and latest), how many times, the
-- kind (signin / unlock / join / reauth), the outcome (ok, wrong_password, locked_now, locked, unknown, disabled,
-- no_password, update_required, wrong_code, paused_now, paused, no_backup_code, ok_password_reset, weak_password, a join's
-- refusal reason incl. invite_voided and invite_creator_gone, ...), whether the caller's network was throttled, the
-- browser string (at most 300 characters), the app's x-client-info marker and an 8-character code of the network (the
-- same keyed hash the sign-in throttle uses: the address itself is never stored). The name typed at a failed attempt is
-- never stored (it may be a password typed in the wrong box).
-- Read only through public.list_signins(session token, limit, before id, account), which answers 'forbidden' to anyone
-- but the owner: pages of events newest first, filtered by account or 'none', plus each account's last successful
-- sign-in (a flood cannot push it out of view: past the hourly limit it is the counted row's latest time, flagged). The
-- table is closed to every browser role (RLS on, no grants); the writer _log_signin is callable by no role. A log row
-- never decides an answer: _log_signin swallows its own errors and never waits on a row another call holds (skip locked).
-- Floods (reviews wf_22e47bf1-fa6, wf_d4f75a17-159 and wf_79964fbc-e0a, 2026-10-27): ANY outcome repeated by the same
-- account, kind, outcome and throttle state from the same network within 10 minutes of the row's START adds to that row
-- (repeats + 1, last_at); a refusal decided by the request's shape alone (join: closed, invalid_username, weak_password;
-- unlock: weak_password, and the legacy unlock's update_required, which names no account) adds to one row an hour from
-- any network. A browser string, app marker or (shape rows) network that differs between the repeats is cleared and the
-- row marked mixed (the browser string is the caller's choice: keying on it would let a flooder make a row per call).
-- New rows an hour, counted per class so a flood of one never hides another: an account's failures, successes and lock
-- moments (locked_now, paused_now) 30 each, with its password re-entries (kind reauth) counted apart from its sign-ins,
-- unlocks and joins (a member confirming their own password cannot use up the rows of their sign-ins); events of no
-- account 60 per kind. Past a cap, attempts are counted on one row an hour per account (or no account), kind and class
-- ('suppressed', 'suppressed_ok', 'suppressed_lock'), which keeps the source the same way a folded row does. A write that
-- fails is logged to the server log (raise log) and never reaches the caller. The writer and the reader plan every query
-- with its real values (plan_cache_mode force_custom_plan): a cached generic plan scanned the whole table when nothing
-- matched, about 90 ms more for a known name's first attempt than an unknown one's, which told the names apart. Cron
-- 'signin-events-prune' deletes events older than 90 days every night.
-- Lock order: an insert takes FOR KEY SHARE on its account row (users FK); every caller already holds that row FOR NO KEY
-- UPDATE (verify_admin, unlock_with_backup_code, _reauth) or created it (join), so no new wait. lock_timeout 2 s (under a
-- browser call's 3 s statement limit): the table's FK takes SHARE ROW EXCLUSIVE on proxima_auth.users while it is created.
-- Replaces verify_admin, unlock_with_backup_code, unlock_admin_with_backup_code, join_with_invite and
-- proxima_auth._reauth with their installed bodies plus one log call before each answer (generated from the live bodies;
-- md5-guarded below). Nothing else in them changes: the same checks, locks, bcrypt count and answers.
-- Tests: scripts/test-signin-history-db.sql. Rollback: supabase/rollback/20261027100000_signin_history.rollback.sql

set local lock_timeout = '2s';

do $guard$
begin
  if md5(pg_get_functiondef('public.verify_admin(text,text)'::regprocedure)) <> 'caf7cc8b38b8c82beb5ff118e1e48a75' then
    raise exception 'signin_history: % changed since this migration was written (installed %, expected caf7cc8b38b8c82beb5ff118e1e48a75)', 'public.verify_admin(text,text)', md5(pg_get_functiondef('public.verify_admin(text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.unlock_with_backup_code(text,text,text)'::regprocedure)) <> '76a6bfd209a85355573a0fa5ae58939c' then
    raise exception 'signin_history: % changed since this migration was written (installed %, expected 76a6bfd209a85355573a0fa5ae58939c)', 'public.unlock_with_backup_code(text,text,text)', md5(pg_get_functiondef('public.unlock_with_backup_code(text,text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.unlock_admin_with_backup_code(text,text)'::regprocedure)) <> 'b1fc2c51f8845b777219498820f72dd7' then
    raise exception 'signin_history: % changed since this migration was written (installed %, expected b1fc2c51f8845b777219498820f72dd7)', 'public.unlock_admin_with_backup_code(text,text)', md5(pg_get_functiondef('public.unlock_admin_with_backup_code(text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('public.join_with_invite(text,text,text)'::regprocedure)) <> 'f5b1cf0c9e8f45edd09dec2549ad79cf' then
    raise exception 'signin_history: % changed since this migration was written (installed %, expected f5b1cf0c9e8f45edd09dec2549ad79cf)', 'public.join_with_invite(text,text,text)', md5(pg_get_functiondef('public.join_with_invite(text,text,text)'::regprocedure));
  end if;
  if md5(pg_get_functiondef('proxima_auth._reauth(uuid,text)'::regprocedure)) <> 'ec17bbba2915e4cffb07b8bd42e13285' then
    raise exception 'signin_history: % changed since this migration was written (installed %, expected ec17bbba2915e4cffb07b8bd42e13285)', 'proxima_auth._reauth(uuid,text)', md5(pg_get_functiondef('proxima_auth._reauth(uuid,text)'::regprocedure));
  end if;
end $guard$;

create table proxima_auth.signin_events (
  id bigint generated always as identity primary key,
  account_id uuid references proxima_auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  repeats integer not null default 1 check (repeats >= 1),
  mixed boolean not null default false,
  kind text not null check (kind in ('signin', 'unlock', 'join', 'reauth')),
  outcome text not null check (length(outcome) between 1 and 40),
  throttled boolean not null default false,
  agent text check (agent is null or length(agent) <= 300),
  client text check (client is null or length(client) <= 120),
  net text check (net is null or net ~ '^[0-9a-f]{8}$')
);
create index signin_events_at on proxima_auth.signin_events (at desc);
create index signin_events_none_at on proxima_auth.signin_events (kind, at) where account_id is null;
create index signin_events_account_at on proxima_auth.signin_events (account_id, at) where account_id is not null;
create index signin_events_account_id on proxima_auth.signin_events (account_id, id) where account_id is not null;
create index signin_events_last_ok on proxima_auth.signin_events (account_id, id)
  where kind <> 'reauth' and outcome in ('ok', 'ok_password_reset', 'suppressed_ok');
alter table proxima_auth.signin_events enable row level security;
revoke all on table proxima_auth.signin_events from public, anon, authenticated, service_role;

-- One event (or one more repeat of a recent one). Never raises, never waits on another call's row: a failure to write is
-- swallowed (the sign-in it records goes on unchanged). Every query is planned with its real values (force_custom_plan:
-- review wf_79964fbc-e0a, a generic plan scanned the whole table and timed known names apart from unknown ones).
create or replace function proxima_auth._log_signin(p_account uuid, p_kind text, p_outcome text, p_throttled boolean default false)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
 set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_raw text := nullif(current_setting('request.headers', true), '');
  v_hdr jsonb; v_cfg proxima_auth.auth_config; v_xffs text[]; v_src text; v_ip inet; v_net text; v_agent text; v_client text;
  v_id bigint;
  v_thr boolean := coalesce(p_throttled, false);
  -- the cap class: a success, the moment an account locks or pauses, or anything else (a failure)
  v_class text := case when p_outcome in ('ok', 'ok_password_reset') then 'ok' when p_outcome in ('locked_now', 'paused_now') then 'lock' else 'fail' end;
  v_sup text;
  -- refusals decided by the request's shape alone (free to send): one row an hour from any network
  v_shape boolean := (p_kind = 'join' and p_outcome in ('closed', 'invalid_username', 'weak_password'))
                  or (p_kind = 'unlock' and p_account is null and p_outcome in ('weak_password', 'update_required'));
begin
  begin
    if v_raw is not null then
      begin v_hdr := v_raw::jsonb; exception when others then v_hdr := null; end;
    end if;
    select * into v_cfg from proxima_auth.auth_config c where c.id;
    -- the caller's address exactly as proxima_auth._throttle reads it, kept only as a short keyed hash
    if jsonb_typeof(v_hdr) = 'object' then
      v_xffs := string_to_array(nullif(btrim(v_hdr ->> 'x-forwarded-for'), ''), ',');
      v_src := case when v_cfg.ip_source = 'cf-connecting-ip' then nullif(btrim(v_hdr ->> 'cf-connecting-ip'), '')
                    else nullif(btrim(v_xffs[cardinality(v_xffs)]), '') end;
      v_agent := left(nullif(btrim(v_hdr ->> 'user-agent'), ''), 300);
      v_client := left(nullif(btrim(v_hdr ->> 'x-client-info'), ''), 120);
    end if;
    begin v_ip := v_src::inet; exception when others then v_ip := null; end;
    if v_ip is not null and v_cfg.throttle_key is not null then
      v_net := left(encode(extensions.hmac(host(case when family(v_ip) = 6 then network(set_masklen(v_ip, 64))::inet else v_ip end),
                                           v_cfg.throttle_key, 'sha256'), 'hex'), 8);
    end if;
    -- a repeat: the same account, kind, outcome and throttle state from the same network within 10 minutes of the row's
    -- start (any network within the hour for a shape refusal) adds to that row (the update below)
    select e.id into v_id from proxima_auth.signin_events e
     where e.account_id is not distinct from p_account and e.kind = p_kind and e.outcome = p_outcome and e.throttled = v_thr
       and (v_shape or e.net is not distinct from v_net)
       and e.at > now() - case when v_shape then interval '1 hour' else interval '10 minutes' end
     order by e.id desc limit 1
     for update skip locked;
    if v_id is null then
      -- caps on new rows an hour, per class (a flood from many networks): an account's failures, successes and lock
      -- moments 30 each, its password re-entries counted apart from its other kinds; events of no account 60 per kind
      -- (the whole condition is parenthesized: PL/pgSQL ends an IF condition at the first THEN outside parentheses, a
      -- CASE's included)
      if ((select count(*) from proxima_auth.signin_events e
            where e.account_id is not distinct from p_account
              and (case when p_account is null then e.kind = p_kind else (e.kind = 'reauth') = (p_kind = 'reauth') end)
              and e.outcome not like 'suppressed%' and case when e.outcome in ('ok', 'ok_password_reset') then 'ok' when e.outcome in ('locked_now', 'paused_now') then 'lock' else 'fail' end = v_class
              and e.at > now() - interval '1 hour')
          >= (case when p_account is null then 60 else 30 end)) then
        -- past a cap the attempt is counted on one row an hour per account (or no account), kind and class
        v_sup := case v_class when 'ok' then 'suppressed_ok' when 'lock' then 'suppressed_lock' else 'suppressed' end;
        select e.id into v_id from proxima_auth.signin_events e
         where e.account_id is not distinct from p_account and e.kind = p_kind and e.outcome = v_sup
           and e.at > now() - interval '1 hour'
         order by e.id desc limit 1
         for update skip locked;
        if v_id is null then
          if not exists (select 1 from proxima_auth.signin_events e where e.account_id is not distinct from p_account
                           and e.kind = p_kind and e.outcome = v_sup and e.at > now() - interval '1 hour') then
            insert into proxima_auth.signin_events (account_id, kind, outcome, agent, client, net)
            values (p_account, p_kind, v_sup, v_agent, v_client, v_net);
          end if;
          return;
        end if;
      else
        insert into proxima_auth.signin_events (account_id, kind, outcome, throttled, agent, client, net)
        values (p_account, p_kind, p_outcome, v_thr, v_agent, v_client, v_net);
        return;
      end if;
    end if;
    -- one more on a folded or counted row: a field that differs between its attempts is cleared, the row marked mixed
    update proxima_auth.signin_events e
       set repeats = e.repeats + 1, last_at = now(),
           mixed = e.mixed or e.net is distinct from v_net or e.agent is distinct from v_agent
                   or e.client is distinct from v_client,
           net = case when e.net is not distinct from v_net then e.net end,
           agent = case when e.agent is not distinct from v_agent then e.agent end,
           client = case when e.client is not distinct from v_client then e.client end
     where e.id = v_id;
  exception when others then
    -- a log row never decides a sign-in; a writer that breaks shows in the server log, never to the caller
    raise log 'proxima signin log failed: % %', sqlstate, sqlerrm;
  end;
end $function$;
revoke all on function proxima_auth._log_signin(uuid, text, text, boolean) from public, anon, authenticated, service_role;

-- The owner's view: a page of events newest first (before a given id; all accounts, one account, or 'none' for events of
-- no account), whether older ones exist, and every account with its last successful sign-in. Anyone else: forbidden.
create or replace function public.list_signins(p_session_token text, p_limit integer default 100, p_before_id bigint default null,
                                               p_account text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'pg_catalog'
 set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_one uuid; v_events json; v_more boolean;
begin
  if v_acc.id is null or not exists (select 1 from proxima_auth.users u where u.id = v_acc.id and u.role = 'owner'
                                       and u.deleted_at is null and u.disabled_at is null) then
    return json_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_account is not null and p_account <> 'none' then
    begin v_one := p_account::uuid; exception when others then return json_build_object('ok', false, 'reason', 'bad_account'); end;
  end if;
  select coalesce(json_agg(json_build_object('id', p.id, 'at', (extract(epoch from p.at) * 1000)::bigint,
                                             'last_at', (extract(epoch from p.last_at) * 1000)::bigint, 'repeats', p.repeats,
                                             'mixed', p.mixed, 'kind', p.kind, 'outcome', p.outcome, 'throttled', p.throttled, 'agent', p.agent,
                                             'client', p.client, 'net', p.net, 'account_id', p.account_id,
                                             'username', u.username, 'role', u.role)
                           order by p.id desc) filter (where p.rn <= v_lim), '[]'::json),
         count(*) > v_lim
    into v_events, v_more
    from (select e.*, row_number() over (order by e.id desc) as rn
            from proxima_auth.signin_events e
           where (p_before_id is null or e.id < p_before_id)
             and (p_account is null or (p_account = 'none' and e.account_id is null) or e.account_id = v_one)
           order by e.id desc
           limit v_lim + 1) p
    left join proxima_auth.users u on u.id = p.account_id;
  return json_build_object('ok', true, 'events', v_events, 'more', v_more, 'accounts', coalesce((
    select json_agg(json_build_object('account_id', u.id, 'username', u.username, 'role', u.role,
                                      'disabled', u.disabled_at is not null, 'deleted', u.deleted_at is not null,
                                      'last_ok_at', (extract(epoch from s.last_at) * 1000)::bigint, 'last_ok_kind', s.kind,
                                      'last_ok_net', s.net, 'last_ok_agent', s.agent, 'last_ok_mixed', s.mixed,
                                      'last_ok_counted', s.outcome = 'suppressed_ok')
                    order by u.role desc, lower(u.username))
      from proxima_auth.users u
      -- successes are the ok and ok_password_reset rows and the counted rows past the hourly limit (suppressed_ok), never
      -- a password re-entry. The newest of them (n), then the latest success among the rows started up to an hour before
      -- it: a repeat adds to a row only within 10 minutes of its start (an hour for a counted row), so an older row whose
      -- repeat came later is in that window
      left join lateral (select e.at from proxima_auth.signin_events e
                          where e.account_id = u.id and e.kind <> 'reauth' and e.outcome in ('ok', 'ok_password_reset', 'suppressed_ok')
                          order by e.id desc limit 1) n on true
      left join lateral (select e.last_at, e.kind, e.net, e.agent, e.mixed, e.outcome from proxima_auth.signin_events e
                          where e.account_id = u.id and e.kind <> 'reauth' and e.outcome in ('ok', 'ok_password_reset', 'suppressed_ok')
                            and e.at > n.at - interval '1 hour'
                          order by e.last_at desc, e.id desc limit 1) s on true), '[]'::json));
end $function$;
revoke all on function public.list_signins(text, integer, bigint, text) from public;
grant execute on function public.list_signins(text, integer, bigint, text) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_admin(p_username text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_th jsonb := proxima_auth._throttle(p_username, false);
  v_u  proxima_auth.users;
  v_s  jsonb;
  v_fail json;
  v_ok boolean;
begin
  v_fail := case when coalesce((v_th->>'blocked')::boolean, false)
                 then json_build_object('ok', false, 'reason', 'throttled', 'retry_after', (v_th->>'retry_after')::int)
                 else json_build_object('ok', false, 'reason', 'invalid') end;
  -- Every typed name queues on its own advisory key before the lookup, whether or not the account exists (review #5:
  -- a row lock taken only for existing names leaked their existence through lock-wait timing). Lock order: IP throttle
  -- row (the check above), then this advisory lock, then the account row.
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(coalesce(p_username, '')), 0));
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for no key update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.password_hash is null
     or v_u.login_locked_at is not null then
    perform extensions.crypt(coalesce(p_password, ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    perform proxima_auth._log_signin(v_u.id, 'signin', case when v_u.id is null then 'unknown' when v_u.deleted_at is not null then 'deleted' when v_u.disabled_at is not null then 'disabled' when v_u.login_locked_at is not null then 'locked' else 'no_password' end, coalesce((v_th->>'blocked')::boolean, false));
    return v_fail;
  end if;
  -- Exactly one bcrypt for every input (round 16 #1): a NULL or empty password pays it too, then answers generically.
  v_ok := extensions.crypt(coalesce(p_password, ''), v_u.password_hash) = v_u.password_hash and p_password is not null;
  if v_ok then
    -- 20261026600000: a member signs in only from a build that keeps one account per browser (it marks its requests
    -- 'proxima-guard/1' in x-client-info: src/lib/session.js). An older build would keep a member's session on a browser
    -- holding the owner's local data. Answered only after a correct password, before anything is counted or reset; the owner
    -- signs in from any build.
    if v_u.role <> 'owner' and not proxima_auth._client_guard() then
      perform proxima_auth._log_signin(v_u.id, 'signin', 'update_required', coalesce((v_th->>'blocked')::boolean, false));
      return json_build_object('ok', false, 'reason', 'update_required');
    end if;
    if v_u.login_failed <> 0 then
      update proxima_auth.users set login_failed = 0, updated_at = now() where id = v_u.id;
    end if;
    v_s := proxima_auth.issue_session(v_u.id);
    perform proxima_auth._log_signin(v_u.id, 'signin', 'ok', coalesce((v_th->>'blocked')::boolean, false));
    return json_build_object('ok', true, 'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint,
      'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role, 'scope', v_u.scope);
  end if;
  update proxima_auth.users
     set login_failed = v_u.login_failed + 1, login_locked_at = case when v_u.login_failed + 1 >= 3 then now() end,
         updated_at = now()
   where id = v_u.id;
  perform proxima_auth._throttle(p_username, true);
  perform proxima_auth._log_signin(v_u.id, 'signin', case when v_u.login_failed + 1 >= 3 then 'locked_now' else 'wrong_password' end, coalesce((v_th->>'blocked')::boolean, false));
  return v_fail;
end $function$
;

CREATE OR REPLACE FUNCTION public.unlock_with_backup_code(p_username text, p_code text, p_new_password text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_th jsonb;
  v_u  proxima_auth.users;
  v_s  jsonb;
  v_failed int;
  v_fail json;
  v_ok boolean;
begin
  if p_new_password is not null and length(p_new_password) < 8 then
    perform proxima_auth._log_signin(null, 'unlock', 'weak_password', false);
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  v_th := proxima_auth._throttle(p_username, false);
  v_fail := case when coalesce((v_th->>'blocked')::boolean, false)
                 then json_build_object('ok', false, 'reason', 'throttled', 'retry_after', (v_th->>'retry_after')::int)
                 else json_build_object('ok', false, 'reason', 'invalid') end;
  -- Every typed name queues on its own advisory key before the lookup, whether or not the account exists (review #5:
  -- a row lock taken only for existing names leaked their existence through lock-wait timing). Lock order: IP throttle
  -- row (the check above), then this advisory lock, then the account row.
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(coalesce(p_username, '')), 0));
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for no key update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.backup_code_hash is null
     or v_u.backup_locked_until > now() then
    perform extensions.crypt(coalesce(trim(p_code), ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    perform proxima_auth._log_signin(v_u.id, 'unlock', case when v_u.id is null then 'unknown' when v_u.deleted_at is not null then 'deleted' when v_u.disabled_at is not null then 'disabled' when v_u.backup_code_hash is null then 'no_backup_code' else 'paused' end, coalesce((v_th->>'blocked')::boolean, false));
    return v_fail;
  end if;
  -- Exactly one bcrypt for every input (round 16 #1): a NULL or empty code pays it too, then counts as wrong.
  v_ok := extensions.crypt(coalesce(trim(p_code), ''), v_u.backup_code_hash) = v_u.backup_code_hash and p_code is not null;
  if not v_ok then
    v_failed := case when v_u.backup_locked_until is not null then 0 else v_u.backup_failed end + 1;
    if v_failed >= 5 then
      update proxima_auth.users set backup_failed = 0, backup_locked_until = now() + interval '15 minutes', updated_at = now()
       where id = v_u.id;
    else
      update proxima_auth.users set backup_failed = v_failed, backup_locked_until = null, updated_at = now() where id = v_u.id;
    end if;
    perform proxima_auth._throttle(p_username, true);
    perform proxima_auth._log_signin(v_u.id, 'unlock', case when v_failed >= 5 then 'paused_now' else 'wrong_code' end, coalesce((v_th->>'blocked')::boolean, false));
    return v_fail;
  end if;
  update proxima_auth.users
     set backup_failed = 0, backup_locked_until = null, login_failed = 0, login_locked_at = null,
         password_hash = case when p_new_password is not null then extensions.crypt(p_new_password, extensions.gen_salt('bf', 12))
                              else password_hash end,
         updated_at = now()
   where id = v_u.id;
  perform proxima_auth._revoke_sessions(v_u.id);
  v_s := proxima_auth.issue_session(v_u.id);
  perform proxima_auth._log_signin(v_u.id, 'unlock', case when p_new_password is not null then 'ok_password_reset' else 'ok' end, coalesce((v_th->>'blocked')::boolean, false));
  return json_build_object('ok', true, 'password_changed', p_new_password is not null, 'token', v_s->>'token',
    'expires_at', (v_s->>'expires_at')::bigint, 'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role,
    'scope', v_u.scope);
end $function$
;

CREATE OR REPLACE FUNCTION public.unlock_admin_with_backup_code(p_code text, p_new_password text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
begin
  -- 20261026600000 (review wf_955c9c2e-d9a #3): only older builds call this owner-only unlock (current builds unlock by name).
  -- From one, a member's own backup code would count against the owner's row: such a request is refused before anything.
  if not proxima_auth._client_guard() then
    perform proxima_auth._log_signin(null, 'unlock', 'update_required', false);
    return json_build_object('ok', false, 'reason', 'update_required');
  end if;
  return public.unlock_with_backup_code((select u.username from proxima_auth.users u where u.role = 'owner'), p_code, p_new_password);
end $function$
;

CREATE OR REPLACE FUNCTION public.join_with_invite(p_code text, p_username text, p_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_name text := btrim(p_username);
  v_th jsonb; v_inv proxima_auth.invites; v_id uuid; v_backup text; v_s jsonb; v_pw_hash text; v_bk_hash text;
begin
  if not coalesce((select c.members_open from proxima_auth.auth_config c where c.id), false) then
    perform proxima_auth._log_signin(null, 'join', 'closed', false);
    return json_build_object('ok', false, 'reason', 'closed');
  end if;
  -- Shapes first: nothing is looked up for a request that could not create an account.
  -- Review r6 (security #3): letters, digits, '_' and '-' only, 2 to 64 (an allow-list: no invisible, direction, variation,
  -- tag or look-alike character can make a name that looks like another account's; a subset of users_username_shape).
  if v_name is null or v_name !~ '^[A-Za-z0-9_-]{2,64}$' then
    perform proxima_auth._log_signin(null, 'join', 'invalid_username', false);
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  if p_password is null or length(p_password) < 8 then
    perform proxima_auth._log_signin(null, 'join', 'weak_password', false);
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  v_th := proxima_auth._throttle('join', false);
  if coalesce((v_th->>'blocked')::boolean, false) then
    perform proxima_auth._log_signin(null, 'join', 'throttled', true);
    return json_build_object('ok', false, 'reason', 'throttled', 'retry_after', (v_th->>'retry_after')::int);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proxima-signin:' || lower(v_name), 0));
  select * into v_inv from proxima_auth.invites i
   where p_code is not null and i.code_hash = proxima_auth._invite_code_hash(p_code)
     and i.used_at is null and i.revoked_at is null and i.expires_at > now()
     and exists (select 1 from proxima_auth.users o where o.id = i.created_by and o.role = 'owner'
                   and o.deleted_at is null and o.disabled_at is null)
   for update of i;
  if not found then
    perform proxima_auth._throttle('join', true);
    perform proxima_auth._log_signin(null, 'join', 'invalid', false);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- Review r5 (security #1): a code answers at most 5 taken names; the next try voids it, so a leaked code cannot list the
  -- accounts' names (the IP throttle follows the sign-in mode, which may be 'observe': this cap holds in every mode).
  if v_inv.taken_count >= 5 then
    update proxima_auth.invites set revoked_at = now() where id = v_inv.id;
    perform proxima_auth._throttle('join', true);
    perform proxima_auth._log_signin(null, 'join', 'invite_voided', false);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- The two bcrypt hashes (about half a second) are made now, before the creator's row is held, so that row is held for
  -- milliseconds (review r6).
  v_backup := proxima_auth._random_code(20);
  v_pw_hash := crypt(p_password, gen_salt('bf', 12));
  v_bk_hash := crypt(v_backup, gen_salt('bf', 12));
  -- Review r5 (security #3) and r6 (security #4): the creator's row is held FOR SHARE before the name check, and its state
  -- re-checked under that lock: an owner renaming to this name meanwhile is waited for (no deadlock on the new name's index
  -- entry), and so is an owner disabled, demoted or deleted meanwhile (those updates take FOR NO KEY UPDATE, which FOR
  -- SHARE waits for and FOR KEY SHARE would not); once they commit, the code no longer works. The price, deliberate: a join
  -- also waits while any owner-row update runs (a sign-in or key save: milliseconds; a backups switch-on that drains a
  -- queued switch-off scrub inline: as long as that drain, 20261025800000/20261026200000), and fails at the 3 s statement
  -- limit if that drain runs past about 2.5 s; trying again works. Joins and switch toggles are both rare.
  perform 1 from proxima_auth.users o where o.id = v_inv.created_by and o.role = 'owner' and o.deleted_at is null
     and o.disabled_at is null for share;
  if not found then
    perform proxima_auth._throttle('join', true);
    perform proxima_auth._log_signin(null, 'join', 'invite_creator_gone', false);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  if proxima_auth._username_taken(v_name) then
    update proxima_auth.invites set taken_count = taken_count + 1 where id = v_inv.id;
    perform proxima_auth._log_signin(null, 'join', 'username_taken', false);
    return json_build_object('ok', false, 'reason', 'username_taken');
  end if;
  begin
    insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash, invited_by)
      values (v_name, 'member', 'user:' || v_name, v_pw_hash, v_bk_hash, v_inv.created_by)
      returning id into v_id;
  exception when unique_violation then   -- a name taken meanwhile, or its folder (users_keep_folder)
    perform proxima_auth._log_signin(null, 'join', 'username_taken', false);
    return json_build_object('ok', false, 'reason', 'username_taken');
  end;
  update proxima_auth.invites set used_at = now(), used_by = v_id where id = v_inv.id;
  v_s := proxima_auth.issue_session(v_id);
  perform proxima_auth._log_signin(v_id, 'join', 'ok', false);
  return json_build_object('ok', true, 'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint,
    'username', v_name, 'account_id', v_id, 'role', 'member', 'scope', 'user:' || v_name, 'backup_code', v_backup);
end $function$
;

CREATE OR REPLACE FUNCTION proxima_auth._reauth(p_account uuid, p_password text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_u proxima_auth.users; v_failed int;
begin
  select * into v_u from proxima_auth.users u where u.id = p_account for no key update;
  if not found then return 'forbidden'; end if;
  if v_u.login_locked_at is not null then
    perform proxima_auth._log_signin(p_account, 'reauth', 'locked', false);
    return 'locked';
  end if;
  if p_password is not null and v_u.password_hash is not null
     and extensions.crypt(p_password, v_u.password_hash) = v_u.password_hash then
    if v_u.login_failed <> 0 then
      update proxima_auth.users set login_failed = 0, updated_at = now() where id = p_account;
    end if;
    perform proxima_auth._log_signin(p_account, 'reauth', 'ok', false);
    return 'ok';
  end if;
  v_failed := v_u.login_failed + 1;
  update proxima_auth.users
     set login_failed = v_failed, login_locked_at = case when v_failed >= 3 then now() end, updated_at = now()
   where id = p_account;
  perform proxima_auth._log_signin(p_account, 'reauth', case when v_failed >= 3 then 'locked_now' else 'wrong_password' end, false);
  return case when v_failed >= 3 then 'locked' else 'invalid' end;
end $function$
;

select cron.schedule('signin-events-prune', '23 4 * * *', $cron$delete from proxima_auth.signin_events where at < now() - interval '90 days'$cron$);
