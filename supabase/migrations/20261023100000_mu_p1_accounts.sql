-- Multi-user P1, migration M1 (docs/P1-AUTH-DESIGN.md §2-§4, §6; owner rulings 2026-10-23, §10): accounts table
-- proxima_auth.users seeded with the owner from app_secrets, per-account sign-in, unlock, lockout, epoch and backup
-- pause, generic sign-in answers, the per-IP throttle in 'observe' mode (M1b turns it on after the header probe), and
-- every function that read the global admin rows or used the 'admin:' literal rewritten through
-- proxima_auth.current_account. The owner keeps getting 'admin:<name>' tokens until M3; both formats verify from here.
-- app_secrets' account rows are frozen from here (kept for the rollback; auto_backups and the signing key stay there):
-- right after the seed, the triggers of proxima_auth.m1_frozen_guard() refuse every write of them (review round 17).
-- Rollback: supabase/rollback/20261023100000_mu_p1_accounts.rollback.sql (proof: scripts/test-mu-rollback.sql).
-- Gate: node scripts/tools/sql-tx.mjs <this file> --test scripts/test-mu-auth.sql (M1 alone: only scope-header-A fails).
-- Apply checklist (§4): C0 live; both owner devices idle and off the Account screen (no sign-in, unlock or Account
-- change in flight). An old-code call that still waited on this file's lock fails at its first account-row write after
-- the commit and rolls back whole (the client shows an error; a retry runs the new code), so nothing needs copying.
-- Right after the commit, the READ-ONLY post-apply check (§2) confirms the guard held:
--   node scripts/tools/sb-query.mjs -f scripts/mu-p1-post-apply-check.sql
-- It prints same: true always (every frozen row's md5 still equals proxima_auth.m1_seed_snapshot, both guard triggers
-- in place and enabled); anything else: stop and investigate. Proof: scripts/test-mu-frozen-guard.sql.

-- ── 0. Compare-and-swap: every function M1 replaces must still have the body this file was written against (captured
--      2026-10-23 with pg_get_functiondef). _verify_session_token may also carry this M1's own rollback guard line (a
--      re-apply after the rollback). Anything else: abort, re-capture and re-review.
do $cas$
declare
  v_expect constant jsonb := '{
    "public._verify_session_token(text)": "e5279a955d40ad5e83f616b9a715751d",
    "public.verify_admin(text,text)": "0ea5e49fdd8440021b862e2da76fbd90",
    "public.unlock_admin_with_backup_code(text,text)": "a6b33ca4e27c159ef0aec43d12809fc5",
    "public.change_my_password(text,text,text)": "7c6bd6b17d859c13357c9950c8bcc6bf",
    "public.rename_my_account(text,text,text)": "df83b48dc188d008b12e5a2e5cda81c3",
    "public.set_admin_backup_code(text,text,text)": "5c42c965870e83e61751b1ecea849af2",
    "public.set_admin_credentials_rehash(text,text)": "501e7685d07b71bba360926f5864b9c4",
    "public.get_my_account(text)": "dc00344c10838600ebee66106faf712a",
    "public.set_my_account(text,text,boolean,bigint)": "eb62f0446fb21f97b88bbfe250bdcfb3",
    "public.get_my_wavespeed_key(text)": "afcb2ee65397fa0159d7717208763771",
    "public.set_my_wavespeed_key(text,text)": "c0f8c0e5ca8a82095c038a3bc101cb63",
    "public.get_auto_backups(text)": "df3ed54f683bcb444e1efc1ae1a70aa7",
    "public.set_auto_backups(text,boolean)": "6dcd3e1b5b770de671fc58e680154a86",
    "public._rows_keep_owner()": "bcac6e054cc7c5f4bede6c55ec7c4b6f",
    "public.clear_queued_rows(text,text,bigint,text[])": "1048b01fb8c46633043506b5c742faba",
    "public.delete_queued_rows(text,text,text[],bigint)": "6055ffdde8572b6d7a51f951bda1ee0d",
    "public.generations_live(text,text[])": "867288f2fa843c3b609a3c116f491790",
    "public.paths_in_use(text,text[])": "113a9a0cfde369f2133f009bedb65719",
    "public.reset_queued_rows(text,bigint,text[],text[],bigint)": "28477808ca92d36e8ee1b21929c47152",
    "public.upsert_queued_history(text,jsonb,bigint)": "d71124ec3a60dda4b6267cbd8af9d989",
    "public.server_time_ms(text)": "0833546769db65af467e5807045a9289",
    "public.list_my_backups_phase2(text,integer)": "e78a4d245728f0fac1eb91339a0d4a2a",
    "public.delete_my_backup_phase2(text,uuid)": "5b663629c5a574c58351273d2ba445fa",
    "public.purge_my_backups_of(text,text[],text[])": "5cd2680f21b2c92c2d9196192b19426e",
    "public.restore_my_backup_phase2(text,uuid)": "303cd3180bc59e113a33f79c6b02d4d2",
    "public.snapshot_my_data_phase2(text,text,text)": "cb00c6db451a0499fb2d4f82343ec474"
  }';
  v_rollback_verify constant text := 'f640bd33111329d64e18ef3b084e42b6';
  v_bad text;
begin
  if to_regclass('proxima_auth.users') is not null then raise exception 'M1: proxima_auth.users already exists (M1 applied?)'; end if;
  select string_agg(e.k, ', ' order by e.k) into v_bad
    from jsonb_each_text(v_expect) e(k, m)
   where to_regprocedure(e.k) is null
      or (md5(pg_get_functiondef(to_regprocedure(e.k))) <> e.m
          and not (e.k = 'public._verify_session_token(text)'
                   and md5(pg_get_functiondef(to_regprocedure(e.k))) = v_rollback_verify));
  if v_bad is not null then
    raise exception 'M1 compare-and-swap: live body differs from the reviewed capture: %', v_bad;
  end if;
end $cas$;

-- ── 1. No old-code sign-in, unlock or password change may commit into the account rows between the seed and commit.
lock table public.app_secrets in share row exclusive mode;
-- ── 2. Schema (design §2) ────────────────────────────────────────────────────────────────────────────────────────────
create table proxima_auth.users (
  id                   uuid primary key default gen_random_uuid(),   -- immutable account id; P3 makes it the scope
  username             text not null,                                 -- display + sign-in name
  role                 text not null check (role in ('owner','member')),
  scope                text not null,                                 -- the account's data scope (single source)
  password_hash        text,                                          -- bcrypt; null = cannot sign in
  backup_code_hash     text,                                          -- bcrypt
  email                text,
  email_verified       boolean not null default false,
  last_verified_at     bigint,
  sessions_valid_after bigint not null default 0,                     -- epoch seconds; tokens issued at or before it are revoked
  login_failed         int not null default 0,
  login_locked_at      timestamptz,                                   -- not null = locked (3-try rule)
  backup_failed        int not null default 0,
  backup_locked_until  timestamptz,                                   -- 5 wrong codes -> 15 min
  rename_taken_count   int not null default 0,                        -- username_taken answers in the current hour
  rename_taken_since   timestamptz,                                   -- start of that hour
  invited_by           uuid references proxima_auth.users(id),
  disabled_at          timestamptz,
  deleted_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint users_username_shape check (length(username) between 2 and 64 and username !~ '[.:/[:space:]]'),
  constraint users_scope_in_step  check (scope = 'user:' || username)  -- P1/P2 only; P3 drops it and sets 'user:'||id
);
-- No auto_backups column in P1: app_secrets stays the only copy (P4 adds it).
create unique index users_username_ci on proxima_auth.users (lower(username));   -- not partial: a freed name would
                                                                                 -- inherit 'user:<name>' rows in P1
create unique index users_scope_key   on proxima_auth.users (scope);
create unique index users_one_owner   on proxima_auth.users ((true)) where role = 'owner';

create table proxima_auth.auth_config (                -- one row, read without locks
  id boolean primary key default true check (id),
  signin_throttle text not null default 'observe' check (signin_throttle in ('off','observe','on')),
  throttle_max_failures int not null default 10,
  throttle_window interval not null default '15 minutes',
  ip_source text not null default 'cf-connecting-ip' check (ip_source in ('cf-connecting-ip','xff-last')),
  throttle_key text not null default encode(extensions.gen_random_bytes(32), 'hex'),  -- throttle only; never signs
  throttle_guard_names int not null default 50,        -- distinct names failing from one key in a window -> observe
  throttle_max_rows int not null default 10000,        -- row budget for signin_throttle -> observe
  gateway_ips inet[] not null default '{}',            -- known gateway hops (from the probe); a key on one -> observe
  dummy_hash text not null                             -- bcrypt(12) of a random string, for equal timing
);
create table proxima_auth.signin_throttle (
  ip_key text primary key,                              -- hex hmac_sha256(network text, throttle_key); never the raw IP
  window_start timestamptz not null, failures int not null, blocked_until timestamptz,
  name_keys text[] not null default '{}'                -- short hmacs of the failing names, capped at guard+1 entries
);
create type proxima_auth.account as (id uuid, username text, role text, scope text);
-- The seed snapshot (review round 16 #2): md5(value::text) of every frozen app_secrets account row the seed copied,
-- taken under the seed's lock. The read-only post-apply check compares it with the live rows to confirm that the frozen
-- guard below held (review round 17: the guard refuses every write, so the md5s never change). Read by postgres only;
-- M4 drops it with the guard, the M1 rollback drops it too.
create table proxima_auth.m1_seed_snapshot (
  key text primary key,                                -- an app_secrets key the seed read
  value_md5 text not null                              -- md5(value::text) at seed time; never the value
);

-- No browser access to the tables (proxima_auth keeps USAGE for anon/authenticated because the policies need
-- session_scope, hence the explicit revokes); row security on with no policies, as a belt.
revoke all on proxima_auth.users, proxima_auth.auth_config, proxima_auth.signin_throttle, proxima_auth.m1_seed_snapshot
  from public, anon, authenticated, service_role;
alter table proxima_auth.users enable row level security;
alter table proxima_auth.auth_config enable row level security;
alter table proxima_auth.signin_throttle enable row level security;
alter table proxima_auth.m1_seed_snapshot enable row level security;

-- ── Seed: the owner row only, from the frozen app_secrets rows (the lock above holds them still) ─────────────────────
insert into proxima_auth.auth_config (signin_throttle, dummy_hash)
  values ('observe', extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf', 12)));

do $seed$
declare
  v_n int; v_u proxima_auth.users; v_out int;
begin
  insert into proxima_auth.users (username, role, scope, password_hash, backup_code_hash, email, email_verified,
                                  last_verified_at, sessions_valid_after, login_failed, login_locked_at,
                                  backup_failed, backup_locked_until)
  select s.u, 'owner', 'user:' || s.u, s.ph, s.bch, s.em, coalesce(s.ev, false), s.lva,
         coalesce(s.at - 1, 0),                                 -- P1 revokes at issued <= epoch; today at issued < at
         coalesce((s.lock->>'failed')::int, 0),
         case when coalesce((s.lock->>'locked')::boolean, false)
              then coalesce(nullif(s.lock->>'locked_at', '')::timestamptz, now()) end,
         coalesce((s.bk->>'failed')::int, 0),
         nullif(s.bk->>'locked_until', '')::timestamptz
    from (select
            (select value->>'username'          from public.app_secrets where key = 'admin_username')             as u,
            (select value->>'password_hash'     from public.app_secrets where key = 'admin_password_hash')        as ph,
            (select value->>'hash'              from public.app_secrets where key = 'admin_backup_code_hash')     as bch,
            (select value->>'email'             from public.app_secrets where key = 'admin_email')                as em,
            (select (value->>'verified')::boolean from public.app_secrets where key = 'admin_email_verified')     as ev,
            (select (value->>'at')::bigint      from public.app_secrets where key = 'admin_last_verified_at')     as lva,
            (select (value->>'at')::bigint      from public.app_secrets where key = 'admin_sessions_valid_after') as at,
            (select value                       from public.app_secrets where key = 'admin_login_lockout')        as lock,
            (select value                       from public.app_secrets where key = 'admin_backup_attempts')      as bk) s
   where s.u is not null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'M1 seed: expected exactly one owner row, inserted %', v_n; end if;
  select * into v_u from proxima_auth.users where role = 'owner';
  if v_u.password_hash is null or v_u.password_hash not like '$2%' then raise exception 'M1 seed: owner password hash is not bcrypt'; end if;
  if v_u.scope is distinct from 'user:' || v_u.username then raise exception 'M1 seed: scope out of step'; end if;
  select (select count(*) from public.tasks where device_id <> v_u.scope)
       + (select count(*) from public.history where device_id <> v_u.scope)
       + (select count(*) from public.sync_tombstones where device_id <> v_u.scope)
       + (select count(*) from public.user_secrets where device_id <> v_u.scope)
       + (select count(*) from public.data_backups where username <> v_u.scope) into v_out;
  if v_out <> 0 then raise exception 'M1 seed: % data rows lie outside the owner scope', v_out; end if;
  if (select count(*) from proxima_auth.users where role = 'owner') <> 1 then raise exception 'M1 seed: owner count is not 1'; end if;
  -- The snapshot of exactly the rows the insert above read (the lock admits no writer in between).
  insert into proxima_auth.m1_seed_snapshot (key, value_md5)
    select a.key, md5(a.value::text) from public.app_secrets a
     where a.key = any (array['admin_username', 'admin_password_hash', 'admin_backup_code_hash', 'admin_email', 'admin_email_verified', 'admin_last_verified_at', 'admin_sessions_valid_after', 'admin_login_lockout', 'admin_backup_attempts']);
end $seed$;

-- ── Frozen guard (review round 17 #2/#4/#5): from the seed on, nothing writes the 9 account rows it copied ───────────
-- An old-code call blocked on the lock above (a sign-in, unlock, password, code, email or rename change) reaches its
-- first app_secrets write after this transaction commits; the row trigger raises there (errcode 55000), so the whole
-- call rolls back and changes nothing (the client shows an error; a retry runs the new code). There is nothing left to
-- merge into the owner row, so no re-copy exists: a three-way merge of two writers cannot be made safe, refusing the old
-- writer is exact. Every other key (auto_backups, the signing keys) stays writable; row security and grants are
-- unchanged. The function is owner-only (a trigger needs no EXECUTE when it fires). Created after the seed, in the same
-- transaction. The M1 rollback drops the triggers and the function before its copy-back; M4 drops them with
-- m1_seed_snapshot. Read-only confirmation: scripts/mu-p1-post-apply-check.sql.
create function proxima_auth.m1_frozen_guard()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  v_frozen constant text[] := array['admin_username', 'admin_password_hash', 'admin_backup_code_hash', 'admin_email', 'admin_email_verified', 'admin_last_verified_at', 'admin_sessions_valid_after', 'admin_login_lockout', 'admin_backup_attempts'];
  v_msg constant text := 'app_secrets admin rows are frozen since P1 M1; write proxima_auth.users';
begin
  if tg_op = 'TRUNCATE' then
    raise exception using message = v_msg, errcode = '55000';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if old.key = any (v_frozen) then raise exception using message = v_msg, errcode = '55000'; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.key = any (v_frozen) then raise exception using message = v_msg, errcode = '55000'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;
create trigger app_secrets_m1_frozen before insert or update or delete on public.app_secrets
  for each row execute function proxima_auth.m1_frozen_guard();
create trigger app_secrets_m1_frozen_truncate before truncate on public.app_secrets
  for each statement execute function proxima_auth.m1_frozen_guard();

-- ── 3. Helpers (all in proxima_auth, executable by postgres only) ────────────────────────────────────────────────────
-- current_account: the one helper that replaces every 'admin:' literal. The verifier raises for anything that is not
-- a live account ('u:<uuid>', or 'admin:<owner name>' in the dual window), so a NULL id cannot arrive in practice.
create function proxima_auth.current_account(p_token text)
 returns proxima_auth.account
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_sub text := public._verify_session_token(p_token);
  v_acc proxima_auth.account;
begin
  if v_sub like 'u:%' then
    select u.id, u.username, u.role, u.scope into v_acc from proxima_auth.users u where u.id = substring(v_sub from 3)::uuid;
  elsif v_sub like 'admin:%' then
    select u.id, u.username, u.role, u.scope into v_acc from proxima_auth.users u where u.role = 'owner';
  end if;
  return v_acc;
end $function$;

-- issue_session: every token-minting RPC goes through it. issued = greatest(clock, epoch + 1), so a new token is never
-- born revoked; until M3 the owner still gets 'admin:<username>', every other role 'u:<id>'.
create function proxima_auth.issue_session(p_account uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_u proxima_auth.users; v_issued bigint; v_exp bigint; v_tok text;
begin
  select * into v_u from proxima_auth.users u where u.id = p_account;
  if not found then raise exception 'issue_session: unknown account'; end if;
  v_issued := greatest(extract(epoch from clock_timestamp())::bigint, v_u.sessions_valid_after + 1);
  v_exp := v_issued + 43200;
  v_tok := public._sign_session_token(case when v_u.role = 'owner' then 'admin:' || v_u.username else 'u:' || v_u.id::text end,
                                      to_timestamp(v_exp));
  return jsonb_build_object('token', v_tok, 'expires_at', v_exp, 'username', v_u.username, 'account_id', v_u.id,
                            'role', v_u.role, 'scope', v_u.scope);
end $function$;

-- mint_token: just the token (tests and the rotate scripts).
create function proxima_auth.mint_token(p_account uuid)
 returns text
 language sql
 security definer
 set search_path to ''
as $function$
  select proxima_auth.issue_session(p_account) ->> 'token'
$function$;

-- _revoke_sessions: per-account epoch; every token issued before it (even in the same second) is revoked.
create function proxima_auth._revoke_sessions(p_account uuid)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  update proxima_auth.users
     set sessions_valid_after = greatest(extract(epoch from clock_timestamp())::bigint, sessions_valid_after + 1),
         updated_at = now()
   where id = p_account;
$function$;

-- _reauth: the current password inside a signed-in session. Keeps today's order: a locked account is refused before
-- crypt (the caller already holds its token, so 'locked' reveals nothing new); 3 wrong -> locked. Not IP-throttled.
create function proxima_auth._reauth(p_account uuid, p_password text)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_u proxima_auth.users; v_failed int;
begin
  select * into v_u from proxima_auth.users u where u.id = p_account for update;
  if not found then return 'forbidden'; end if;
  if v_u.login_locked_at is not null then return 'locked'; end if;
  if p_password is not null and v_u.password_hash is not null
     and extensions.crypt(p_password, v_u.password_hash) = v_u.password_hash then
    if v_u.login_failed <> 0 then
      update proxima_auth.users set login_failed = 0, updated_at = now() where id = p_account;
    end if;
    return 'ok';
  end if;
  v_failed := v_u.login_failed + 1;
  update proxima_auth.users
     set login_failed = v_failed, login_locked_at = case when v_failed >= 3 then now() end, updated_at = now()
   where id = p_account;
  return case when v_failed >= 3 then 'locked' else 'invalid' end;
end $function$;

-- _throttle: the per-IP sign-in throttle (design §6). p_fail = false: the check at the start of an attempt and the
-- observe-mode probe LOG line; answers {blocked, retry_after}. When a key exists, the check creates the IP row if it is
-- missing (within the row budget) and locks it, so the IP row is always locked before the account row (lock order IP
-- row -> per-name advisory lock -> account row, review #9), a key's first-ever attempt included.
-- p_fail = true: count one failed attempt for the caller's key. The key is hmac(host(network), throttle_key) of the
-- header value cast with ::inet (IPv6 by its /64); a missing or uncastable header gives no key and no throttling. The
-- raw IP is never stored or logged.
create function proxima_auth._throttle(p_name text, p_fail boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_cfg proxima_auth.auth_config;
  v_raw text := nullif(current_setting('request.headers', true), '');
  v_hdr jsonb; v_cf text; v_xff text; v_xffs text[]; v_src text; v_ip inet; v_key text; v_n8 text;
  v_row proxima_auth.signin_throttle; v_rows int; v_gw boolean := false;
begin
  select * into v_cfg from proxima_auth.auth_config c where c.id;
  if not found or v_cfg.signin_throttle = 'off' then return jsonb_build_object('blocked', false); end if;
  if v_raw is not null then
    begin v_hdr := v_raw::jsonb; exception when others then v_hdr := null; end;
  end if;
  if jsonb_typeof(v_hdr) = 'object' then
    v_cf := nullif(btrim(v_hdr ->> 'cf-connecting-ip'), '');
    v_xff := nullif(btrim(v_hdr ->> 'x-forwarded-for'), '');
  end if;
  v_xffs := string_to_array(v_xff, ',');
  v_src := case when v_cfg.ip_source = 'cf-connecting-ip' then v_cf
                else nullif(btrim(v_xffs[cardinality(v_xffs)]), '') end;
  begin v_ip := v_src::inet; exception when others then v_ip := null; end;
  if v_ip is not null then
    v_key := encode(extensions.hmac(host(case when family(v_ip) = 6 then network(set_masklen(v_ip, 64))::inet else v_ip end),
                                    v_cfg.throttle_key, 'sha256'), 'hex');
    v_gw := v_ip <<= any (v_cfg.gateway_ips);
  end if;
  if not p_fail then
    if v_cfg.signin_throttle = 'observe' then
      raise log 'proxima signin probe: has_cf=% has_xff=% xff_entries=% cast_ok=% key8=%',
        v_cf is not null, v_xff is not null, coalesce(cardinality(v_xffs), 0), v_ip is not null, coalesce(left(v_key, 8), '-');
    end if;
    if v_key is null then return jsonb_build_object('blocked', false); end if;
    if not exists (select 1 from proxima_auth.signin_throttle t where t.ip_key = v_key)
       and (select count(*) from proxima_auth.signin_throttle) < v_cfg.throttle_max_rows then
      insert into proxima_auth.signin_throttle (ip_key, window_start, failures, blocked_until, name_keys)
        values (v_key, now(), 0, null, '{}') on conflict (ip_key) do nothing;
    end if;
    select * into v_row from proxima_auth.signin_throttle t where t.ip_key = v_key for update;
    if found and v_cfg.signin_throttle = 'on' and not v_gw and v_row.blocked_until > now() then
      return jsonb_build_object('blocked', true,
                                'retry_after', greatest(1, ceil(extract(epoch from v_row.blocked_until - now())))::int);
    end if;
    return jsonb_build_object('blocked', false);
  end if;

  if v_key is null then return jsonb_build_object('blocked', false); end if;
  v_n8 := left(encode(extensions.hmac(lower(coalesce(p_name, '')), v_cfg.throttle_key, 'sha256'), 'hex'), 16);
  delete from proxima_auth.signin_throttle d
   where d.ip_key in (select s.ip_key from proxima_auth.signin_throttle s
                       where s.window_start < now() - interval '1 day' and s.ip_key <> v_key
                         and (s.blocked_until is null or s.blocked_until < now())
                       limit 20 for update skip locked);
  if not exists (select 1 from proxima_auth.signin_throttle t where t.ip_key = v_key) then
    select count(*) into v_rows from proxima_auth.signin_throttle;
    if v_rows >= v_cfg.throttle_max_rows then
      raise log 'proxima signin throttle: row budget reached (% rows); mode -> observe', v_rows;
      update proxima_auth.auth_config set signin_throttle = 'observe' where id and signin_throttle = 'on';
      return jsonb_build_object('blocked', false);
    end if;
    insert into proxima_auth.signin_throttle (ip_key, window_start, failures, blocked_until, name_keys)
      values (v_key, now(), 0, null, '{}') on conflict (ip_key) do nothing;
  end if;
  select * into v_row from proxima_auth.signin_throttle t where t.ip_key = v_key for update;
  if v_row.window_start <= now() - v_cfg.throttle_window and (v_row.blocked_until is null or v_row.blocked_until <= now()) then
    v_row.window_start := now(); v_row.failures := 0; v_row.name_keys := '{}'; v_row.blocked_until := null;
  end if;
  v_row.failures := v_row.failures + 1;
  if not (v_n8 = any (v_row.name_keys)) and cardinality(v_row.name_keys) <= v_cfg.throttle_guard_names then
    v_row.name_keys := v_row.name_keys || v_n8;
  end if;
  if v_cfg.signin_throttle = 'on' and v_row.failures >= v_cfg.throttle_max_failures
     and (v_row.blocked_until is null or v_row.blocked_until <= now()) then
    v_row.blocked_until := now() + v_cfg.throttle_window;
  end if;
  update proxima_auth.signin_throttle
     set window_start = v_row.window_start, failures = v_row.failures, blocked_until = v_row.blocked_until,
         name_keys = v_row.name_keys
   where ip_key = v_key;
  if cardinality(v_row.name_keys) > v_cfg.throttle_guard_names or v_gw then
    raise log 'proxima signin throttle: key % looks shared (% names, gateway=%); mode -> observe',
      left(v_key, 8), cardinality(v_row.name_keys), v_gw;
    update proxima_auth.auth_config set signin_throttle = 'observe' where id and signin_throttle = 'on';
  end if;
  return jsonb_build_object('blocked', false);
end $function$;

-- ── 4. Token verification (design §3): both formats from M1; any other subject fails closed ─────────────────────────
CREATE OR REPLACE FUNCTION public._verify_session_token(p_token text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_parts text[]; v_subject text; v_exp bigint; v_sig text; v_msg text;
  v_key text; v_key_prev text; v_ok boolean := false; v_after bigint; v_id uuid; v_live boolean;
begin
  if p_token is null or p_token = '' then raise exception 'invalid session token'; end if;
  v_parts := string_to_array(p_token, '.');
  if array_length(v_parts, 1) <> 3 then raise exception 'malformed session token'; end if;
  v_subject := v_parts[1];
  begin
    v_exp := v_parts[2]::bigint;
  exception when others then
    raise exception 'malformed exp';
  end;
  v_sig := v_parts[3];
  v_msg := v_subject || '.' || v_exp::text;
  if v_exp < extract(epoch from now())::bigint then raise exception 'session token expired'; end if;
  select value->>'key' into v_key from app_secrets where key = 'session_signing_key';
  if v_key is null then raise exception 'session_signing_key not provisioned'; end if;
  if encode(hmac(v_msg, v_key, 'sha256'), 'hex') = v_sig then
    v_ok := true;
  else
    select value->>'key' into v_key_prev from app_secrets where key = 'session_signing_key_previous';
    if v_key_prev is not null and encode(hmac(v_msg, v_key_prev, 'sha256'), 'hex') = v_sig then v_ok := true; end if;
  end if;
  if not v_ok then raise exception 'invalid signature'; end if;
  if v_subject like 'u:%' then
    begin
      v_id := substring(v_subject from 3)::uuid;
    exception when others then
      raise exception 'malformed session token';
    end;
    select u.sessions_valid_after, u.disabled_at is null and u.deleted_at is null into v_after, v_live
      from proxima_auth.users u where u.id = v_id;
    if not found or not v_live or v_exp - 43200 <= v_after then raise exception 'session token revoked'; end if;
  elsif v_subject like 'admin:%' then
    -- Dual-accept window (until M4): the owner row's exact name and the same issue-time rule as 'u:'.
    select u.sessions_valid_after, u.disabled_at is null and u.deleted_at is null and u.username = substring(v_subject from 7)
      into v_after, v_live
      from proxima_auth.users u where u.role = 'owner';
    if not found or not v_live or v_exp - 43200 <= v_after then raise exception 'session token revoked'; end if;
  else
    raise exception 'malformed session token';
  end if;
  return v_subject;
end $function$;

-- ── 5. Sign-in, unlock and the account RPCs (design §4) ──────────────────────────────────────────────────────────────
-- verify_admin: IP throttle first, then the per-name advisory lock (taken for every typed name, known or not), then the
-- row by lower(username) FOR UPDATE. One generic answer and exactly one
-- bcrypt per attempt: an unknown, disabled or deleted name and a locked account check the dummy hash; a locked account
-- never has its password checked. A wrong password counts on the account (3 -> locked) from any network, blocked or
-- not (main-session decision, §6). From a blocked network a right password still signs in; failures answer 'throttled'.
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
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.password_hash is null
     or v_u.login_locked_at is not null then
    perform extensions.crypt(coalesce(p_password, ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
    return v_fail;
  end if;
  -- Exactly one bcrypt for every input (round 16 #1): a NULL or empty password pays it too, then answers generically.
  v_ok := extensions.crypt(coalesce(p_password, ''), v_u.password_hash) = v_u.password_hash and p_password is not null;
  if v_ok then
    if v_u.login_failed <> 0 then
      update proxima_auth.users set login_failed = 0, updated_at = now() where id = v_u.id;
    end if;
    v_s := proxima_auth.issue_session(v_u.id);
    return json_build_object('ok', true, 'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint,
      'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role, 'scope', v_u.scope);
  end if;
  update proxima_auth.users
     set login_failed = v_u.login_failed + 1, login_locked_at = case when v_u.login_failed + 1 >= 3 then now() end,
         updated_at = now()
   where id = v_u.id;
  perform proxima_auth._throttle(p_username, true);
  return v_fail;
end $function$;

-- unlock_with_backup_code (new): the account by name, after the throttle check and the same per-name advisory lock as
-- verify_admin. One generic answer, one bcrypt per attempt (the row's code or
-- the dummy); during a pause the code is not checked. 5 wrong codes -> 15-min pause, per account. The right code
-- resets both counters, stores the optional new password, bumps THIS account's epoch and returns a fresh token.
create function public.unlock_with_backup_code(p_username text, p_code text, p_new_password text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_th jsonb;
  v_u  proxima_auth.users;
  v_s  jsonb;
  v_failed int;
  v_fail json;
  v_ok boolean;
begin
  if p_new_password is not null and length(p_new_password) < 8 then
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
  select * into v_u from proxima_auth.users u where lower(u.username) = lower(p_username) for update;
  if not found or v_u.deleted_at is not null or v_u.disabled_at is not null or v_u.backup_code_hash is null
     or v_u.backup_locked_until > now() then
    perform extensions.crypt(coalesce(trim(p_code), ''), (select c.dummy_hash from proxima_auth.auth_config c where c.id));
    perform proxima_auth._throttle(p_username, true);
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
  return json_build_object('ok', true, 'password_changed', p_new_password is not null, 'token', v_s->>'token',
    'expires_at', (v_s->>'expires_at')::bigint, 'username', v_u.username, 'account_id', v_u.id, 'role', v_u.role,
    'scope', v_u.scope);
end $function$;

-- The old 2-arg unlock (stale bundles, rollback): the owner row only, through the same body as the new one.
CREATE OR REPLACE FUNCTION public.unlock_admin_with_backup_code(p_code text, p_new_password text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
begin
  return public.unlock_with_backup_code((select u.username from proxima_auth.users u where u.role = 'owner'), p_code, p_new_password);
end $function$;

CREATE OR REPLACE FUNCTION public.change_my_password(p_session_token text, p_current_password text, p_new_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token); v_auth text; v_s jsonb;
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_new_password is null or length(p_new_password) < 8 then return json_build_object('ok', false, 'reason', 'weak_password'); end if;
  v_auth := proxima_auth._reauth(v_acc.id, p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  update proxima_auth.users set password_hash = crypt(p_new_password, gen_salt('bf', 12)), updated_at = now() where id = v_acc.id;
  perform proxima_auth._revoke_sessions(v_acc.id);
  v_s := proxima_auth.issue_session(v_acc.id);
  return json_build_object('ok', true, 'username', v_s->>'username',
    'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint);
end $function$;

-- rename_my_account: validation; then the per-account rate limit (5 username_taken answers per hour); re-auth; the
-- taken check (another account's name in any case, or rows already in 'user:'||new); lock order users row -> restore
-- marker -> tables; username and scope move together; today's 8-table rescope; the epoch is bumped.
CREATE OR REPLACE FUNCTION public.rename_my_account(p_session_token text, p_current_password text, p_new_username text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_old text; v_new text := trim(p_new_username); v_auth text; v_s jsonb; v_u proxima_auth.users;
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  v_old := v_acc.username;
  if v_new is null or length(v_new) < 2 or length(v_new) > 64 or v_new ~ '[.:/\s]' then
    return json_build_object('ok', false, 'reason', 'invalid_username');
  end if;
  select * into v_u from proxima_auth.users u where u.id = v_acc.id for update;
  if v_u.rename_taken_since > now() - interval '1 hour' and v_u.rename_taken_count >= 5 then
    return json_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  v_auth := proxima_auth._reauth(v_acc.id, p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  if v_new <> v_old then
    if exists (select 1 from proxima_auth.users u where lower(u.username) = lower(v_new) and u.id <> v_acc.id)
       or exists (select 1 from tasks x where x.device_id = 'user:' || v_new)
       or exists (select 1 from history x where x.device_id = 'user:' || v_new)
       or exists (select 1 from favorites x where x.device_id = 'user:' || v_new)
       or exists (select 1 from presets x where x.device_id = 'user:' || v_new)
       or exists (select 1 from settings x where x.device_id = 'user:' || v_new and x.key <> 'last_restore_at')
       or exists (select 1 from sync_tombstones x where x.device_id = 'user:' || v_new)
       or exists (select 1 from user_secrets x where x.device_id = 'user:' || v_new)
       or exists (select 1 from data_backups x where x.username = 'user:' || v_new) then
      update proxima_auth.users
         set rename_taken_count = case when rename_taken_since > now() - interval '1 hour' then rename_taken_count + 1 else 1 end,
             rename_taken_since = case when rename_taken_since > now() - interval '1 hour' then rename_taken_since else now() end
       where id = v_acc.id;
      raise log 'rename_my_account: username_taken for account %', v_acc.id;
      return json_build_object('ok', false, 'reason', 'username_taken');
    end if;
    perform set_config('proxima.rescope', 'on', true);
    -- Restores and replayed deletes take this account's restore marker before its rows (20261022230000); so does a
    -- rename, so no two of them wait on each other in opposite orders (review round 5).
    insert into settings (device_id, key, value) values (v_acc.scope, 'last_restore_at', '0'::jsonb)
      on conflict (device_id, key) do nothing;
    perform 1 from settings where device_id = v_acc.scope and key = 'last_restore_at' for update;
    perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: another rename may have run
    if (proxima_auth.current_account(p_session_token)).scope is distinct from v_acc.scope then raise exception 'session token revoked'; end if;
    update proxima_auth.users set username = v_new, scope = 'user:' || v_new, updated_at = now() where id = v_acc.id;
    update tasks set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update history set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update favorites set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update presets set device_id = 'user:' || v_new where device_id = v_acc.scope;
    delete from settings where device_id = 'user:' || v_new and key = 'last_restore_at';   -- a leftover marker of the target name
    update settings set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update sync_tombstones set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update user_secrets set device_id = 'user:' || v_new where device_id = v_acc.scope;
    update data_backups set username = 'user:' || v_new where username = v_acc.scope;
    perform set_config('proxima.rescope', 'off', true);
    perform proxima_auth._revoke_sessions(v_acc.id);
  end if;
  v_s := proxima_auth.issue_session(v_acc.id);
  return json_build_object('ok', true, 'username', v_new,
    'token', v_s->>'token', 'expires_at', (v_s->>'expires_at')::bigint);
end $function$;

CREATE OR REPLACE FUNCTION public.set_admin_backup_code(p_session_token text, p_current_password text, p_code text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_acc proxima_auth.account := proxima_auth.current_account(p_session_token); v_auth text;
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_code is null or length(trim(p_code)) < 12 then return json_build_object('ok', false, 'reason', 'too_short'); end if;
  v_auth := proxima_auth._reauth(v_acc.id, p_current_password);
  if v_auth <> 'ok' then return json_build_object('ok', false, 'reason', v_auth); end if;
  update proxima_auth.users
     set backup_code_hash = crypt(trim(p_code), gen_salt('bf', 12)), backup_failed = 0, backup_locked_until = null, updated_at = now()
   where id = v_acc.id;
  return json_build_object('ok', true);
end $function$;

-- No legacy sha256 row exists: an account check, then always not_legacy. Dropped at M4.
CREATE OR REPLACE FUNCTION public.set_admin_credentials_rehash(p_session_token text, p_plain_password text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  return json_build_object('ok', false, 'reason', 'not_legacy');
end $function$;

-- get_my_account: the account's row. In P1 there is one sync topic and it is the owner's (members: null until P4).
CREATE OR REPLACE FUNCTION public.get_my_account(p_session_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
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
    'sync_topic',        case when v_u.role = 'owner' then proxima_auth.sync_topic() end);
end $function$;

CREATE OR REPLACE FUNCTION public.set_my_account(p_session_token text, p_email text DEFAULT NULL::text, p_email_verified boolean DEFAULT NULL::boolean, p_last_verified_at bigint DEFAULT NULL::bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null then return json_build_object('ok', false, 'reason', 'forbidden'); end if;
  update proxima_auth.users
     set email = coalesce(p_email, email), email_verified = coalesce(p_email_verified, email_verified),
         last_verified_at = coalesce(p_last_verified_at, last_verified_at), updated_at = now()
   where id = v_acc.id and (p_email is not null or p_email_verified is not null or p_last_verified_at is not null);
  return json_build_object('ok', true);
end $function$;

-- ── 5b. The scope users and the former fall-through functions (§4): the account and its scope come from
--       current_account; the re-check after the marker lock stays, plus a scope comparison. Bodies otherwise verbatim.
CREATE OR REPLACE FUNCTION public.get_my_wavespeed_key(p_session_token text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_device_id text;
  v_key text;
BEGIN
  v_device_id := (proxima_auth.current_account(p_session_token)).scope;   -- the account's own scope, never the subject
  IF v_device_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT value->>'value' INTO v_key
    FROM user_secrets
    WHERE device_id = v_device_id AND key = 'wavespeed_api_key';
  RETURN v_key;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_my_wavespeed_key(p_session_token text, p_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_device_id text;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) < 8 THEN
    RAISE EXCEPTION 'WaveSpeed key looks invalid (too short)';
  END IF;
  v_device_id := (proxima_auth.current_account(p_session_token)).scope;   -- the account's own scope, never the subject
  IF v_device_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  INSERT INTO user_secrets (device_id, key, value)
    VALUES (v_device_id, 'wavespeed_api_key', jsonb_build_object('value', p_key))
  ON CONFLICT (device_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();
  RETURN json_build_object('ok', true, 'device_id', v_device_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_auto_backups(p_session_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  -- The switch is global until P4: the owner's alone.
  if (proxima_auth.current_account(p_session_token)).role is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public._auto_backups_on();
end $function$
;

CREATE OR REPLACE FUNCTION public.set_auto_backups(p_session_token text, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  -- The switch is global until P4: the owner's alone.
  if (proxima_auth.current_account(p_session_token)).role is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into app_secrets (key, value, updated_at) values ('auto_backups', jsonb_build_object('enabled', coalesce(p_enabled, false)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if not coalesce(p_enabled, false) then
    -- The switch is global (app_secrets): every account's backups lose what that account deleted so far.
    insert into backup_scrub_queue (username, all_tombstones)
    select distinct b.username, true from data_backups b;
  end if;
  return public._auto_backups_on();
end $function$
;

CREATE OR REPLACE FUNCTION public._rows_keep_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_live text := (select u.scope from proxima_auth.users u where u.role = 'owner');
begin
  if new.device_id is distinct from old.device_id
     and coalesce(current_setting('proxima.rescope', true), '') <> 'on'
     and not (new.device_id = v_live and old.device_id is distinct from v_live) then
    new.device_id := old.device_id;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.clear_queued_rows(p_session_token text, p_kind text, p_queued_at bigint, p_ids text[] DEFAULT NULL::text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc     proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_user    text := v_acc.scope;
  v_restore bigint;
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind not in ('task', 'history', 'settings', 'favorites') then
    raise exception 'clear_queued_rows: unknown kind %', p_kind;
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_user then raise exception 'session token revoked'; end if;
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'deleted', 0);
  end if;
  return json_build_object('ok', true, 'voided', false,
    'deleted', public._clear_kind(v_user, p_kind, to_timestamp(coalesce(p_queued_at, 0) / 1000.0), p_ids));
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_queued_rows(p_session_token text, p_kind text, p_ids text[], p_queued_at bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc     proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_user    text := v_acc.scope;
  v_restore bigint;
  v_n       int := 0;
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind not in ('task', 'history') then
    raise exception 'delete_queued_rows: unknown kind %', p_kind;
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return json_build_object('ok', true, 'voided', false, 'deleted', 0);
  end if;
  if cardinality(p_ids) > 200 then
    raise exception 'delete_queued_rows: at most 200 ids, got %', cardinality(p_ids);
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have moved the account
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_user then raise exception 'session token revoked'; end if;
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true, 'deleted', 0);
  end if;
  if p_kind = 'task' then
    delete from tasks where device_id = v_user and id = any(p_ids);
  else
    delete from history where device_id = v_user and id = any(p_ids);
  end if;
  get diagnostics v_n = row_count;
  if p_kind = 'task' then
    -- A user delete of a generation without a tasks row (History-only, e.g. after a restore) records a user tombstone
    -- too, so other devices drop its History item and uploads are stripped of it; a restore's tombstone of it becomes a
    -- user one (review round 6). Only ids a live History item of this account holds, or a tombstone already names.
    update sync_tombstones set by_restore = false, deleted_at = now()
     where device_id = v_user and kind = 'task' and id = any(p_ids) and coalesce(by_restore, false);
    insert into sync_tombstones (id, kind, device_id, deleted_at, by_restore)
    select x, 'task', v_user, now(), false from unnest(p_ids) x
     where not exists (select 1 from sync_tombstones st where st.id = x)
       and not exists (select 1 from tasks t where t.id = x)
       and x in (select e.item->>'id' from history h,
                   jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                  where h.device_id = v_user and coalesce(e.item->>'id', '') <> '')
    on conflict (id) do nothing;
    -- The History half of the delete, in this same transaction (review round 8): touching the entries that hold these
    -- ids lets history_strip_deleted_items remove their items (they now carry user tombstones) and recompute the cost,
    -- history_drop_emptied delete an entry left empty, and the scrub triggers queue what left. A restore can no longer
    -- land between the row delete and the History change, and no client upload of a trimmed copy is needed.
    update history h set tasks = h.tasks
     where h.device_id = v_user and jsonb_typeof(h.tasks) = 'array'
       and exists (select 1 from jsonb_array_elements(h.tasks) e where e->>'id' = any(p_ids));
  end if;
  return json_build_object('ok', true, 'voided', false, 'deleted', v_n);
end $function$
;

CREATE OR REPLACE FUNCTION public.generations_live(p_session_token text, p_ids text[])
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc     proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_user    text := v_acc.scope;
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.paths_in_use(p_session_token text, p_paths text[])
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc     proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_user    text := v_acc.scope;
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.reset_queued_rows(p_session_token text, p_queued_at bigint, p_task_ids text[] DEFAULT NULL::text[], p_history_ids text[] DEFAULT NULL::text[], p_prefs_at bigint DEFAULT NULL::bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc     proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_user    text := v_acc.scope;
  v_restore bigint;
  v_upto    timestamptz := to_timestamp(coalesce(p_queued_at, 0) / 1000.0);
  v_prefs   timestamptz := to_timestamp(coalesce(p_prefs_at, p_queued_at, 0) / 1000.0);
  v_h int; v_t int; v_s int; v_f int;
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into settings (device_id, key, value) values (v_user, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  select coalesce((value #>> '{}')::bigint, 0) into v_restore
    from settings where device_id = v_user and key = 'last_restore_at' for share;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have run
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_user then raise exception 'session token revoked'; end if;
  if coalesce(p_queued_at, 0) < coalesce(v_restore, 0) then
    return json_build_object('ok', true, 'voided', true);
  end if;
  -- Tasks first, as every other path (delete_queued_rows, clear_queued_rows): tasks rows, then History rows.
  v_t := public._clear_kind(v_user, 'task', v_upto, p_task_ids);
  v_h := public._clear_kind(v_user, 'history', v_upto, p_history_ids);
  v_s := public._clear_kind(v_user, 'settings', v_prefs, null);
  v_f := public._clear_kind(v_user, 'favorites', v_prefs, null);
  return json_build_object('ok', true, 'voided', false,
    'deleted', json_build_object('history', v_h, 'task', v_t, 'settings', v_s, 'favorites', v_f));
end $function$
;

CREATE OR REPLACE FUNCTION public.upsert_queued_history(p_session_token text, p_entries jsonb, p_queued_at bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc     proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_user    text := v_acc.scope;
  v_restore bigint;
  v_n       int := 0;
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
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
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_user then raise exception 'session token revoked'; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.server_time_ms(p_session_token text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
begin
  if v_acc.id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (extract(epoch from clock_timestamp()) * 1000)::bigint;
end $function$
;

CREATE OR REPLACE FUNCTION public.list_my_backups_phase2(p_session_token text, p_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, backup_type text, task_count integer, history_count integer, note text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_username text := v_acc.scope;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select b.id, b.backup_type, b.task_count, b.history_count, b.note, b.created_at
    from data_backups b where b.username = v_username order by b.created_at desc limit least(greatest(p_limit, 1), 100);
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_my_backup_phase2(p_session_token text, p_backup_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_username text;
  v_deleted int;
BEGIN
  v_username := (proxima_auth.current_account(p_session_token)).scope;
  IF v_username IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  DELETE FROM data_backups WHERE id = p_backup_id AND username = v_username;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN json_build_object('ok', true, 'deleted_rows', v_deleted);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.purge_my_backups_of(p_session_token text, p_task_ids text[], p_log_ids text[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_acc      proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_username text := v_acc.scope;
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return json_build_object('ok', true, 'backups', public._scrub_backups(v_username, p_task_ids, p_log_ids, '{}'));
end $function$
;

CREATE OR REPLACE FUNCTION public.restore_my_backup_phase2(p_session_token text, p_backup_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_acc      proxima_auth.account := proxima_auth.current_account(p_session_token);
  v_username text := v_acc.scope;
  v_backup   record;
  v_tasks int := 0; v_history int := 0; v_favorites int := 0;
  v_rt text[]; v_rl text[]; v_prev_items text[];
begin
  if v_acc.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Restores and replayed deletes take this account's restore marker first (delete_queued_rows): a delete queued before
  -- this restore waits for it and is then refused; it can never run in the middle of it.
  insert into settings (device_id, key, value) values (v_username, 'last_restore_at', '0'::jsonb) on conflict (device_id, key) do nothing;
  perform 1 from settings where device_id = v_username and key = 'last_restore_at' for update;
  perform public._verify_session_token(p_session_token);   -- again, now that the marker is held: a rename may have moved the account
  if (proxima_auth.current_account(p_session_token)).scope is distinct from v_username then raise exception 'session token revoked'; end if;
  perform public._drain_backup_scrubs(v_username);
  if exists (select 1 from backup_scrub_queue q where q.username = v_username) then
    return json_build_object('ok', false, 'reason', 'Deleted items are still being removed from your backups. Try again in a minute.');
  end if;
  select * into v_backup from data_backups where id = p_backup_id and username = v_username;
  if not found then return json_build_object('ok', false, 'reason', 'backup_not_found'); end if;
  begin
    if public._auto_backups_on() then
      insert into data_backups (id, username, backup_type, task_count, history_count, settings_snapshot,
                                favorites_snapshot, tasks_snapshot, history_snapshot, note)
      select gen_random_uuid(), v_username, 'pre-restore',
        (select count(*) from tasks where device_id = v_username),
        (select count(*) from history where device_id = v_username),
        coalesce((select jsonb_object_agg(key, value) from settings where device_id = v_username and key not like 'form-inputs:%'), '{}'::jsonb),
        coalesce((select jsonb_agg(row_to_json(f)) from (select * from favorites where device_id = v_username) f), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(t)) from (select * from tasks where device_id = v_username order by start_time desc limit 500) t), '[]'::jsonb),
        coalesce((select jsonb_agg(row_to_json(h)) from (select * from history where device_id = v_username order by timestamp desc limit 1000) h), '[]'::jsonb),
        'auto safety snapshot before restoring backup ' || p_backup_id::text;
    end if;
    perform set_config('proxima.restore', 'on', true);
    delete from tasks where device_id = v_username;
    -- The History item ids before the replacement (a History-only generation the restore drops is replaced too).
    v_prev_items := array(select distinct e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username and coalesce(e.item->>'id', '') <> '');
    delete from history where device_id = v_username;
    delete from favorites where device_id = v_username;
    delete from settings where device_id = v_username and key not like 'form-inputs:%' and key <> 'last_restore_at';
    insert into tasks select * from jsonb_populate_recordset(null::tasks, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.tasks_snapshot) = 'array' then v_backup.tasks_snapshot else '[]'::jsonb end) e));
    get diagnostics v_tasks = row_count;
    insert into history select * from jsonb_populate_recordset(null::history, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.history_snapshot) = 'array' then v_backup.history_snapshot else '[]'::jsonb end) e));
    get diagnostics v_history = row_count;
    -- A generation this restore brings back in History is the restore's decision, not a user delete: an older user
    -- tombstone of its id becomes a restore removal (by_restore), so the backup scrub and the History strip treat
    -- it as live while History holds it (review round 5).
    update sync_tombstones st set by_restore = true
     where st.device_id = v_username and st.kind = 'task' and not coalesce(st.by_restore, false)
       and st.id in (select e.item->>'id' from history h,
                      jsonb_array_elements(case when jsonb_typeof(h.tasks) = 'array' then h.tasks else '[]'::jsonb end) e(item)
                     where h.device_id = v_username);
    perform set_config('proxima.restore', 'off', true);
    insert into favorites select * from jsonb_populate_recordset(null::favorites, (
      select coalesce(jsonb_agg(e || jsonb_build_object('device_id', v_username)), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(v_backup.favorites_snapshot) = 'array' then v_backup.favorites_snapshot else '[]'::jsonb end) e));
    get diagnostics v_favorites = row_count;
    insert into settings (device_id, key, value)
      select v_username, k.key, k.value from jsonb_each(coalesce(v_backup.settings_snapshot, '{}'::jsonb)) k where k.key <> 'apiKey' and k.key not like 'form-inputs:%' and k.key <> 'last_restore_at'
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
    -- When this restore happened (epoch ms; after the snapshot's own settings, so an older value in it never wins):
    -- every device drops delete intents it queued before it (review round 2), so a clear still pending on the other
    -- device cannot delete what this restore brought back.
    insert into settings (device_id, key, value) values (v_username, 'last_restore_at', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
      on conflict (device_id, key) do update set value = excluded.value, updated_at = now();
  exception when others then
    perform set_config('proxima.restore', 'off', true);
    return json_build_object('ok', false, 'reason', sqlerrm);
  end;
  -- Owner ruling on review wf_ec400a67-988 #11 (2026-10-22, "Scrub them right away"): with Automatic backups off, the
  -- rows this restore replaced (its by_restore tombstones, stamped in this transaction, not live again) leave every
  -- backup now, as any delete would; the result never depends on a later toggle of the switch.
  if not public._auto_backups_on() then
    v_rt := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'task'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from tasks t where t.id = st.id));
    v_rt := v_rt || array(select x from unnest(coalesce(v_prev_items, '{}')) x
                          where not exists (select 1 from tasks t where t.id = x) and not (x = any(v_rt)));
    v_rl := array(select st.id from sync_tombstones st where st.device_id = v_username and st.kind = 'history'
                    and st.by_restore and st.deleted_at = now() and not exists (select 1 from history h where h.id = st.id));
    if cardinality(v_rt) > 0 or cardinality(v_rl) > 0 then
      insert into backup_scrub_queue (username, task_ids, log_ids) values (v_username, v_rt, v_rl);
      perform public._drain_backup_scrubs(v_username);
    end if;
  end if;
  -- The clock at the restore's end (review round 8): intents queued while it ran are voided too.
  update settings set value = to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), updated_at = now()
   where device_id = v_username and key = 'last_restore_at';
  return json_build_object('ok', true, 'tasks_restored', v_tasks, 'history_restored', v_history, 'favorites_restored', v_favorites);
end $function$
;

CREATE OR REPLACE FUNCTION public.snapshot_my_data_phase2(p_session_token text, p_type text, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_username text;
  v_id uuid := gen_random_uuid();
  v_tasks  jsonb;
  v_hist   jsonb;
  v_set    jsonb;
  v_fav    jsonb;
  v_ct     int;
  v_ch     int;
BEGIN
  v_username := (proxima_auth.current_account(p_session_token)).scope;
  IF v_username IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF coalesce(p_type, '') LIKE 'pre-%' AND NOT public._auto_backups_on() THEN
    RETURN json_build_object('ok', true, 'skipped', true);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    INTO v_tasks
    FROM (SELECT * FROM tasks WHERE device_id = v_username ORDER BY start_time DESC LIMIT 500) t;
  SELECT COALESCE(jsonb_agg(row_to_json(h)), '[]'::jsonb)
    INTO v_hist
    FROM (SELECT * FROM history WHERE device_id = v_username ORDER BY timestamp DESC LIMIT 1000) h;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_set
    FROM settings WHERE device_id = v_username AND key NOT LIKE 'form-inputs:%';
  SELECT COALESCE(jsonb_agg(row_to_json(f)), '[]'::jsonb)
    INTO v_fav
    FROM (SELECT * FROM favorites WHERE device_id = v_username) f;   -- aliased now

  SELECT count(*) INTO v_ct FROM tasks WHERE device_id = v_username;
  SELECT count(*) INTO v_ch FROM history WHERE device_id = v_username;

  INSERT INTO data_backups (
    id, username, backup_type, task_count, history_count,
    settings_snapshot, favorites_snapshot, tasks_snapshot, history_snapshot, note
  ) VALUES (
    v_id, v_username, p_type, v_ct, v_ch,
    v_set, v_fav, v_tasks, v_hist, p_note
  );

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$function$
;

-- ── 6. Grants (§2): every new function revoked from public, anon, authenticated, service_role (the public default ACL
--      grants anon/authenticated/service_role directly); only the new unlock is given back, to anon, authenticated and
--      service_role, exactly like verify_admin (review #6). create or replace kept every rewritten function's ACL.
revoke execute on function proxima_auth.current_account(text) from public, anon, authenticated, service_role;
revoke execute on function proxima_auth.issue_session(uuid) from public, anon, authenticated, service_role;
revoke execute on function proxima_auth.mint_token(uuid) from public, anon, authenticated, service_role;
revoke execute on function proxima_auth._revoke_sessions(uuid) from public, anon, authenticated, service_role;
revoke execute on function proxima_auth._reauth(uuid,text) from public, anon, authenticated, service_role;
revoke execute on function proxima_auth._throttle(text,boolean) from public, anon, authenticated, service_role;
revoke execute on function public.unlock_with_backup_code(text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.unlock_with_backup_code(text,text,text) to anon, authenticated, service_role;
-- The frozen guard (§2) is owner-only too: its triggers fire without any EXECUTE grant.
revoke execute on function proxima_auth.m1_frozen_guard() from public, anon, authenticated, service_role;
