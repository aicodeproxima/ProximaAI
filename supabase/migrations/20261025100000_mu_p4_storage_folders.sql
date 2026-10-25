-- Multi-user P4, storage walls (docs/MULTI-USER-PLAN.md §5 P4, catalog gate G2; docs/P3-SCOPE-DESIGN.md step 5): a
-- session reads and changes only the files in its own account's folders of bucket 'generations'. Until now any valid
-- session reached every file, so a second account could have listed, overwritten or deleted the owner's.
-- An account's folder is its scope spelled the way the app spells it (src/lib/supabase.js archiveUrl and uploadInputFile
-- replace every UTF-16 unit outside [A-Za-z0-9_-] with '_': 'user:StephJr101' -> 'user_StephJr101'). Archives live under
-- '<folder>/', input uploads under 'uploads/<folder>/'. proxima_auth.account_folders records every folder an account has
-- had: a rename leaves the files where they are, so the account keeps its old folder, and no other account can ever
-- take a folder (a scope whose folder belongs to another account is refused with 23505). Public GETs
-- (/object/public/...) skip row security and are unchanged.
-- Live 2026-10-25 19:30 UTC: one account; the bucket holds 12 files, all under uploads/user_StephJr101/.
-- rename_my_account (lockdown session, P1) gets one more "taken" case: a name whose folder another account holds answers
-- the counted, rate-limited username_taken (review c3 #1); the migration refuses if that body moved since 2026-10-25.
-- Rollback: supabase/rollback/20261025100000_mu_p4_storage_folders.rollback.sql
set local lock_timeout = '5s';   -- an apply that cannot take its locks within 5 s stops instead of queueing the app

do $guard$
begin
  if md5(pg_get_functiondef('public.rename_my_account(text,text,text)'::regprocedure)) <> '52480f4868d3093b5df2bba84c27a218' then
    raise exception 'rename_my_account changed since 20261025100000 was written: rebase it on the live body';
  end if;
end $guard$;

-- The folder of a scope, exactly as the browser spells it. JavaScript replaces UTF-16 units, so a character outside the
-- Basic Multilingual Plane (two units) becomes '__'.
create function proxima_auth.scope_folder(p_scope text) returns text
  language sql immutable strict set search_path = ''
as $$
  select pg_catalog.regexp_replace(pg_catalog.regexp_replace(p_scope, '[\U00010000-\U0010FFFF]', '__', 'g'),
                                   '[^A-Za-z0-9_-]', '_', 'g')
$$;
revoke all on function proxima_auth.scope_folder(text) from public;

-- Every folder an account owns, forever: never reassigned, never shared.
create table proxima_auth.account_folders (
  folder     text primary key check (folder ~ '^user_[A-Za-z0-9_-]+$'),
  account_id uuid not null references proxima_auth.users (id),
  added_at   timestamptz not null default now()
);
create index account_folders_by_account on proxima_auth.account_folders (account_id);
revoke all on proxima_auth.account_folders from public, anon, authenticated, service_role;
alter table proxima_auth.account_folders enable row level security;   -- no policy: only its owner (postgres) reads it
insert into proxima_auth.account_folders (folder, account_id)
  select proxima_auth.scope_folder(u.scope), u.id from proxima_auth.users u;

-- The account folder of an object path: '<folder>/...' (archives) or 'uploads/<folder>/...' (inputs); NULL for anything
-- else (a file at the bucket root, 'uploads/<file>', a path starting with '/', an empty segment). The same answers as
-- storage.foldername's segments, but plain SQL with no SET clause and only pg_catalog functions and operators (no
-- regular expressions), so the planner inlines it into the policies: storage.foldername (plpgsql) made a listing of
-- 20,000 files about ten times slower (review c2 D2). A folder needs a '/' after it (strpos > 1: no empty segment).
create function proxima_auth.object_folder(p_name text) returns text
  language sql immutable parallel safe
as $$
  select case when pg_catalog.split_part(p_name, '/', 1) operator(pg_catalog.=) 'uploads'
              then case when pg_catalog.strpos(pg_catalog.substr(p_name, 9), '/') operator(pg_catalog.>) 1
                        then pg_catalog.split_part(p_name, '/', 2) end
              else case when pg_catalog.strpos(p_name, '/') operator(pg_catalog.>) 1
                        then pg_catalog.split_part(p_name, '/', 1) end
         end
$$;
revoke all on function proxima_auth.object_folder(text) from public;
grant execute on function proxima_auth.object_folder(text) to anon, authenticated;

-- Every folder that already holds a file belongs to someone. With one account (today) all of them are the owner's,
-- including files a rename left in an older folder; otherwise those files would be stranded, and their folder open to
-- whoever later takes that name (review c2 D1). With more accounts an unclaimed folder stops the migration instead.
insert into proxima_auth.account_folders (folder, account_id)
  select distinct proxima_auth.object_folder(o.name), (select u.id from proxima_auth.users u where u.role = 'owner')
    from storage.objects o
   where o.bucket_id = 'generations' and proxima_auth.object_folder(o.name) ~ '^user_[A-Za-z0-9_-]+$'
     and (select count(*) from proxima_auth.users) = 1
  on conflict (folder) do nothing;
do $seed$
declare
  n int;
begin
  select count(*) into n from storage.objects o
   where o.bucket_id = 'generations'
     and not exists (select 1 from proxima_auth.account_folders f where f.folder = proxima_auth.object_folder(o.name));
  if n > 0 then
    raise exception 'refusing: % file(s) in bucket generations sit outside every account folder (claim or move them first)', n;
  end if;
end $seed$;
-- A rollback of this migration forgets the old folders, so an account created meanwhile under someone's former name
-- would get that name's folder from the backfill above, with the earlier holder's files in it. With more than one
-- account, a member's folder holding a file no newer than the member stops the migration (review round 2, c1 D1).
do $inherit$
declare
  n int;
begin
  if (select count(*) from proxima_auth.users) > 1 then
    select count(*) into n
      from proxima_auth.account_folders f
      join proxima_auth.users u on u.id = f.account_id and u.role <> 'owner'
      join storage.objects o on o.bucket_id = 'generations' and proxima_auth.object_folder(o.name) = f.folder
     where o.created_at <= u.created_at;
    if n > 0 then
      raise exception 'refusing: % file(s) in a member''s folder predate that member (a folder an earlier name left?)', n;
    end if;
  end if;
end $inherit$;

-- A new account or a new scope (rename) claims its folder; one that belongs to another account is refused.
create function proxima_auth._users_keep_folder() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_folder text := proxima_auth.scope_folder(new.scope);
begin
  insert into proxima_auth.account_folders (folder, account_id) values (v_folder, new.id)
    on conflict (folder) do nothing;
  if not exists (select 1 from proxima_auth.account_folders f where f.folder = v_folder and f.account_id = new.id) then
    raise exception using errcode = '23505', message = 'that name is not available';
  end if;
  return null;
end $$;
revoke all on function proxima_auth._users_keep_folder() from public;
create trigger users_keep_folder after insert or update of scope on proxima_auth.users
  for each row execute function proxima_auth._users_keep_folder();

-- The folders of the session's account: empty without a session; a bad token raises 28000 (session_scope), and so does
-- a missing one when p_required.
create function proxima_auth.my_folders(p_required boolean default false) returns text[]
  language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope text := proxima_auth.session_scope(p_required);
begin
  if v_scope is null then return '{}'::text[]; end if;
  return coalesce((select pg_catalog.array_agg(f.folder order by f.folder)
                     from proxima_auth.account_folders f join proxima_auth.users u on u.id = f.account_id
                    where u.scope = v_scope), '{}'::text[]);
end $$;
revoke all on function proxima_auth.my_folders(boolean) from public;
grant execute on function proxima_auth.my_folders(boolean) to anon, authenticated;

-- The four policies keep their names and roles; each now asks for the object's account folder. (select ...) runs
-- my_folders once per statement. The ::text[] makes ANY take the array: ANY ((select ...)) still parses as the subquery
-- form and fails with "text = text[]".
alter policy "generations session select" on storage.objects
  using (bucket_id = 'generations'
         and proxima_auth.object_folder(name) = any ((select proxima_auth.my_folders(false))::text[]));
alter policy "generations session insert" on storage.objects
  with check (bucket_id = 'generations'
              and proxima_auth.object_folder(name) = any ((select proxima_auth.my_folders(true))::text[]));
alter policy "generations session update" on storage.objects
  using (bucket_id = 'generations'
         and proxima_auth.object_folder(name) = any ((select proxima_auth.my_folders(true))::text[]))
  with check (bucket_id = 'generations'
              and proxima_auth.object_folder(name) = any ((select proxima_auth.my_folders(true))::text[]));
alter policy "generations session delete" on storage.objects
  using (bucket_id = 'generations'
         and proxima_auth.object_folder(name) = any ((select proxima_auth.my_folders(true))::text[]));

-- Renames: a name whose folder belongs to another account is "taken" (counted and rate-limited like any taken name),
-- before the trigger above would refuse it.
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
       or exists (select 1 from data_backups x where x.username = 'user:' || v_new)
       -- 20261025100000: a folder some other account holds (its old name, or a spelling of the same folder) is taken too.
       or exists (select 1 from proxima_auth.account_folders f
                   where f.folder = proxima_auth.scope_folder('user:' || v_new) and f.account_id <> v_acc.id) then
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
end $function$
;
