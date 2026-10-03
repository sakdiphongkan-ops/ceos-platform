# LUNA 2.0 Webapp Release Gate

## Current release
The application source is on the `master` branch.

## Required checks
1. Git commit exists on `master`.
2. GitHub CI completes successfully.
3. Vercel creates a deployment from the configured production branch.
4. Deployment reaches Ready.
5. Verify `/luna`, `/luna/research`, `/luna/portfolio`, `/luna/risk`, `/luna/agents`, `/luna/pricing`, and `/luna/account`.
6. Verify runtime errors are absent for the release.
7. Only then call the webapp release live.

## Safety
- Live-money execution remains locked.
- Billing remains provider-neutral until provider credentials and webhook verification are configured.
- No client-side service-role credentials.
- Existing Control Room is the UI baseline and should not be replaced by the SaaS shell without explicit approval.
