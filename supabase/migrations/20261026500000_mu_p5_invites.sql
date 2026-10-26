-- Joining by invite (docs/SECOND-ACCOUNT-PLAN.md S1, decision K7; owner ruling 2026-10-23: invite only).
--
-- The owner creates a one-time code (Settings, password re-checked). It is valid for 7 days, at most 5 are open at a time,
-- and the server keeps only its sha-256: the code itself is shown once, to the owner. The person invited opens /join,
-- types the code, a name and a password, and gets a member account (role 'member', invited_by = the owner), its storage
-- folder claimed (users_keep_folder), a backup code shown once (stored as bcrypt, accepted by unlock_with_backup_code),
-- and a session. Wrong codes count against the caller's IP like failed sign-ins (proxima_auth._throttle) and all get one
-- generic answer; a name is checked with the same list rename_my_account uses (another account, rows under its scope,
-- a folder another account holds), only after a valid code, and a taken name leaves the invite usable (at most 5 times:
-- then the code is void). Join's IP throttle follows the sign-in mode (auth_config.signin_throttle): in 'observe', wrong
-- codes are logged and counted but never blocked, and the 80-bit codes are what keeps guessing out of reach.
--
-- The gate (plan: no member account, not even a test one, before every P4 wall is live): a new switch
-- proxima_auth.auth_config.members_open, false here. create_invite and join_with_invite answer 'closed' until it is turned
-- on (a separate, recorded step once the RLS session confirms the gate), so this can be applied before the gate opens.
--
-- Not here: deleting a member account (P5; it must take FOR UPDATE on the account row before deleting backups, RLS
-- session note on 20261025820000), the Settings invite button and the /join page (S4, client).
--
-- Rollback: supabase/rollback/20261026500000_mu_p5_invites.rollback.sql (refuses while a member account exists).
-- Tests (rolled back): node scripts/tools/sql-tx.mjs supabase/migrations/20261026500000_mu_p5_invites.sql --test scripts/test-invites-db.sql

alter table proxima_auth.auth_config add column members_open boolean not null default false;

create table proxima_auth.invites (
  id          uuid primary key default gen_random_uuid(),
  code_hash   text not null unique,
  created_by  uuid not null references proxima_auth.users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references proxima_auth.users(id),
  revoked_at  timestamptz,
  taken_count int not null default 0,   -- 'username_taken' answers given for this code (at most 5, then it is void)
  constraint invites_used_pair check ((used_at is null) = (used_by is null))
);
alter table proxima_auth.invites enable row level security;   -- no policy: only the definer functions below reach it
revoke all on table proxima_auth.invites from public, anon, authenticated, service_role;

-- The stored form of a code: sha-256 of its letters and digits, upper case (a code typed in lower case, with or without
-- the dashes, matches). The codes carry 80 random bits, so a fast hash is enough.
create function proxima_auth._invite_code_hash(p_code text) returns text
  language sql immutable set search_path to ''
as $function$
  select encode(extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex')
$function$;

-- p_len random characters from the backup codes' 32-symbol alphabet (no 0/O/1/I; App.jsx makeBackupCode), grouped by 4.
-- 32 divides 256, so every symbol is equally likely: 5 bits each.
create function proxima_auth._random_code(p_len int) returns text
  language plpgsql volatile set search_path to ''
as $function$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(p_len);
  v_out text := '';
begin
  for i in 0 .. p_len - 1 loop
    v_out := v_out || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
    if i % 4 = 3 and i < p_len - 1 then v_out := v_out || '-'; end if;
  end loop;
  return v_out;
end $function$;

-- A name another account, its rows or its storage folder already use. The same list as rename_my_account's.
create function proxima_auth._username_taken(p_name text) returns boolean
  language sql stable security definer set search_path to 'public', 'pg_catalog'
as $function$
  select exists (select 1 from proxima_auth.users u where lower(u.username) = lower(p_name))
      or exists (select 1 from tasks x where x.device_id = 'user:' || p_name)
      or exists (select 1 from history x where x.device_id = 'user:' || p_name)
      or exists (select 1 from favorites x where x.device_id = 'user:' || p_name)
      or exists (select 1 from presets x where x.device_id = 'user:' || p_name)
      or exists (select 1 from settings x where x.device_id = 'user:' || p_name and x.key <> 'last_restore_at')
      or exists (select 1 from sync_tombstones x where x.device_id = 'user:' || p_name)
      or exists (select 1 from user_secrets x where x.device_id = 'user:' || p_name)
      or exists (select 1 from data_backups x where x.username = 'user:' || p_name)
      or exists (select 1 from proxima_auth.account_folders f where f.folder = proxima_auth.scope_folder('user:' || p_name))
$function$;

revoke execute on function proxima_auth._invite_code_hash(text), proxima_auth._random_code(int), proxima_auth._username_taken(text)
  from public, anon, authenticated, service_role;

-- Browser (owner): a new invite. Answers {ok, code, expires_at (epoch s)} once; otherwise {ok:false, reason}:
-- forbidden (not the owner), closed (members switch off), invalid / locked (password re-check), too_many (5 open).
create function public.create_invite(p_session_token text, p_current_password text) returns json
  language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_auth text; v_code text; v_exp timestamptz; v_open int;
begin
  if v_acc.id is null or v_acc.role is distinct from 'owner' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if not coalesce((select c.members_open from proxima_auth.auth_config c where c.id), false) then
    return json_build_object('ok', false, 'reason', 'closed');
  end if;
  v_auth := proxima_auth._reauth(v_acc.id, p_current_password);   -- also holds the account row: one invite write at a time
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  select count(*) into v_open from proxima_auth.invites i
   where i.created_by = v_acc.id and i.used_at is null and i.revoked_at is null and i.expires_at > now();
  if v_open >= 5 then return json_build_object('ok', false, 'reason', 'too_many'); end if;
  v_code := proxima_auth._random_code(16);
  v_exp := now() + interval '7 days';
  insert into proxima_auth.invites (code_hash, created_by, expires_at)
    values (proxima_auth._invite_code_hash(v_code), v_acc.id, v_exp);
  return json_build_object('ok', true, 'code', v_code, 'expires_at', extract(epoch from v_exp)::bigint);
end $function$;

-- Browser (owner): the owner's invites, newest first, with their state (open, used, revoked, expired) and who used them.
-- Never a code or a hash.
create function public.list_my_invites(p_session_token text) returns json
  language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null or v_acc.role is distinct from 'owner' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  return json_build_object('ok', true, 'invites', coalesce((
    select json_agg(json_build_object(
             'id', i.id,
             'created_at', extract(epoch from i.created_at)::bigint,
             'expires_at', extract(epoch from i.expires_at)::bigint,
             'state', case when i.used_at is not null then 'used' when i.revoked_at is not null then 'revoked'
                           when i.expires_at <= now() then 'expired' else 'open' end,
             'used_at', extract(epoch from i.used_at)::bigint,
             'used_by_username', u.username)
           order by i.created_at desc)
      from proxima_auth.invites i left join proxima_auth.users u on u.id = i.used_by
     where i.created_by = v_acc.id), '[]'::json));
end $function$;

-- Browser (owner): revoke one open invite. {ok} or {ok:false, reason: forbidden | not_found (unknown, used or revoked)}.
create function public.revoke_invite(p_session_token text, p_invite_id uuid) returns json
  language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null or v_acc.role is distinct from 'owner' then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  update proxima_auth.invites set revoked_at = now()
   where id = p_invite_id and created_by = v_acc.id and used_at is null and revoked_at is null;
  if not found then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  return json_build_object('ok', true);
end $function$;

-- Browser (anyone, /join): a new member account from an invite. Answers like verify_admin plus the backup code, shown once:
-- {ok, token, expires_at, username, account_id, role, scope, backup_code}; otherwise {ok:false, reason}: closed,
-- invalid_username, weak_password, throttled (+ retry_after), invalid (any code that does not work), username_taken.
-- Lock order as in a sign-in: the IP throttle row, the name's advisory key, then the invite and account rows.
create function public.join_with_invite(p_code text, p_username text, p_password text) returns json
  language plpgsql security definer set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_name text := btrim(p_username);
  v_th jsonb; v_inv proxima_auth.invites; v_id uuid; v_backup text; v_s jsonb;
begin
  if not coalesce((select c.members_open from proxima_auth.auth_config c where c.id), false) then
    return json_build_object('ok', false, 'reason', 'closed');
  end if;
  -- Shapes first: nothing is looked up for a request that could not create an account.
  -- Review r5 (security #2): no control, invisible or direction characters either (a name that looks like another).
  if v_name is null or length(v_name) < 2 or length(v_name) > 64 or v_name ~ '[.:/[:space:]]'
     or v_name ~ '[[:cntrl:]­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]' then
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  if p_password is null or length(p_password) < 8 then
    return json_build_object('ok', false, 'reason', 'weak_password');
  end if;
  v_th := proxima_auth._throttle('join', false);
  if coalesce((v_th->>'blocked')::boolean, false) then
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
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- Review r5 (security #1): a code answers at most 5 taken names; the next try voids it, so a leaked code cannot list the
  -- accounts' names (the IP throttle follows the sign-in mode, which may be 'observe': this cap holds in every mode).
  if v_inv.taken_count >= 5 then
    update proxima_auth.invites set revoked_at = now() where id = v_inv.id;
    perform proxima_auth._throttle('join', true);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- Review r5 (security #3): the creator's row is held (FOR KEY SHARE, as the member's invited_by will hold it) before the
  -- name check, and its state re-checked under that lock: an owner renaming to this name meanwhile is waited for (no
  -- deadlock on the new name's index entry), and an owner disabled or demoted meanwhile ends the code's use.
  perform 1 from proxima_auth.users o where o.id = v_inv.created_by and o.role = 'owner' and o.deleted_at is null
     and o.disabled_at is null for key share;
  if not found then
    perform proxima_auth._throttle('join', true);
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  if proxima_auth._username_taken(v_name) then
    update proxima_auth.invites set taken_count = taken_count + 1 where id = v_inv.id;
    return json_build_object('ok', false, 'reason', 'username_taken');
  end if;
  v_backup := proxima_auth._random_code(20);
  begin
    insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash, invited_by)
      values (v_name, 'member', 'user:' || v_name, crypt(p_password, gen_salt('bf', 12)), crypt(v_backup, gen_salt('bf', 12)),
              v_inv.created_by)
      returning id into v_id;
  exception when unique_violation then   -- a name taken meanwhile, or its folder (users_keep_folder)
    return json_build_object('ok', false, 'reason', 'username_taken');
  end;
  update proxima_auth.invites set used_at = now(), used_by = v_id where id = v_inv.id;
  v_s := proxima_auth.issue_session(v_id);
  return json_build_object('ok', true, 'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint,
    'username', v_name, 'account_id', v_id, 'role', 'member', 'scope', 'user:' || v_name, 'backup_code', v_backup);
end $function$;

revoke execute on function public.create_invite(text, text), public.list_my_invites(text), public.revoke_invite(text, uuid),
  public.join_with_invite(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_invite(text, text), public.list_my_invites(text), public.revoke_invite(text, uuid),
  public.join_with_invite(text, text, text) to anon, authenticated;
