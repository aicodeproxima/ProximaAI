# ProximaAI — parked items

Items the owner asked to keep visible until done. Remove an entry once it is finished, in the same commit.

## Turn on 2FA for Vercel, Supabase and GitHub (parked 2026-10-21)
Those three accounts now hold every master key: the Vercel project's Sensitive env vars (SESSION_SIGNING_KEY,
SUPABASE_SERVICE_ROLE_KEY, WAVESPEED_WEBHOOK_SECRET), the Supabase project (service_role key, all data), and the
GitHub repo that auto-deploys to production. A phished password on any of them is enough to take the app over today.
- Vercel: Account Settings → Authentication → Two-Factor (Vercel also prompts at sign-in; it was skipped once).
- Supabase: Account → Security → Multi-Factor Authentication.
- GitHub: Settings → Password and authentication → Two-factor authentication.
Use an authenticator app, and store the recovery codes in the password manager.

## Rotate the Supabase service role key (low priority, parked 2026-10-21)
On 2026-10-21 the service_role key was revealed and copied several times while making it Sensitive in Vercel (one
bad paste caused a 13-minute outage, 16:33–16:46 UTC). Rotate it once, calmly:
1. Supabase → Project Settings → API Keys: create a new secret key (the new-style `sb_secret_…` keys can be rotated
   without touching the public anon key; rotating the legacy JWT secret would also change the anon key that is built
   into the site).
2. Check first that the proxy and webhook accept the new key format: they send it as both `apikey` and
   `Authorization: Bearer` to PostgREST (api/ws-proxy.ts getUserWaveSpeedKey, api/ws-webhook.ts). Test before swapping.
3. Vercel → Environment Variables → SUPABASE_SERVICE_ROLE_KEY → Edit → paste the new value (copy it with Supabase's
   copy button) → Save → Deployments → Redeploy.
4. Verify within a minute: the app's balance shows (proxy call 200), and Supabase edge logs show
   `/rest/v1/rpc/get_my_wavespeed_key` answering 200 after the deploy. Keep the old deployment for Instant Rollback.
5. Only then revoke the old key in Supabase.
