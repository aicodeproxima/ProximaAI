-- Multi-user P4, one live-update topic per account (docs/MULTI-USER-PLAN.md §5 P4 "Live topic per account"): a change
-- pings only the accounts whose rows it touched, and every account learns its own topic from get_my_account. Until now
-- there was one topic, the owner's: a member's change would wake the owner's devices (and every member's), and members
-- got no topic at all, so their devices waited for the 20 s / focus reconcile.
-- The topic is unchanged in kind: an HMAC of the account's name and sign-out epoch under the session signing key, so it
-- rotates on rename, password change, backup-code unlock and key rotation, as before. The owner's value stays exactly
-- the same (same input), so the owner's open devices notice nothing. Pings still carry nothing.
-- get_my_account belongs to the lockdown session (P1): this changes only its sync_topic line, and refuses if its body
-- moved since this file was written (2026-10-25, md5 9771a17c…).
-- Rollback: supabase/rollback/20261025200000_mu_p4_topic_per_account.rollback.sql
set local lock_timeout = '5s';   -- an apply that cannot take its locks within 5 s stops instead of queueing the app

do $guard$
begin
  if md5(pg_get_functiondef('public.get_my_account(text)'::regprocedure)) <> '9771a17c630684e4f4bbe620c3f02dd5'
     or md5(pg_get_functiondef('proxima_auth.ping_sync()'::regprocedure)) <> 'ab2805481586f7c41122464ae3a19247'
     or md5(pg_get_functiondef('proxima_auth.sync_topic()'::regprocedure)) <> 'd477f4ef6736a9322a5a06e6c439e136' then
    raise exception 'get_my_account, ping_sync or sync_topic changed since 20261025200000 was written: rebase it on the live bodies';
  end if;
end $guard$;

-- The topic of one account. The owner keeps the input it has had since M2, so its open devices keep their topic; a
-- member's input also carries its account id, so a name reused later (P3 makes renames scope-free) can never give two
-- accounts one topic (review round 2, c3 #1). Usernames hold no ':', so the two forms cannot meet. P3 moves the owner to
-- the id form too (one rotation, picked up at the next reconcile).
create function proxima_auth.account_topic(p_account uuid) returns text
  language sql stable security definer set search_path = ''
as $$
  select 'proxima-sync-' || encode(extensions.hmac(
           'sync-ping:' || case when u.role = 'owner' then u.username else u.id::text || ':' || u.username end
             || ':' || (u.sessions_valid_after + 1)::text,
           (select value->>'key' from public.app_secrets where key = 'session_signing_key'),
           'sha256'), 'hex')
    from proxima_auth.users u
   where u.id = p_account
$$;
revoke all on function proxima_auth.account_topic(uuid) from public;

-- The owner's topic, kept for the suites and tools that ask for it: the same value as before.
create or replace function proxima_auth.sync_topic() returns text
  language sql stable security definer set search_path = ''
as $$
  select proxima_auth.account_topic(u.id) from proxima_auth.users u where u.role = 'owner'
$$;

-- One ping per account whose rows the statement changed (changed_rows is the statement's transition table: NEW rows for
-- an insert or update, OLD rows for a delete). A statement that changed nothing sends nothing, and a disabled or
-- deleted account gets none.
create or replace function proxima_auth.ping_sync() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  perform realtime.send('{}'::jsonb, 'changed', proxima_auth.account_topic(u.id), false)
     from proxima_auth.users u
    where u.scope in (select c.device_id from changed_rows c)
      and u.disabled_at is null and u.deleted_at is null;
  return null;
end $$;

-- Every account learns its own topic (was: the owner only).
create or replace function public.get_my_account(p_session_token text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare v_acc proxima_auth.account := proxima_auth.current_account(p_session_token); v_u proxima_auth.users;
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_u from proxima_auth.users u where u.id = v_acc.id;
  return json_build_object('ok', true,
    'id',                v_u.id,
    'role',              v_u.role,
    'scope',             v_u.scope,
    'username',          v_u.username,
    'email',             v_u.email,
    'email_verified',    v_u.email_verified,
    'last_verified_at',  v_u.last_verified_at,
    'has_backup_code',   v_u.backup_code_hash is not null,
    'password_is_bcrypt', v_u.password_hash is not null,
    'sync_topic',        proxima_auth.account_topic(v_u.id));
end $function$;
