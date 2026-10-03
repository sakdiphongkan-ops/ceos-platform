# LUNA 2.0 - Full-Stack System Architecture Test Plan

## Scope

This suite adds four release-level test layers on top of build/typecheck.

### 8. API Integration & Data Contract
- Payload shape checks for /api/luna2/plans, /api/luna2/capabilities, /api/luna2/me.
- Explicit validation for 401, 404, 405, 413, 429 and 503 paths where the contract owns the response.
- Retry-After is required whenever a 429 is returned.
- Optional live smoke target: LUNA_BASE_URL.
- Optional provider-specific rate-limit target: LUNA_RATE_LIMIT_TEST_URL.
- Runtime API rate limiting supplied by an upstream/provider must not be mistaken for application-level rate limiting.

### 9. Authentication, Session & RBAC
- Guest to protected /luna/account redirect.
- User access to /api/luna2/me is server-resolved.
- Logout must call Supabase auth.signOut() and return to /luna.
- Role contract is explicit: GUEST, USER, ADMIN, and defaults fail-closed.
- LIVE_MONEY_EXECUTE is denied for every role until a separate production authorization design exists.
- Role binding must remain server-side; do not use user_metadata as an authorization source.
- Token-expiry tests are runtime-dependent on a real expired session and are enabled when a target/session fixture is supplied.

### 10. Cross-Browser & Environment Compatibility
Matrix:
- Chromium
- Firefox
- WebKit (Safari engine coverage)
- iPhone viewport/touch emulation

Checks:
- No horizontal overflow.
- Inputs use at least 16px font on mobile to reduce iOS Safari auto-zoom risk.
- Dynamic viewport height uses dvh for keyboard/layout resilience.
- Interactive controls are at least 44px where applicable.
- Focus remains visible and usable after keyboard interaction.

Note: WebKit and iPhone emulation are not a claim of full real-device Safari coverage. Real iOS Safari requires a physical device or cloud browser farm.

### 11. Logging & Observability
- Route-level error boundary and global error boundary are installed.
- window.error and unhandledrejection are captured.
- Client telemetry posts only sanitized name, message and source.
- Server strips URLs, bearer tokens, access/refresh tokens, passwords, secrets and API keys before logging.
- Client error endpoint rejects malformed and oversized payloads and returns 429 with Retry-After on its local abuse guard.
- Source scan fails CI if console methods directly include credential-bearing fields.

## CI gates

1. Typecheck + production build.
2. Architecture tests: npm run test:architecture.
3. Browser compatibility smoke: npm run test:browser on Chromium, Firefox, WebKit and mobile emulation.
4. Production release remains blocked until these checks have fresh CI evidence.

## Known limitation

The current CEOS/LUNA app does not yet bind a persistent ADMIN role to a database claim or table. The RBAC file is the authorization policy contract and fail-closed boundary; wiring identity to role is a separate controlled change and must not be inferred from email or user metadata.
