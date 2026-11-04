---
name: mcp-tooling
description: Safe discovery, assessment and integration of MCP servers and deployment connectors for LUNA and ceos-platform.
---

# LUNA MCP tooling skill

## Goal

Select the smallest useful set of tools for the work. An MCP is a capability interface, not proof that data is correct or a system is healthy.

## Discovery workflow

1. Search the canonical MCP Registry and reputable curated indexes.
2. Treat index entries as discovery metadata only. Resolve each candidate to its canonical repository and package.
3. Record exact owner, version/commit, license, maintenance state, transport, auth and required permissions.
4. Read the actual tool schemas and inspect the source paths that handle authentication, filesystem, database, shell, network, deployment and destructive actions.
5. Deduplicate capabilities already provided by connected first-party tools.
6. Do not install or expose a candidate until its value, isolation plan, rollback path and permissions are clear.

## Production safety rules

- Keep market-data, research and execution authority separate.
- No external MCP may place, amend, cancel or route LUNA broker orders.
- Never use US-market or unofficial price tools as substitutes for authorized SET/mai market data.
- Use project-scoped, read-only database access for production diagnostics. Do not attach unrestricted Postgres MCPs to LUNA.
- Never reveal or copy credentials, scheduler tokens, API keys or service-role secrets into source, tests, logs, screenshots, issues or chat.
- Keep Vercel preview protection/SSO enabled.
- Do not create paid hosting resources, databases or third-party accounts without explicit budget approval.
- A deployment being READY does not mean the market feed is fresh or that execution gates pass.

## Browser and testing

- Use Playwright Test for repeatable assertions, deterministic navigation, route interception and browser regressions.
- Use an interactive browser tool only for exploratory diagnosis; it does not replace test assertions.
- Capture console, page errors, request failures and HTTP errors separately.
- Test desktop and mobile viewports; assert no unintended horizontal overflow.
- A WebSocket handshake is not a fresh quote. Only a validated, timestamped market tick may update market freshness.
- Stop retries for terminal auth/config close codes; use bounded exponential backoff for transient errors.

## Deployment

- Use the existing GitHub repository, Vercel project and Supabase project when they fit.
- Work on a branch created from the current master SHA. Avoid merging a diverged branch wholesale.
- Build and test the exact commit; deploy only a reviewed commit.
- Keep the old production revision available for rollback.
- For a persistent FastAPI/WebSocket service, select only a host that supports always-on connections and has a clear cost/health model.

## Release verification

1. Typecheck and production build.
2. Architecture, RLS, data-quality, point-in-time, risk-gate and paper-only tests.
3. Browser E2E, accessibility and overflow checks.
4. Protected preview deployment and live smoke test.
5. Backend API/Edge Function health, provider/source timestamps and tick/book parity.
6. Verify paper-only mode and the live broker lock.
7. Record the exact Git SHA, deployment URL and observed evidence.

Never label a system complete because a tool returned success. Report data freshness, market coverage and deployment status separately.
