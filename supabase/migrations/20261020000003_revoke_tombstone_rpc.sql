-- The tombstone functions are trigger-only. Supabase exposes every public function as a REST RPC
-- (/rest/v1/rpc/...), and SECURITY DEFINER ones get flagged (lints 0028/0029). Triggers fire without
-- the caller holding EXECUTE, so revoking it removes the RPC surface without affecting sync.
revoke execute on function public.sync_tombstone_record() from public, anon, authenticated;
revoke execute on function public.sync_tombstone_clear() from public, anon, authenticated;
