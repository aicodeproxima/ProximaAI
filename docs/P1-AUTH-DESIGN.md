# P1 design: accounts table and per-account sign-in (draft 2026-10-22, revised 2026-10-23)

Status: DESIGN, nothing built or applied. Scope: Phase 1 of docs/MULTI-USER-PLAN.md (§5 P1), under the owner's rulings
of 2026-10-23 (§6). Agreed boundary with the RLS session: P1 owns `proxima_auth.users` (with its `scope` column) and
`proxima_auth.current_account(token)`. The RLS session owns `proxima_auth.session_scope`, `sync_topic`/`ping_sync` and
the policies, and ships session_scope's dual-format change as its own migration (M2 below). `api/ws-proxy.ts` is being
handed over from the webhook session (pending). `api/ws-webhook.ts` is not ours.

Measured 2026-10-22 from the catalog (`pg_get_functiondef` via `scripts/tools/sb-query.mjs`, read-only) and from the
code. No secret value was selected: app_secrets was read for key names, JSON field names and `updated_at` only.

## Review round 1 (2026-10-23)
Three critics, 25 findings, all accepted. Where a finding offered options, the chosen one is written below.

| # | Change | Section(s) |
|---|---|---|
| 1 | A locked account or a running backup pause answers the generic `invalid` without checking the secret (dummy bcrypt, counted on the IP); `_reauth` keeps locked-first | §4, §6, §9.1 cases 5, 18 |
| 2 | Header probe needs two more passes (two real networks → different keys; forged `cf-connecting-ip` ignored); `xff-first` dropped; runtime guard falls back to `observe` | §2, §6 |
| 3 | IP parsed with `::inet` (bad value = no IP); IPv6 keyed by its /64; row budget, then `observe` | §2, §6, §9.1 case 15 |
| 4 | unlock always runs one bcrypt (row code or dummy); disabled and deleted rows count as unknown and are never changed | §4, §6, §9.1 cases 4, 7 |
| 5 | New functions revoke from public, anon, authenticated, service_role; all helpers in proxima_auth; wider gate | §2, §9.2 |
| 6 | get/set_auto_backups owner-only (42501); get_my_account gives non-owners `sync_topic = null` until P4 | §4, §9.1 cases 1, 2 |
| 7 | Throttle key is its own random `throttle_key`, hashed over an inet-cast value only | §2, §6 |
| 8 | The verifier fails closed: any subject other than `u:`/`admin:` → `malformed session token`; M4 keeps an explicit `revoked` branch | §3, §9.3 |
| 9, 17 | From M1, owner `admin:` tokens use issue_session's time rule and the `<=` check; seed shifts the epoch by 1 so live tokens survive; M1-only owner case | §2, §3, §4, §7, §9.1 case 21 |
| 10 | `username_taken` answers rate-limited per account (5 per hour, then `rate_limited`) | §2, §4, §5, §9.1 case 16 |
| 11 | M3 opens with a precondition DO block; per-stage expected results | §4, §9.1 |
| 12 | md5 compare-and-swap on M1 apply and rollback; freeze on the touched functions until M4 | §4, §7, §10 |
| 13 | M1 rollback guard; M2's rollback refuses while M3 is live (to agree); proof covers M1 → M2 → M3 and back | §7 |
| 14, 21 | Both rotate scripts read the owner from proxima_auth.users from M1 and mint via mint_token from M3; M4 timed from the latest admin: mint | §1.6, §4, §10 |
| 15 | M1 locks app_secrets before the seed; post-apply equality check; devices idle during the apply | §2, §4 |
| 16 | C0 confirmed in the live bundle (and CACHE_NAME bumped) before M1; both owner devices on the new build before M1b | §4, §5 |
| 18 | Wavespeed read runs as service_role in its own case; anon's lack of EXECUTE asserted | §9.1 case 11 |
| 19 | Catalog gate is semantic and case-insensitive; case 10 adds purge, restore and snapshot | §9.1 case 10, §9.2 |
| 20 | §9.3 adds the epoch bumps in test-rls-phase0/-tables and the counts in test-public-execute | §9.3 |
| 22 | While an IP is blocked the password is still checked; a right password signs in; a wrong one counts on the account as anywhere (main-session decision, see §6) | §6, §9.1 case 15, §10 Q2 |
| 23 | `auto_backups` is not a users column in P1 (P4 adds it with a copy at that moment) | §2, §4 |
| 24 | M1 rollback copies `last_verified_at` back; the proof calls set_my_account | §7 |
| 25 | Owner row snapshot unchanged; backup pause per account; topic shared until P4 stated | §4, §9.1 cases 18, 20, §10 |

## 1. Inventory

### 1.1 Counts
- **32 SQL functions** parse or verify tokens, or read app_secrets' account rows: 30 in `public` and 2 in `proxima_auth`
  (session_scope, sync_topic). Two more reach those rows indirectly: `proxima_auth.ping_sync`, which calls sync_topic,
  and the triggers and cron jobs listed in §1.4.
- **24 `'admin:'` literals in 23 functions**: 22 in `public` (rename_my_account has 2) and 1 in
  `proxima_auth.session_scope`. 21 of the 23 are executable by `anon`. That is the "21" in the plan. The other two,
  `_verify_session_token` and `get_my_wavespeed_key`, are not executable by anon.
- **13 functions read `admin_*` app_secrets rows.** Two more read `auto_backups`: `_auto_backups_on` and
  `set_auto_backups`.
- **7 functions treat a non-`admin:` subject as the scope itself**: list_my_backups_phase2, delete_my_backup_phase2,
  purge_my_backups_of, restore_my_backup_phase2, snapshot_my_data_phase2, get_my_wavespeed_key and set_my_wavespeed_key.
  The spelling varies: `else v_subject` (3), `ELSE v_subject END` (2) and `ELSE` + newline + `v_device_id := v_subject;`
  (2). Under a `u:<uuid>` token, each of these would silently work on scope `'u:<uuid>'`. That is the biggest ordering
  hazard in P1: M1 must land before M3.
- **2 functions accept any verified token with no account check**: get_auto_backups and set_auto_backups.
- **app_secrets holds 10 keys**:
  - admin_backup_attempts{failed}
  - admin_backup_code_hash{hash}
  - admin_email{email}
  - admin_email_verified{verified}
  - admin_login_lockout{failed,locked}
  - admin_password_hash{password_hash}
  - admin_sessions_valid_after{at}
  - admin_username{username}
  - auto_backups{enabled}
  - session_signing_key{key,created_at}

  Three keys that the functions still read do not exist: admin_last_verified_at, admin_password_hash_legacy_sha256 and
  session_signing_key_previous. So the legacy sha256 branch is dead code.
- **Default ACL (checked 2026-10-22):** `pg_default_acl` for role postgres in schema `public` grants EXECUTE on every new
  function directly to anon, authenticated and service_role. `revoke … from public` does not remove those grants.
  `proxima_auth` has no default ACL.

### 1.2 SQL functions (name → what it does with tokens or admin rows)
| Function | Literal | Reads | Today |
|---|---|---|---|
| `public._sign_session_token(subject, expires)` | 0 | session_signing_key | Returns `subject.exp.hex(hmac_sha256(subject.exp, key))`. Format-agnostic. Stays. |
| `public._verify_session_token(token)` | 1 | session_signing_key(_previous), admin_username, admin_sessions_valid_after | Checks 3 parts, exp ≥ now, the HMAC (current then previous key). For `admin:%` only: name = admin_username, else `session token revoked`; `exp-43200 < valid_after` → revoked. Returns the subject. **Any other subject passes unchecked.** All raises use the default SQLSTATE P0001. |
| `proxima_auth.session_scope(required)` (RLS) | 1 | via _verify | Reads header `x-proxima-session` and returns `'user:'||name`; a non-admin subject → 28000 `not admin-scoped`. |
| `proxima_auth.sync_topic()` (RLS) | 0 | admin_username, admin_sessions_valid_after, signing key | One global topic. Called by `ping_sync` (6 triggers) and get_my_account. |
| `public.verify_admin(username, password)` | 1 | admin_username, admin_password_hash(_legacy), admin_login_lockout (FOR UPDATE) | Single global lockout row; answers `locked` before it checks the password; mints `admin:<name>`, 12 h. Answers invalid+attempts_left / locked / not_provisioned. |
| `public.unlock_admin_with_backup_code(code, new_pw)` | 0 | admin_backup_code_hash, admin_backup_attempts, admin_login_lockout, admin_password_hash | No username. Answers `backup_locked` before it checks the code. 5 wrong codes → 15-min pause. Revokes all sessions. |
| `public._reauth_admin(password)` | 0 | admin_password_hash, admin_login_lockout | Shared by the three password-checked RPCs; refuses a locked account before crypt; counts toward the global lockout. |
| `public._revoke_admin_sessions()` | 0 | admin_sessions_valid_after | Global epoch = now. |
| `public.change_my_password` | 1 | admin_password_hash | Re-auth, new bcrypt(12), global revoke, new admin token. |
| `public.rename_my_account` | 2 | admin_username | Re-auth, marker lock, moves 8 tables' rows (proxima.rescope), new admin token. |
| `public.set_admin_backup_code` | 1 | admin_backup_code_hash, admin_backup_attempts | Re-auth, new code hash. |
| `public.set_admin_credentials_rehash` | 1 | admin_password_hash(_legacy) | Dead in practice (no legacy row). |
| `public.get_my_account` | 1 | admin_username/email/email_verified/last_verified_at, backup code, password hash | Returns username, email, flags, sync_topic. |
| `public.set_my_account` | 1 | admin_email, _verified, _last_verified_at | Upserts the global rows. |
| `public.get_my_wavespeed_key` (service_role only) | 1 | user_secrets | Fall-through scope. Called by api/ws-proxy.ts. |
| `public.set_my_wavespeed_key` | 1 | user_secrets | Fall-through scope. |
| `public.get_auto_backups` / `set_auto_backups` | 0 | auto_backups | Any verified token. set(false) queues a scrub for **every** username in data_backups. |
| `public._auto_backups_on()` | 0 | auto_backups | Called by create_auto_backup (cron), restore, snapshot, 3 scrub triggers. |
| `public._rows_keep_owner()` (trigger on tasks/history/favorites) | 0 | admin_username | Lets device_id move only to `'user:'||admin_username` or under proxima.rescope. |
| scope users: clear_queued_rows, delete_queued_rows, generations_live, paths_in_use, reset_queued_rows, upsert_queued_history, server_time_ms | 1 each | — | `if v_subject not like 'admin:%'` → 42501/forbidden; `v_user := 'user:'||substring(v_subject from 7)`; re-check `public._verify_session_token(p_session_token)` after the marker lock. |
| fall-through: list/delete/purge/restore/snapshot backups | 1 each | — | `case when like 'admin:%' then 'user:'||… else v_subject end` (spellings vary, §1.1). |

### 1.3 Token format and verification today
- Format: `'<subject>.<exp>.<sig>'`. The subject is `admin:<username>`. exp is unix seconds, and every minting site sets
  it to now + 12 h, so the issue time is `exp - 43200`. sig is `hex(hmac_sha256('<subject>.<exp>', session_signing_key))`.
- The same key is held twice: app_secrets `session_signing_key` and Vercel env `SESSION_SIGNING_KEY`. During a rotation,
  `SESSION_SIGNING_KEY_PREVIOUS` covers the 12 h grace.
- Revocation is two global facts: the name equals admin_username, and the issue time is ≥ admin_sessions_valid_after.
  Expiry is the only other limit. Tokens are not stored server-side.
- Today a revoke sets `at` to `now()` and the replacement token is minted with the same `now()`, so the token a device
  receives after a password change has issue time **equal** to `at` (it survives the strict `<` rule).

### 1.4 Triggers and cron that reach the account rows
- **Triggers:**
  - `tasks_keep_owner`, `history_keep_owner` and `favorites_keep_owner` run `_rows_keep_owner`, which reads
    admin_username.
  - `{tasks,history}_sync_ping_{ins,upd,del}` (6 triggers) run `ping_sync`, which calls `sync_topic`.
  - `tasks_queue_backup_scrub`, `history_queue_backup_scrub` and `history_queue_item_scrub` call `_auto_backups_on`.
- **Cron:** none of the 3 jobs reads admin_* directly.
  - `auto-backup-2day` runs `create_auto_backup`, which calls `_auto_backups_on` (auto_backups).
  - `backup-scrub-drain` (`_drain_backup_scrubs`) and `ws-webhook-sweep` (`ws_webhook_sweep`) read no account row.
  - P1 does not change any cron job (cron fairness is P4).

### 1.5 Client (builds, stores or parses the token, username or scope)
- `src/lib/session.js`
  - :7-8: keys `proximaai-session` (token, expires_at, username) and `proximaai-user`. The second drives the scope.
  - :10-20: `getSession`/`sessionToken`. These check `expires_at` only and never parse the token.
  - :30-52: `withSessionHeader` adds `x-proxima-session` to /rest/v1 and /storage/v1.
  - :54-63: `setSession` and `clearSession`.
  - :66: the `SESSION_ERROR` regex matches the server's message strings: invalid session token, malformed, expired,
    revoked, invalid signature, not admin-scoped.
- `src/lib/supabase.js`
  - :46-67: `getDeviceId()` builds the scope as `` `user:${localStorage['proximaai-user']} ``.
  - :70: `resetDeviceIdCache`.
  - :84-86: header `x-device-id` plus the fetch wrapper chain.
  - :592, :617 and :653: Storage folders are derived from getDeviceId (`user_<name>/…`, `uploads/user_<name>/…`).
  - :629: `sessionRpc`. On an `isSessionError`, it signs out unless the token was already superseded.
  - :802-812: `signIn` calls verify_admin, plus a legacy rehash call.
  - :814-820: `unlockWithBackupCode(code, newPassword)` sends no username.
  - :824-834: `checkSession`/`getMyAccount` read get_my_account and set the topic.
  - :837-861: set_my_account, change_my_password, rename_my_account, set_admin_backup_code and set_my_wavespeed_key.
- `src/App.jsx`
  - :39 `backupCodeError` shows attempts_left.
  - :52 `LoginScreen`. :70 `handleSignIn` shows `attempts_left` and switches to unlock on `locked`. :88
    `handleBackupCode` (no username).
  - :350 `accountError`. :366 `AccountModal`. :390 shows username/email from get_my_account.
  - :460 `submitNewUsername` calls setSession with the new name, resets the cache and reloads.
  - :480 `submitNewPassword`. :526 reset with backup code (no username).
  - :587, :660 and :695 show the username. :1639 `handleSignedIn`. :1657 `signOutLocal`.
  - :4548 shows `proximaai-user`.
- **No client code parses the token text.** `scripts/verify-hmac.mjs:26` (a dev tool) does.

### 1.6 Proxy, scripts and Vercel env
- `api/ws-proxy.ts:85-105` `verifySessionToken` checks the 3 parts, exp and an HMAC against `SESSION_SIGNING_KEY`, then
  `SESSION_SIGNING_KEY_PREVIOUS` (:94). It accepts **any subject**: it is format-agnostic.
- :115-145 `getUserWaveSpeedKey` calls `rpc/get_my_wavespeed_key` with the service role. That re-verifies the token and
  applies revocation in the DB. The body regex `/session token|invalid signature|malformed/` maps to a 401 session
  answer.
- :172-180 `checkRateLimit(subject)` keys the limiter by the raw subject. It is OFF in production (no Upstash).
- :210-220: the handler takes `x-proxima-session` or `Authorization: Bearer`.
- Other places that read the owner from app_secrets, or mint or assume `admin:`:
  - `scripts/tools/rotate-signing-key.mjs:85` reads app_secrets `admin_username` and `admin_sessions_valid_after`
    (preflight and its revocation hint); `:87` mints `'admin:'+name` probe tokens;
  - `scripts/tools/rotate-service-key.mjs:146` (`mintSession`, **owned by the RLS session**) mints
    `_sign_session_token('admin:' || app_secrets.admin_username, now() + 12 h 2 min)` for its live proxy checks;
  - `scripts/smoke-ws-proxy.mjs:13` uses `admin:test`, which is local only and format-agnostic;
  - 14 SQL suites (§9.3).

  From M1 the app_secrets account rows are frozen (§2), so after any rename during P1 both rotate scripts would mint
  `admin:<old name>`, which M1's verifier revokes. Both change in the M1 commit (§4 step 1).

## 2. Schema

```sql
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
  sessions_valid_after bigint not null default 0,                     -- epoch seconds; tokens issued at or before it are revoked (§3)
  login_failed         int not null default 0,
  login_locked_at      timestamptz,                                   -- not null = locked (3-try rule)
  backup_failed        int not null default 0,
  backup_locked_until  timestamptz,                                   -- 5 wrong codes → 15 min
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
-- No auto_backups column in P1: app_secrets stays the only copy. P4 adds the column, copied from app_secrets at that
-- moment, when it makes the switch per account.
create unique index users_username_ci on proxima_auth.users (lower(username));   -- not partial: in P1 a freed name
                                                                                 -- would inherit 'user:<name>' rows
create unique index users_scope_key   on proxima_auth.users (scope);
create unique index users_one_owner   on proxima_auth.users ((true)) where role = 'owner';

create table proxima_auth.auth_config (                -- one row, read without locks
  id boolean primary key default true check (id),
  signin_throttle text not null default 'observe' check (signin_throttle in ('off','observe','on')),
  throttle_max_failures int not null default 10,
  throttle_window interval not null default '15 minutes',
  ip_source text not null default 'cf-connecting-ip' check (ip_source in ('cf-connecting-ip','xff-last')),
  throttle_key text not null default encode(extensions.gen_random_bytes(32), 'hex'),  -- throttle only; never signs
  throttle_guard_names int not null default 50,        -- distinct names failing from one key in a window → observe
  throttle_max_rows int not null default 10000,        -- row budget for signin_throttle → observe
  gateway_ips inet[] not null default '{}',            -- known gateway hops (from the probe); a key on one → observe
  dummy_hash text not null                             -- bcrypt(12) of a random string, for equal timing
);
create table proxima_auth.signin_throttle (
  ip_key text primary key,                              -- hex hmac_sha256(network text, throttle_key); never the raw IP
  window_start timestamptz not null, failures int not null, blocked_until timestamptz,
  name_keys text[] not null default '{}'                -- short hmacs of the failing names, capped at guard+1 entries
);
create type proxima_auth.account as (id uuid, username text, role text, scope text);
```

- **Grants.** There is no browser access to the tables. `revoke all on proxima_auth.users, auth_config,
  signin_throttle from public, anon, authenticated, service_role;` plus `alter table … enable row level security` with no
  policies, as a belt. proxima_auth keeps `USAGE` for anon/authenticated, because the policies need session_scope. That
  is why the tables carry the explicit revokes.
- **Function grants.** Every new function gets `revoke execute … from public, anon, authenticated, service_role`, then
  grants back only what it needs: a revoke from PUBLIC alone leaves the default ACL's direct grants in `public` (§1.1).
  All helpers live in `proxima_auth`, which has no default ACL: current_account, issue_session, mint_token, `_reauth`,
  `_revoke_sessions` and the throttle helper `_throttle`. The only new `public` function is unlock_with_backup_code,
  granted back to anon and authenticated (like verify_admin). current_account, issue_session and mint_token stay
  executable by postgres only; session_scope runs current_account as definer. `create or replace` on an existing
  function keeps its ACL, so the rewritten functions keep today's grants.
- **Seed (owner row only)**, in M1, from app_secrets. M1 first takes `lock table public.app_secrets in share row
  exclusive mode`, so no old-code sign-in, unlock or password change can commit into the account rows between the seed
  read and M1's commit. The owner row gets:
  - username;
  - `scope = 'user:'||username`;
  - role `owner`;
  - password_hash, backup_code_hash, email, email_verified and last_verified_at (null: the row doesn't exist);
  - `sessions_valid_after = admin_sessions_valid_after.at - 1`. Today's rule revokes when `issued < at`; P1's rule
    revokes when `issued <= sessions_valid_after` (§3). For whole seconds these are the same test, so the token a device
    got from its last password change (issued = at, §1.3) stays valid;
  - `login_failed`/`login_locked_at` from admin_login_lockout (`locked` → `coalesce(locked_at, now())`);
  - backup_failed/backup_locked_until from admin_backup_attempts.

  M1 aborts unless all of these hold:
  - exactly one row was inserted;
  - its `password_hash like '$2%'`;
  - `scope = 'user:'||username`;
  - 0 tasks/history/sync_tombstones/user_secrets/data_backups rows lie outside that scope (measured 2026-10-22: 0;
    settings has 1 legacy non-`user:` device row, which is left alone);
  - `count(*) = 1 where role='owner'`.

  Every live `admin:` token stays valid (R5).
- **Post-apply check** (right after M1 commits, read-only): the frozen app_secrets hash, code hash, epoch (`at - 1`) and
  counters still equal the owner row. A call that was already running old code when M1 took the lock can still write
  the frozen rows after the commit. If they differ, re-copy the changed fields from app_secrets into the owner row
  (one `--write` statement, prepared with M1).
- **What stays in app_secrets for rollback:** all 10 rows, untouched by P1 at run time:
  - admin_username, admin_password_hash, admin_backup_code_hash, admin_email(_verified), admin_sessions_valid_after,
    admin_login_lockout and admin_backup_attempts are frozen at M1;
  - auto_backups stays authoritative and the only copy (P4 moves it);
  - session_signing_key stays the signing key.

  The rollback copies the owner row back into the frozen rows (§7), so nothing changed during P1 is lost. The rows
  retire in P5.

## 3. Token format and verification
- **New:** `'u:<uuid>.<exp>.<sig>'`. **Legacy:** `'admin:<name>.<exp>.<sig>'`. The signature, the key, the header and
  the proxy check are all unchanged. A `u:` subject never contains `.`, `:` after the prefix, or a name. That keeps it
  stable across renames, and the proxy's rate-limit key becomes per account for free.
- **Verification**, in `public._verify_session_token`, keeps its signature and messages, because session_scope and
  every re-check after a marker lock call it.
  - It checks the parts, exp, and the HMAC against the current and previous keys, as today.
  - `u:%`: the subject must parse as a uuid (else `malformed session token`). The row must exist with `deleted_at` and
    `disabled_at` null, and the issue time `exp - 43200` must be **greater than** `sessions_valid_after`. Otherwise it
    raises `session token revoked`.
  - `admin:%` (dual window only): the owner row must have `username = substring(subject from 7)`, compared exactly as
    today, and the same rule as `u:`: `exp - 43200 <= sessions_valid_after` → revoked. The seed's `at - 1` (§2) makes
    this the same test as today's strict rule for every token alive at M1.
  - **Any other subject** (for example `user:x`): `malformed session token`. The verifier fails closed from M1, so no
    future caller inherits an unchecked subject. The message matches the client's SESSION_ERROR regex and the proxy's
    401 regex.
- **`proxima_auth.current_account(p_token) returns proxima_auth.account`** (definer, `search_path ''`, STABLE) calls
  `public._verify_session_token`, then resolves:
  - `u:` → the row by id;
  - `admin:` → the owner row;
  - anything else cannot arrive (the verifier raised).

  It returns (id, username, role, scope). It is the one helper that replaces every `'admin:'` literal.
- **Epoch per account, with issue-time ordering** (fixes today's same-second gap for every account, the owner included,
  from M1):
  - `_revoke_sessions(account)`: `sessions_valid_after := greatest(extract(epoch from clock_timestamp())::bigint,
    sessions_valid_after + 1)`.
  - `issue_session(account)`: `issued := greatest(clock_seconds, sessions_valid_after + 1)` and `exp := issued + 43200`.
    It returns `{token, expires_at, username, account_id, role, scope}`. `mint_token(account)` returns just the token,
    for tests and the rotate scripts.
  - **Subject:** until M3, issue_session signs `'admin:'||username` for the owner and `'u:'||id` for any other role
    (members exist only as test fixtures before P5). M3 rewrites issue_session to sign `'u:'||id` for every role. Every
    token-minting RPC (verify_admin, change_my_password, rename_my_account, both unlocks) calls issue_session from M1,
    so the owner's `admin:` tokens already follow the time rule, and a replacement token is never born revoked even
    when a bcrypt pushes `clock_timestamp()` into the next second.
  - Every newly issued token is therefore strictly newer than the epoch, and every token issued before a bump (even in
    the same second) is revoked. The epoch can run a few seconds ahead of the clock during bursts, which only lengthens
    those tokens' life by seconds.
- **Revocation (per account only):**
  - a password change, a backup-code unlock, and a rename (in P1, to keep today's sign-out of the other devices until
    P2/P3 take the scope from the server) bump that row's epoch;
  - `disabled_at` or `deleted_at` stops the tokens at once;
  - no event touches another account's row.
- **The dual-accept window:**
  - From M1, both formats verify.
  - From M3, nothing mints `admin:` any more. The catalog gate in §9.2 asserts that no function body matches
    `(?i)'admin:'\s*\|\|`.
  - Every `admin:` token alive at M3 expires within 12 h, and so does any probe a rotate script minted before it.
  - M4, applied ≥ 12 h 05 min after the **latest** of: the last M3 apply (counting any rollback and re-apply), and the
    last `admin:` token minted by a script. It replaces the `admin:` branch in `_verify_session_token` with an explicit
    `raise exception 'session token revoked'` (not a deletion, which would make it fall into `malformed`), and removes
    it from current_account. The RLS session removes it from session_scope at the same time.
  - After M4, an `admin:` token fails with `session token revoked`, which the client and proxy already treat as a
    sign-out. Nobody holds one by then.

## 4. Function-by-function changes (all in M1 unless marked)
In general, `v_acc := proxima_auth.current_account(p_session_token)`. A NULL id means "not an account": the function
keeps the refusal it gives today (42501 `forbidden`, or `{ok:false, reason:'forbidden'}`), and the 7 fall-through
functions now refuse too. `v_user := v_acc.scope`. The re-check after the marker lock stays the literal
`perform public._verify_session_token(p_session_token);` (test-queued-deletes-db.sql case 6 checks that text), followed
by `if (proxima_auth.current_account(p_session_token)).scope is distinct from v_user then raise 'session token
revoked'`.

**Sign-in answers are generic.** A disabled or deleted row counts as unknown everywhere a name is typed, and P1 never
writes to a disabled or deleted row from a sign-in or unlock. Every attempt runs exactly one bcrypt: against the row's
hash when the row is live and its secret is checked, otherwise against `auth_config.dummy_hash`.

| Function | P1 behaviour |
|---|---|
| `_verify_session_token` | As in §3. Its existing messages are unchanged; unknown subjects now get `malformed session token`. |
| `verify_admin(username, password)` | IP throttle first (§6). The row is found by `lower(username)` and locked FOR UPDATE (lock order: IP row → account row). **Unknown, disabled or deleted name:** `crypt(p, dummy_hash)`, answer `{ok:false, reason:'invalid'}`. **Locked account:** the password is **not** checked; dummy bcrypt for equal timing; the attempt counts on the IP throttle; answer `invalid`, byte-identical to a wrong password. **Wrong password:** counts on the account (3 → locked) unless the IP is blocked (§6); answer `invalid`, no attempts_left. **Right password:** counters reset; `issue_session`; returns `{ok, token, expires_at, username, account_id, role, scope}`. The token is `admin:` for the owner until M3 (§3). The legacy sha256 branch and `not_provisioned` are removed. |
| `unlock_with_backup_code(username, code, new_pw)` **new** | Throttle, then the row by `lower(username)`, FOR UPDATE. **Unknown, disabled or deleted name, or no code on the row:** dummy bcrypt, answer `invalid`. **Pause running** (`backup_locked_until > now()`): the code is **not** checked; dummy bcrypt; counted on the IP; answer `invalid`, byte-identical to a wrong code. **Wrong code:** per-row counter (5 wrong → 15-min pause), answer `invalid` (no attempts_left, no retry_after). **Right code:** login and backup counters reset, the optional new bcrypt(12) password is stored, **this account's** epoch is bumped, and a fresh token comes from issue_session. |
| `unlock_admin_with_backup_code(code, new_pw)` (old) | Kept for stale service-worker bundles and for rollback. It maps to the owner row only, with the same body as the new one (so it also answers `invalid` during a pause). Dropped at M4 once edge logs show 0 calls for 24 h; otherwise in P5. |
| `_reauth_admin(pw)` → `proxima_auth._reauth(account, pw)` | Keeps today's order: a locked account is refused (`locked`) **before** crypt. Otherwise per-row counting, same rule (3 → locked). The caller already holds the account's token, so `locked` reveals nothing new. Not browser-callable. |
| `_revoke_admin_sessions()` → `proxima_auth._revoke_sessions(account)` | Per-row epoch, as in §3. |
| `change_my_password` | The account comes from the token; `_reauth(account)`; a new hash on that row; `_revoke_sessions(account)`; a fresh token for this device from `issue_session` (so the owner's `admin:` token is never born revoked). |
| `rename_my_account` | Validation as today. **Rate limit first:** once the account has had 5 `username_taken` answers in the current hour (`rename_taken_count`, `rename_taken_since`), every rename attempt answers `rate_limited` until the hour ends. `username_taken` if `lower(new)` is used by another row, or if any row of any of the 8 tables already sits in `'user:'||new` (no inheriting orphan rows); each such answer adds 1 and raises a LOG line with the opaque account id only. Lock order: users row → restore marker → tables (marker before `update tasks`, as test-queued-deletes case 5 requires). It updates `username` and `scope` together (the CHECK keeps them in step), runs today's 8-table rescope, bumps the epoch, and returns a fresh token from `issue_session`. |
| `set_admin_backup_code` | Per row: code hash, `backup_failed = 0`, `backup_locked_until = null`. |
| `set_admin_credentials_rehash` | Account check, then always `not_legacy` (no legacy row exists). Dropped at M4. |
| `get_my_account` | Adds `id`, `role` and `scope`. username, email, email_verified, last_verified_at and has_backup_code come from the row. `password_is_bcrypt` is true when the hash is set. `sync_topic` comes from `proxima_auth.sync_topic()` (RLS) **for the owner only**; any other role gets `sync_topic = null` until P4 makes topics per account. In P1 there is one topic and it is the owner's. |
| `set_my_account` | Writes the row's email, email_verified and last_verified_at. |
| `get_my_wavespeed_key` / `set_my_wavespeed_key` | `device_id = v_acc.scope`. Not an account → 42501. This fixes the `u:` fall-through. get stays service_role-only. |
| `get_auto_backups` / `set_auto_backups` | **Owner only** until P4: `v_acc.role = 'owner'`, anything else → 42501 `forbidden` (they accepted any token before). They still read and write the global app_secrets `auto_backups`. |
| clear_queued_rows, delete_queued_rows, generations_live, paths_in_use, reset_queued_rows, upsert_queued_history, server_time_ms | Literal replaced by current_account. Scope from `v_acc.scope`. Refusal codes unchanged. |
| list/delete/purge/restore/snapshot backup RPCs | Same, and the fall-through to the subject is removed in every spelling. |
| `_rows_keep_owner` (trigger) | `v_live := (select scope from proxima_auth.users where role='owner')`. Identical in P1; P4 (RLS) generalizes it. |
| `session_scope` (**M2, RLS session**) | Dual format via current_account. Keeps the `not admin-scoped` message for non-account subjects (test-rls-* expect it). |
| `sync_topic` (**M2, RLS session**) | Reads the owner row's username and epoch instead of app_secrets. It hashes `sessions_valid_after + 1`, which equals app_secrets' `at` at the switch (§2), so the topic string is identical and no device loses pings (to agree with the RLS session). If M2 slips, the topic just stops rotating on a password change (harmless). P4 makes it per account. |
| `issue_session` (**M3**) | The only function M3 rewrites: it signs `'u:'||id` for every role. |

### Migration order (versions above 20261022350000; placeholders)
0. **C0, client** (before M1; works with both servers): the tolerant sign-in texts (§5). Before M1 is applied, confirm
   C0 is live: `curl -sL <url>/assets/index-*.js` contains the new hint text, and `CACHE_NAME` in `sw.js` was bumped in
   that deploy.
1. **M1 `2026102300xx10_mu_p1_accounts.sql`**:
   - **compare-and-swap:** the file records the md5 of `pg_get_functiondef` for every function it replaces (captured
     when M1 is authored) and aborts if any live md5 differs; the author then re-captures and re-reviews;
   - locks app_secrets, creates the schema objects in §2 and seeds the owner;
   - adds current_account, issue_session, mint_token, `_reauth`, `_revoke_sessions`, `_throttle` (all in proxima_auth)
     and public.unlock_with_backup_code, with the §2 grants;
   - rewrites every function in the table above except the M2/M3 rows;
   - sets the throttle to `observe`.

   The owner still gets `admin:` tokens. Rollback file: `supabase/rollback/2026102300xx10_mu_p1_accounts.rollback.sql`,
   which records M1's post-apply md5 set (§7). **Apply checklist:** C0 confirmed live; both owner devices idle and off
   the Account screen; post-apply check (§2) run right after.
   **Freeze:** from M1 authoring until M4, the ~30 functions M1 replaces are frozen. Announced by message to the RLS
   and webhook sessions: any change to them in that period goes through P1's files.
2. **Same commit as M1:**
   - suite fixture edits (§9.3); the test-rls-* edits are the RLS session's, by message;
   - `scripts/tools/rotate-signing-key.mjs:85/87` reads the owner from `proxima_auth.users where role='owner'`
     (username, id, sessions_valid_after), falling back to app_secrets only if the table does not exist (after a
     rollback). Its revocation hint reads `sessions_valid_after` (tokens issued at or before it are revoked);
   - the same change to `scripts/tools/rotate-service-key.mjs:146`, which belongs to the RLS session: agreed and made by
     message;
   - both scripts dry-check that their minted probe passes `_verify_session_token` before using it.
3. **M1b `2026102300xx15_mu_p1_throttle_on.sql`**, after the header probe passes (§6) and both owner devices show the
   new build (no yellow stale banner; reload them otherwise): sets `signin_throttle='on'`, `ip_source` and
   `gateway_ips`.
4. **M2 `2026102300xx20_…` (RLS session):** session_scope dual format plus the sync_topic switch. It must land after M1
   and before M3. Its rollback refuses while M3 is live (to agree with the RLS session; §7).
5. **C1, client** (after M1): unlock with username (§5).
6. **Proxy-1** (only once ws-proxy.ts is handed over; optional before M3, must accept both formats): a subject shape
   guard (§5).
7. **M3 `2026102300xx30_mu_p1_mint_u_tokens.sql`.** It opens with a DO block that aborts unless:
   - (a) a `u:` token from `proxima_auth.mint_token(owner id)`, placed in `request.headers` as `x-proxima-session`,
     makes `proxima_auth.session_scope(true)` return the owner's scope, and `proxima_auth.sync_topic`'s body reads
     `proxima_auth.users` (so M2 is live);
   - (b) the §9.2 catalog gates pass inside the migration (no fall-through spelling, no `'admin:'` outside
     `_verify_session_token`, current_account, session_scope and issue_session);
   - (c) every function M1 rewrote still has M1's post-apply md5.

   Then it rewrites issue_session to mint `u:` for every role. Catalog gate after: nothing matches
   `(?i)'admin:'\s*\|\|`.
8. **Rotate scripts, from M3:** both mint their probe with `proxima_auth.mint_token(owner id)` (a `u:` token), in the
   commit that ships M3 (rotate-service-key by message).
9. **M4 `2026102300xx40_mu_p1_end_dual_accept.sql`**, ≥ 12 h 05 min after the latest of the last M3 apply and the last
   script-minted `admin:` token (§3):
   - replaces the `admin:` branches (explicit `revoked` in the verifier, removed from current_account);
   - drops set_admin_credentials_rehash, and the old unlock if it shows no calls;
   - the RLS session drops its session_scope branch in the same window.

The P1 gate (§9) runs `sql-tx.mjs M1 M2 M3 --test scripts/test-mu-auth.sql` before M1 is applied, then the suite alone
after each live step, checked against the per-stage table in §9.1.

## 5. Client changes and when they ship
- **C0** (before M1; safe against the old and the new server). These lines are in App.jsx:
  - `handleSignIn` (:70): `invalid` without `attempts_left` shows "Wrong username or password. 3 wrong passwords lock
    the account; your backup code unlocks it." `throttled` shows "Too many attempts from this network,
    try again in N min". `locked` is unchanged (only the old server sends it). `not_provisioned` falls into the generic
    text.
  - `backupCodeError` (:39): no `attempts_left` → "Wrong backup code. 5 wrong codes pause unlocking for 15 minutes.";
    `backup_locked` is unchanged (only the old server sends it).
  - `accountError` (:350): re-auth still answers `invalid`/`locked` for the signed-in account; adds `rate_limited` →
    "Too many name checks. Try again in an hour."
- **C1** (after M1):
  - `unlockWithBackupCode(username, code, newPassword)` (supabase.js:814) calls `unlock_with_backup_code`. On PGRST202
    (function missing, i.e. after a rollback) it falls back to the old RPC.
  - LoginScreen's unlock/reset modes keep the typed username, which already lives in that component's state, and show
    it.
  - AccountModal's reset (:526) passes `creds.username`.
  - `setSession` may also keep `account_id`/`role`/`scope` from the sign-in answer. That is stored only; P2 consumes it.
- **No client change for M3 or M4.** The token is opaque to the browser. `getDeviceId()` keeps building
  `'user:'+username`, which still equals the server scope through P1/P2 by the CHECK constraint. The session.js
  `SESSION_ERROR` regex stays as is, because the server messages are unchanged. P2 switches the client to the server's
  scope. A null `sync_topic` (members only) means "no live pings", which the client already handles as "no topic".
- **Proxy-1** (api/ws-proxy.ts, after handover; never required for P1):
  - after the HMAC check, accept only `^(admin:[^.:/\s]+|u:[0-9a-f-]{36})$`, and from M4 only `u:`;
  - log only the opaque `u:` id;
  - the rate-limit key stays the subject.

  The proxy needs no key change: Vercel `SESSION_SIGNING_KEY` already signs `u:` tokens.

## 6. Per-IP sign-in throttle
- **Applies to** verify_admin and unlock_with_backup_code: every failed attempt, whether an unknown name, a wrong
  password, a wrong code, or any attempt on a locked account or during a backup pause. Re-auth inside a signed-in
  session does not count, since it is already per account.
- **Key:** the header value is cast with `::inet`; a value that does not cast gives key NULL (as a missing header does).
  IPv4 is keyed by the address, IPv6 by its /64 (`network(set_masklen(ip, 64))`), because one client routinely holds a
  whole /64. The key is `hex(hmac_sha256(host(that network value), auth_config.throttle_key))` in
  `proxima_auth.signin_throttle`. `throttle_key` is random and used for nothing else, so attacker-shaped header text
  can never produce a token signature, and a signing-key rotation does not reset an active block. The raw IP is never
  stored or logged.
- **Rule:** `throttle_max_failures` (10) within `throttle_window` (15 min) blocks the key for one window.
- **While blocked:** the password (or code) **is still checked**, at one bcrypt, within the 3 s timeout:
  - a right password signs in, and the account's counters reset as usual;
  - a wrong password counts on the account exactly as from any other network (the 3-try lock applies), and answers
    `{ok:false, reason:'throttled', retry_after}`, the same for an unknown name, a wrong password and a locked account;
  - the failure also counts on the IP row.

  Main-session decision (2026-10-23, replacing review #22's "never counted on the account"): not counting failures from
  a blocked network protected nothing, because anyone can already lock a known name from any unblocked network with 3
  guesses (Q5), and it opened a gap: once a network was blocked on purpose, one known name could be guessed at bcrypt
  speed with no lock. Counting keeps the 3-try lock as the guessing limit everywhere; the block's job is to slow name
  spraying and to never refuse a right password.
- **A success does not reset the IP counter**, so one valid account cannot launder guesses at others.
- **Rows** are one per key (no global hot row). A stale row (window over 1 day) is deleted opportunistically:
  `limit 20 … for update skip locked`. **Row budget:** when the table holds `throttle_max_rows` (10 000) rows, new keys
  are not inserted; the mode drops to `observe` with a LOG line.
- **Shared-key guard:** each row keeps short hmacs of the names that failed from it in the window (capped at
  `throttle_guard_names + 1`). If one key collects failures for more than `throttle_guard_names` (50) distinct names,
  or the parsed IP is inside one of `auth_config.gateway_ips`, a LOG line is raised and the mode drops to `observe`:
  that key is probably a gateway shared by every caller. In `observe`, failures count on accounts again, so the 3-try
  lockout keeps limiting guesses; a deliberate sprayer of 50 names can switch the block off, but not open guessing.
- **Mode** (`auth_config.signin_throttle`):
  - `off`;
  - `observe`: count, never block;
  - `on`.

  M1 ships `observe`, and M1b turns it `on` after the header probe.
- **IP source.** PostgREST copies the request headers into `request.headers`, but **it is not yet verified** which ones
  arrive or which entry the client can forge. Cloudflare sets `cf-connecting-ip`. In `x-forwarded-for`, Cloudflare
  appends to whatever the client sent, so the left-most entry is client-controlled; `xff-first` is therefore not a legal
  `ip_source`.

  Probe, while in `observe`: each attempt raises a LOG line with only booleans, counts and the first 8 hex of the key
  (`has_cf`, `has_xff`, `xff_entries`, `cast_ok`, `key8`). The owner, or a session given permission, then makes:
  - one normal failed sign-in from the app with a throwaway name, from the S24 on mobile data;
  - one normal failed sign-in from the PC on Wi-Fi;
  - one failed sign-in with a forged `x-forwarded-for: 192.0.2.1` header;
  - one failed sign-in with a forged `cf-connecting-ip: 192.0.2.2` header.

  The probe passes only when all hold:
  - `has_cf` or `has_xff` is true and the value casts;
  - the two real networks give **different** keys (a constant key is a shared bucket);
  - the forged `x-forwarded-for` leaves the key unchanged;
  - the forged `cf-connecting-ip` leaves the key unchanged.

  M1b then records the source (`cf-connecting-ip` preferred; otherwise `xff-last` if the probe shows the gateway appends
  it) and any gateway address the probe exposed in `gateway_ips`.
- **If no usable header arrives:** the key is NULL and that attempt is not IP-throttled. The per-account 3-try lockout
  still applies, and the LOG line counts it. A shared "no-IP" bucket is deliberately not used: one attacker could
  throttle every caller. See open question Q3.

## 7. Rollback and how it is proven exact
- **Order:** M4 → M3 → M2 (RLS) → M1b → M1, each with its own `supabase/rollback/<v>.rollback.sql`.
  - M3's rollback restores issue_session's owner `admin:` path. `u:` tokens stay accepted, because M1 still verifies
    them. Nobody is signed out.
  - **M2's rollback refuses while M3 is live** (to agree with the RLS session): it aborts if
    `proxima_auth.issue_session`'s body has no `'admin:'` (M3 removed it). Rolling M2 back first would restore a
    session_scope that refuses every `u:` token.
- **M1's rollback**, in one transaction:
  0. **Guards.** Abort if any function outside the set this rollback drops or recreates references
     `proxima_auth.users`, `current_account`, `auth_config` or `issue_session` (that is M2 still live, or anything new).
     Abort if any function M1 replaced differs from the post-apply md5 set recorded with M1 (compare-and-swap: someone
     changed it during P1; re-capture before rolling back).
  1. Copy the owner row back into the frozen app_secrets rows:
     - username, password hash, backup code hash, email and email_verified;
     - `admin_last_verified_at = {at: owner.last_verified_at}` when it is not null;
     - `admin_sessions_valid_after = {at: owner.sessions_valid_after + 1}` (the inverse of the seed's `- 1`);
     - admin_login_lockout `{failed, locked}`;
     - admin_backup_attempts `{failed, locked_until}`.

     A password, code, name or email change made during P1 therefore survives.
  2. Recreate every function M1 changed from the **pre-P1 text captured by `pg_get_functiondef` when M1 is authored**
     (the same capture M1's compare-and-swap checked), the same method as the RLS rollbacks. The one deliberate
     difference: `_verify_session_token` gains a single line that refuses `u:%` subjects with `session token revoked`.
     Without it, the old code would pass a `u:` token through unchecked, and the 7 fall-through functions would act on
     scope `'u:<uuid>'`. With it, those devices are signed out once and sign in again with `admin:` tokens.
  3. Drop the new functions, the throttle and auth_config tables, `proxima_auth.account`, and `proxima_auth.users`.
     After the copy-back it holds nothing that app_secrets lacks; members are impossible before P5.
- **Proof** (`scripts/test-mu-p1-rollback-before.sql` + `scripts/test-mu-p1-rollback.sql`, written with M1, plus the RLS
  session's M2 and its rollback). One `sql-tx.mjs` run, all rolled back:
  1. Capture the md5 of `pg_get_functiondef` for every touched function, plus the ACL snapshot.
  2. Apply M1, then M2, then M3.
  3. Mutate as the app would: an owner password change, a rename, 2 wrong passwords, a new backup code, and
     `set_my_account(email, verified, last_verified_at)`.
  4. Apply the rollbacks M3 → M2 → M1. Check on the way that M2's rollback refuses while M3 is live, and that M1's
     rollback refuses while M2 is live (both caught, then the right order is applied).

  It then asserts:
  - every md5 equals the capture, except `_verify_session_token`, which equals the md5 of the documented
    capture-plus-guard text;
  - no P1 object remains;
  - grants are identical;
  - the restored `verify_admin` signs in with the new password under the new name;
  - a token issued before the in-P1 password change is revoked, and the token the change returned is valid;
  - the lockout count reads 2;
  - email, email_verified and last_verified_at read back as set.

  The existing suites then run unchanged against the rolled-back state.

## 8. Concurrency and non-interference notes
- **Sign-ins of different accounts share no lock.** Each takes its IP row, then its own account row.
- **The lock order** extends the plan's: IP throttle row → account row → restore marker → tasks → history → favorites →
  tombstones → backups. Only rename and the password RPCs take the account row, and none of them is called from a
  path that already holds the marker. M1 alone takes app_secrets first (§2), once.
- **Timeouts:** `anon` has `statement_timeout=3s`. Every sign-in or unlock attempt costs exactly one bcrypt(12) of
  about 0.25 s (the row's hash or the dummy, never both, never none), blocked IP included. Contention on one account's
  row only queues that account's own devices.

## 9. Test plan
### 9.1 `scripts/test-mu-auth.sql`
One DO block, harness of test-queued-deletes-db.sql. Inside it, it seeds members `__mu_a`, `__mu_b`, `__mu_c` and a
disabled `__mu_d` (fixed uuids …a1/b1/c1/d1, bcrypt cost 4; C has no backup code) with tasks rows, one backup (holding
`mu-b-1`) and one key for B. It snapshots the real owner row's counters and epoch. Tokens come from
`proxima_auth.mint_token`, and RPCs run as `anon` (get_my_wavespeed_key as `service_role`, as the proxy calls it).
Every case uses its own documentation IP so no case trips another's throttle. Cases:

| # | Label(s) | Asserts |
|---|---|---|
| 0 | seed | users rows, data rows, the owner snapshot and the auth_config switch. |
| 1 | account-shape / topic-owner-only | get_my_account(A) returns id = A, role member, scope `user:__mu_a`, the old fields, and `sync_topic` null; the owner's (mint_token) has a topic. |
| 2 | auto-backups-owner-only | A member's get_auto_backups and set_auto_backups(false) raise 42501; the owner's get works. |
| 3 | signin-B | verify_admin(B) mints `u:<B>.…`, the server's spelling of the name, and current_account → B's scope. |
| 4 | generic-error | An unknown name, a wrong password and a disabled account's right password give byte-identical answers, `invalid`, no attempts_left; D's row unchanged. |
| 5 | lock-A-only / locked-generic | 3 wrong for A → A locked; then A's right and a wrong password give byte-identical `invalid`; B signs in; B's counter is 0. |
| 6 | unlock-A-only / unlock-revokes-A / unlock-keeps-B | A wrong code counts on A only; the right code + new password unlocks A; A's old token is revoked; B's epoch, counter and token are untouched. |
| 7 | unlock-generic | An unknown name, C (no code), a wrong code for B and D's (disabled) right code give byte-identical `invalid`; D's row unchanged. |
| 8 | pwchange-A-only / pwchange-revokes-old | A's change revokes A's earlier token and returns a working `u:A` token; B's epoch and token are unchanged. |
| 9 | reauth-lock-C-only | 3 wrong *current* passwords (Settings) lock C only (`locked`, re-auth keeps it). |
| 10 | A-never-touches-B | With A's token: delete_queued_rows and clear_queued_rows naming B's ids leave both B rows; delete_my_backup_phase2(B's backup) leaves it; list_my_backups omits it; purge_my_backups_of(B's ids) leaves B's backup snapshot unchanged (md5); restore_my_backup_phase2(B's backup) answers `backup_not_found`; snapshot_my_data_phase2('manual') writes username `user:__mu_a`; set_my_wavespeed_key lands in `user:__mu_a`; nothing lands under `u:%`. |
| 11 | wavespeed-B-own | As service_role, get_my_wavespeed_key(B) returns B's own fixture (md5 compare, never printed); anon has no EXECUTE on it. |
| 12 | forged-subject | A's token with B's id swapped in → `invalid signature`. |
| 13 | scope-header-A | session_scope with A's header → `user:__mu_a` (needs M2). |
| 14 | dual-accept-admin | Until M4: `admin:<owner>` works with role owner and the owner's id and scope; `admin:__mu_a` is revoked; an owner token issued before the owner's epoch is revoked. From M4 (set_admin_credentials_rehash gone): `admin:<owner>` is revoked. The owner's epoch is restored after. |
| 15 | ip-throttle / ipv6-per-64 / no-ip-no-throttle / bad-ip-no-throttle / shared-key-guard | Limit lowered to 3. From a blocked IP: B's right password signs in; B's wrong one answers `throttled` and counts on B (B's counter goes to 1); another IP signs B in. Three addresses in one IPv6 /64 block a fourth; another /64 is not blocked. No header, or a header that does not cast, is never throttled. Guard lowered to 3: 4 names failing from one key switch the mode to `observe`. Limits restored. |
| 16 | rename-A-only / rename-rate-limit | `__MU_B` → `username_taken`; `__mu_a2` moves only A's rows; scope stays in step; B's token and rows are untouched; A's new token scopes to the new name. 4 more taken answers, then A's next try (a free name) → `rate_limited`; B's own try still gets `username_taken`. |
| 17 | disabled-C | disabled_at revokes C's token at once; B keeps working. |
| 18 | backup-pause-A-only / pause-generic | 5 wrong codes pause A; during the pause A's right and a wrong code give byte-identical `invalid` and A stays paused; B's right code still unlocks B. |
| 19 | other-subject-malformed | A signed `user:__mu_a` token and a `zz:x` token → `malformed session token`. |
| 20 | owner-untouched | The real owner row's counters and epoch equal the seed snapshot. |
| 21 | owner-signin / owner-pwchange / owner-rename / owner-old-unlock | The owner flows in every stage (the owner row gets a known cost-4 hash and code inside the block): verify_admin, change_my_password and rename_my_account each return a token that get_my_account accepts as the owner (`admin:<name>` before M3, `u:<id>` after); each replaced token is revoked; `pg_sleep(0.6)` before each bump makes the call cross a second boundary. The old 2-arg unlock acts on the owner row (unlocks it, sets the new password, bumps only its epoch); after M4 it may be dropped, which the case reports. |

**Expected result per stage** (the go/no-go for each live step; "all" = every other label ok):

| Stage | Result line |
|---|---|
| before P1 (today) | every case FAIL (no users table); no syntax error |
| `M1` alone | all ok except `FAIL scope-header-A` (session_scope still refuses `u:` with 28000 until M2); owner flows mint `admin:` |
| `M1 + M2` | all ok; owner flows still mint `admin:` |
| `M1 + M2 + M3` | all ok; owner flows mint `u:` |
| after `M4` | all ok; dual-accept-admin asserts `admin:` is revoked; owner-old-unlock may report the 2-arg unlock as dropped |

**Today it fails, as required.** `node scripts/tools/sql-tx.mjs --test scripts/test-mu-auth.sql` (2026-10-23, revised
suite) printed `0 ok, 22 FAIL` with exit 1 and no syntax error. Every case failed on a missing P1 object or on what
follows from it: `relation "proxima_auth.users" does not exist`, `relation "proxima_auth.auth_config" does not exist`,
`function proxima_auth.mint_token(uuid) does not exist`, `function proxima_auth.current_account(text) does not exist`,
`function unlock_with_backup_code(...)` (missing), `invalid session token` (null tokens), `session token missing`, and
`other-subject-malformed 0` (today's verifier still lets a `user:` subject through). 22 FAIL lines, not 36, because a
case that fails early reports only its first label. When everything passes, the line holds 36 labels.

### 9.2 Gates added with M1/M3
These live in a sibling `scripts/test-mu-p1-catalog.sql` (and inside M3's precondition block):
- **Semantic:** every `public` function other than `_verify_session_token` whose body calls
  `_verify_session_token(p_session_token)` also calls `proxima_auth.current_account`.
- **No fall-through**, case-insensitive: no body matches `(?i)else\s+(\w+\s*:=\s*)?v_subject`.
- no `public` function body contains `'admin:'` except `_verify_session_token` (which keeps an explicit revoke branch
  from M4); in `proxima_auth`, only current_account and session_scope (until M4) and issue_session (until M3);
- after M3, no body in `public` or `proxima_auth` matches `(?i)'admin:'\s*\|\|`;
- `has_table_privilege` is false for anon, authenticated and service_role on all three proxima_auth tables;
- **Execute:** no function other than verify_admin and unlock_with_backup_code is newly executable by anon or
  authenticated (compared with the pre-M1 ACL snapshot); mint_token, issue_session and current_account are executable
  by postgres only; no new function is executable through PUBLIC.

### 9.3 Existing suites that must stay green (and the fixture lines P1 changes)
- **SQL suites, all of them:**
  - test-queued-deletes, test-paths-in-use, test-backup-scrub, test-backup-switch-off, test-restore-scrub,
    test-history-emptied, test-history-strip, test-scrub-live, test-public-execute, test-ws-webhook(-deleted)-db;
  - test-rls-{phase0,plan,queued-rpcs,rename,rpcs,storage,tables,triggers,grants-unchanged};
  - and `npm test` (scripts/run-tests.mjs: the 24 node suites, including test-session and test-session-header).
- **They must change with M1 (fixture lines only, assertions unchanged unless named):**
  - **Swap the owner name in app_secrets** → swap the owner row in `proxima_auth.users` (`username` and `scope`
    together): test-queued-deletes-db.sql:12/77/82, test-paths-in-use-db.sql:13 and test-rls-rename.sql:15.
  - **Mint `user:<x>` subjects and rely on the fall-through scope** → seed a users row for `<x>` and use
    `proxima_auth.mint_token`: test-backup-scrub-db.sql:137, test-backup-switch-off-db.sql:20 and
    test-restore-scrub-db.sql:12.
  - **`user:` refusal fixtures** (test-paths-in-use-db.sql:39-42, case 3, and test-queued-deletes-db.sql:39-43, case 3)
    expect `insufficient_privilege` (42501) today. The fail-closed verifier answers `malformed session token` (P0001)
    before the function's own check, so the expected outcome changes to "raises `malformed session token`". The
    refusal itself is unchanged.
  - **Epoch bumps:** test-rls-phase0.sql:79-80 and test-rls-tables.sql:194-195 revoke by writing app_secrets
    `admin_sessions_valid_after`. From M1 they bump `proxima_auth.users.sessions_valid_after` on the owner row instead
    (still now + 60, which revokes under `<=` as under `<`). test-rls-phase0's "valid_after bump rotates the topic"
    needs the same edit once M2 reads the owner row. Both are the RLS session's files: agreed by message.
  - **Other epoch fixtures:** any suite that bumps the epoch and expects a token minted in the same second to survive
    relies on the strict rule; none was found in the files above, and the M1 author re-checks with a grep for
    `valid_after` across `scripts/test-*.sql`.
  - **test-public-execute-db.sql:17-24:** add unlock_with_backup_code to the callers-kept list in M1 (expected count
    13 → 14). At M4, remove set_admin_credentials_rehash (and unlock_admin_with_backup_code if dropped) and set the
    count to match.
- **Robustness edits:** read the owner from `proxima_auth.users where role='owner'` instead of app_secrets
  `admin_username` (correct today, wrong after any rename during P1). Files: test-rls-tables:8, test-rls-phase0:7,
  test-rls-plan:5, test-rls-queued-rpcs:8, test-rls-rpcs:5, test-rls-storage:6, test-rls-triggers:6 and
  test-ws-webhook-db:10-11.
- **With M4,** the `'admin:'||u` mints in those suites become `proxima_auth.mint_token(owner id)`.
- **Retired:** the historical rollback proofs of already-applied phases (test-rls-phase0-rollback.sql and
  test-rls-rollback{,-before}.sql) drop or rewrite proxima_auth objects. After M1 they are meaningful only after P1's
  own rollback, so they are marked retired rather than kept in the green set.

## 10. Risks and open questions
**Owner ruling, 2026-10-23: all seven recommendations approved** (verbatim: "approve all just get with your partner to
avoid collision"). M1 starts after the RLS session agrees the coordination items (freeze, M2 inputs and rollback guard,
rotate-service-key change, fixture edits in its suites, the plan §7 line).

**Open questions for the owner** (each with a recommendation; all approved as recommended):
- **Q1 Generic sign-in error.** A stranger can no longer learn whether a name exists, or whether an account is locked.
  The cost: the sign-in screen loses "N attempts left" and never says "locked"; a locked account answers "Wrong username
  or password" even to the right password, and a paused backup code answers "Wrong backup code" even when it is right.
  The static hint on the screen says that 3 wrong passwords lock the account and the backup code unlocks it.
  Real life: you mistype 3 times on the phone; the 4th, correct try still says "wrong"; the hint sends you to the backup
  code, which unlocks it. **Recommend: accept.** It is the plan's D4, and it stops the lock from confirming a guess.
- **Q2 The per-IP throttle is on by default** (10 failures / 15 min / network), and what it does while a network is
  blocked. Your "rate limits off by default" ruling covers usage limits on the proxy; this is a sign-in guard. While a
  network is blocked, a right password still signs in (you and the other user on the same Wi-Fi are never locked out
  by someone else's typos), and wrong passwords from it count toward that account's 3-try lock as they would from
  anywhere. **The trade-off:** someone who knows an account's exact name can lock it with 3 wrong tries, from any
  network, blocked or not (that is Q5, unchanged); the backup code unlocks it. Real life: someone at a café trips the
  block with 10 junk names; you, at home or on the same café Wi-Fi, still sign in with your right password; if they
  then guess your name 3 times, your account locks and your backup code unlocks it. **Recommend: on (after the header
  probe).**
- **Q3 No usable IP header, or a shared one.** If the probe shows that PostgREST gets no trustworthy per-client IP (no
  header, a constant key across two networks, or a forgeable one), the throttle stays `observe` and is inert. The
  runtime guard also drops to `observe` if a key looks shared later. **Recommend: ship P1 without it (observe) and move
  sign-in behind a Vercel function** that reads Vercel's own client IP and calls the RPC with the service role, as a P5
  item. Do not block P1 on it.
- **Q4 Sign-in names become case-insensitive** (`StephJr101` = `stephjr101`; names are unique ignoring case).
  **Recommend: yes.**
- **Q5 The 3-try lockout stays per account** (parity with today). Anyone who knows a member's exact name can still lock
  that member with 3 guesses; the backup code unlocks it. Generic errors hide which names exist, the rename check is
  rate-limited (5 taken names per hour per account), and the IP throttle caps spraying. **Recommend: keep.** Revisit a
  per-(account, IP) lockout only if it happens.
- **Q6 Live pings for members wait for P4.** In P1 there is one sync topic and it is yours; members get `sync_topic =
  null` and auto-backup controls are yours only. Members cannot exist before P5, so nobody notices. Real life: none in
  P1; in P4 every account gets its own topic and switch. **Recommend: accept.** The plan's §7 line "test-mu-auth covers
  topic per account" is corrected to "topic owner-only until P4" by the main session (this doc cannot edit the plan).
- **Q7 Renames after 5 taken names wait an hour.** A member (or you) who tries 5 names that are already taken must wait
  up to an hour before the next rename attempt. Real life: you try five variants of a popular name, then get "Too many
  name checks, try again in an hour". **Recommend: accept;** renames are rare and the limit stops a signed-in member
  from listing every account name.

**Risks** (handled in the design):
- **Fall-through scope.** The 7 functions must change before any `u:` token reaches them. Mitigations: M1 before M3,
  M3's precondition block, and the semantic §9.2 gate.
- **Stale app_secrets during P1.** Covered by the copy-back (§7). The other readers are sync_topic (M2 moves it) and both
  rotate scripts (changed in the M1 commit; rotate-service-key by message with the RLS session).
- **Concurrent rewrites by other sessions.** The ~30 functions M1 replaces are frozen from M1 authoring until M4 (announced
  by message to the RLS and webhook sessions); M1's apply and rollback are compare-and-swap on md5, so drift aborts
  instead of being overwritten.
- **Rollback order across two sessions.** M1's rollback refuses while M2 is live; M2's rollback refuses while M3 is
  live (to agree with the RLS session); the proof runs the full M1 → M2 → M3 → back sequence.
- **Stale bundles.** C0 is confirmed in the live bundle with a CACHE_NAME bump before M1; both owner devices show the new
  build before M1b. The old 2-arg unlock is kept, owner-only, until the edge logs show it unused.
- **Fixture edits in suites owned by the RLS session** (§9.3). Agree them by message before M1.
- **A rollback after M3 signs `u:` holders out once** (by design, §7).
- **Messages to send before M1:** to the RLS session (freeze; test-rls-* edits; rotate-service-key change; M2's
  `sessions_valid_after + 1` topic input; M2 rollback guard) and to the webhook session (freeze).
