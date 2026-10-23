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

## Change the admin password and the backup code (parked 2026-10-23)
Owner ruling, 2026-10-23: "skipping admin password and backup code change for now park for another time". Do not raise
it again until the owner reopens it. Why it was on the list: the password hash and the backup-code hash were last
changed on 2026-10-20 (20:36 and 19:44 UTC), before Hermes's 2026-10-21 session named both rows (their values may have
reached z.ai; bcrypt cost 12, so only a weak secret is at real risk), and the backup code was typed in a chat on
2026-10-20. How, when reopened: Settings → Account → Change Password, then Replace Backup Code (each asks for the
current password; a password change signs out every device).
