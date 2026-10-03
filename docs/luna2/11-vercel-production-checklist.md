# LUNA 2.0 — Vercel Production Release Checklist

## Required server environment
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
- SUPABASE_SERVICE_ROLE_KEY (server-only; never NEXT_PUBLIC_)

## Release sequence
1. Confirm latest master commit is the intended release.
2. Confirm GitHub CI has a successful run for that commit.
3. Create a Vercel deployment from the exact commit SHA if Git webhook deployment is unavailable.
4. Confirm deployment is READY.
5. Verify /luna and /luna/login return successfully.
6. Verify unauthenticated /luna/account redirects to /luna/login.
7. Verify /api/luna2/me returns 401 without a session.
8. Verify authenticated account access after login.
9. Verify Control Room market data remains functional.
10. Verify live-money execution remains LOCKED.

## Deployment fallback
When Vercel Git webhook deployment or the connected Vercel deploy action is unavailable, use the repository-pinned GitHub Actions workflow:
- `.vercel/project.json` pins the intended Vercel project and team.
- `.github/workflows/luna-vercel-pinned-deploy.yml` deploys the exact checked-out master SHA with Vercel CLI.
- Required GitHub secret: `VERCEL_TOKEN`.
- The workflow builds with Vercel first, then deploys the prebuilt output to the pinned production project.

Do not promote the deployment to the production domain until the checks above pass.

<!-- Vercel Git integration deployment probe: 2026-10-03 -->
