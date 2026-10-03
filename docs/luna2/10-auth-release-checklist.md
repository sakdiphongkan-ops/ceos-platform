# LUNA 2.0 Auth Release Checklist

## Implemented
- Supabase SSR browser/server clients
- Email/password sign-in and sign-up
- Google OAuth callback
- Protected /luna/account
- Server-side /api/luna2/me
- Server-side commercial access resolver
- Live money remains locked

## Required production configuration
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
- Supabase Auth Site URL
- Supabase Auth redirect URL: https://luna-th1h-control-room.vercel.app/auth/callback
- Google provider enabled if Google sign-in is used

## Release gate
1. GitHub CI passes.
2. Vercel production deployment is READY from the intended master commit.
3. /luna returns 200.
4. /luna/login returns 200.
5. /luna/account redirects unauthenticated users to /luna/login.
6. Authenticated /luna/account returns the signed-in user's account data.
7. /api/luna2/me returns 401 without a session and account data with a valid session.
8. Existing Control Room market-data paths remain functional.
9. No live-money execution permission is enabled.

Do not mark production complete until all nine checks have fresh evidence.
