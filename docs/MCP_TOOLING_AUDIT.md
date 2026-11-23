# LUNA MCP tooling and deployment audit

**Audit date:** 2026-11-04  
**Repository:** sakdiphongkan-ops/ceos-platform  
**Production frontend:** https://luna-th1h-control-room.vercel.app/luna  
**Production database:** Supabase project wigzicwgcsrhdummrbjx

## Executive decision

Keep the existing GitHub, Vercel, Supabase and Playwright capabilities as the primary engineering toolchain. Do not install duplicate MCP servers merely because they appear in a catalogue. Use an isolated browser/test runtime for deterministic checks, project-scoped database inspection, and reviewable GitHub changes.

LUNA remains PAPER ONLY. No external tool or MCP may submit, amend, cancel or route broker orders. The backend admission gate, idempotency, risk controls and kill switch remain authoritative. A successful deployment or a successful data-ingest request is not evidence of execution readiness.

## Discovery scope and limitations

- Read and parsed the complete mcpHQ/awesome-mcp-servers data/servers.json catalogue available during this audit: 667 catalogue entries.
- Filtered 61 entries into LUNA-relevant categories: browser automation, testing, databases, deployment, observability, security and financial/market data.
- Reviewed repository metadata and selected source/readme/license material for high-fit upstream projects. This is not a clone-and-security-audit of all 667 projects or every public GitHub repository. Catalogue inclusion, stars and an official label are not security certification.
- Used the catalogue as a discovery index only. Any future MCP addition must be checked against its canonical upstream source, release, license, scopes, mutations, auth model, secrets exposure and maintenance status.

## Selected MCP and tool decisions

| Candidate | Source review | Decision for LUNA |
|---|---|---|
| Microsoft Playwright MCP | Official Microsoft project; Apache-2.0. Its upstream documentation distinguishes Playwright Test, CLI and MCP modes. | Keep Playwright Test as the deterministic E2E runner and the installed Playwright library for direct smoke checks. Do not add a duplicate MCP runtime solely for this app. |
| Supabase MCP | Official Supabase project; supports project_ref scoping, read-only mode and feature-group restriction. | Prefer the already-connected Supabase connector. Any separate MCP connection must be scoped to project wigzicwgcsrhdummrbjx, read-only, and limited to database/docs for diagnostics. |
| GitHub connector | Already connected to ceos-platform with repository read/write and PR capabilities. | Use for pinned branch, reviewable commits, Actions/CI and pull requests. Do not write directly to master for an untested change. |
| Vercel connector | Existing Vercel project luna-th1h-control-room is linked to ceos-platform and its production deployment is READY. | Use this as the canonical Next.js frontend host. Keep preview protection/SSO enabled. Do not create a replacement deployment platform when this project is healthy. |
| Railway | Connected account has no accessible projects. The previous LUNA gateway hostname returned 404 Application not found. | Do not rely on the retired gateway hostname. Do not create a paid Railway project as a side effect. |
| Render | Suitable for a long-running FastAPI/WebSocket service, but the free service sleeps when idle and is not a production availability solution. A production plan requires an explicit cost decision. | Not selected. The frontend does not require this service, and the existing Supabase Edge ingest is a separate pipeline. |
| Chrome DevTools MCP | Potentially useful for browser profiling and DevTools-specific evidence. | Optional; not needed while Playwright already covers browser regression and network assertions. |
| Bytebase DBHub / general PostgreSQL MCPs | Powerful database administration surface; broad write access materially increases risk. | Do not connect an unrestricted database MCP to production. Use the native project-scoped Supabase tools and read-only SQL for audits. |
| Financial Modeling Prep / Alpaca / Avanza and other market MCPs | Some products focus on US markets or introduce broker/trading actions; they are not the SET/mai source-of-record. | Exclude from LUNA production. Do not substitute their data for authorized SET/mai data or expose order tools. |
| Grafana / Sentry and other observability MCPs | Potentially useful when the corresponding service and account are intentionally provisioned. | No duplicate service is installed without a live account/workspace and a clear operational need. |

## Canonical deployment and service boundaries

- Frontend: Vercel project luna-th1h-control-room, public production URL above.
- Source control: GitHub repository sakdiphongkan-ops/ceos-platform.
- Data/auth/API/ingest: Supabase project wigzicwgcsrhdummrbjx.
- Browser checks: Playwright Test and the existing isolated Playwright runtime.
- The retired FastAPI/WebSocket Railway URL must not be treated as a production dependency. The frontend HTTP/Supabase feed remains the source of record; an optional WebSocket may only accelerate display of a quote that is still independently fresh and validated.
- Do not remove Vercel SSO from protected previews. Do not copy credentials into source files, tests, logs, PRs or chat.

## Current LUNA evidence (2026-11-04)

- Active universe: 930 symbols (700 SET + 230 mai).
- Fresh verified order books: 0 at the latest database snapshot checked.
- REST observation cache: 927 symbols, all marked OBSERVATION_ONLY and execution_eligible=false.
- Market ticks table: 0 rows at the after-hours snapshot.
- The TopTrader WebSocket ingest Edge Function validates event timestamps, two-sided book data and tick/book pairing before the verified write RPC. Its documented sampling window returned approximately 85-119 matched symbols per run on 2026-10-28; this is partial observation, not full-universe coverage.
- The WS ingest cron was inactive. The safe scheduler wrapper was invoked once after market hours and returned HTTP 200 with OUTSIDE_MARKET_WINDOW, no_database_writes=true and no_orders_created=true. The existing job was then re-enabled on a GMT schedule limited to weekday 02:00-09:59 (09:00-16:59 Bangkok); the Edge Function's trading-day and precise market-window checks remain in force.
- The schedule change does not prove fresh market data. Verify new timestamped rows, source, quote/book parity, freshness and active-universe coverage during the next market session. Do not loosen gates to increase the displayed percentage.

## Source changes prepared on the reliability branch

- Removed the retired Railway hostname as the default public market stream URL.
- An empty, invalid, non-WSS or explicitly retired stream URL is now fail-closed: the client does not attempt the connection and does not enter a retry loop. HTTP/Supabase remains authoritative.
- Transient WebSocket reconnects use exponential backoff from 5 seconds to a 60-second cap; auth/config close codes 4401 and 4403 are terminal.
- Added a browser regression test that rejects any connection attempt to the retired Railway hostname.
- Changes are on a review branch and are not considered production until CI, build, browser tests and a protected preview have passed.

## Release gates

1. Build and typecheck the exact commit.
2. Run architecture, data-quality, PIT, risk-gate, paper-only and WebSocket diagnostic tests.
3. Run Playwright E2E, accessibility and horizontal-overflow checks.
4. Verify a preview deployment and direct browser/network behavior without disabling SSO.
5. Verify Supabase Edge Function health, current source timestamps, tick/book matching, quote freshness and coverage.
6. Confirm paper mode and the live broker lock remain unchanged.
7. Only then promote the exact reviewed commit. Vercel READY is a deployment status, not a data-readiness status.

## Upstream references

- https://github.com/mcpHQ/awesome-mcp-servers
- https://github.com/microsoft/playwright-mcp
- https://github.com/supabase/mcp
- https://supabase.com/docs/guides/ai-tools/mcp
- https://supabase.com/docs/guides/cron
