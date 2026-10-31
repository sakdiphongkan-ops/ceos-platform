# LUNA MCP tooling audit and deployment engineering register

**Audit date:** 2026-11-01  
**Repository:** `sakdiphongkan-ops/ceos-platform`  
**Baseline inspected:** `ec8b236bcc2ef9e43bb5cd392884ce1d59ab26fc`

## Executive decision

Use the already-connected, project-scoped connectors and the repository's own test/deploy pipeline before adding third-party MCP servers. MCPs are capabilities, not evidence of system correctness. Every integration must be reviewed for scope, data provenance, mutation authority, credential handling, license, maintenance, and operational fit.

The LUNA source of truth remains this GitHub repository. Vercel `luna-th1h-control-room` is the active Next.js deployment target. Supabase remains the database/auth/edge-function boundary. The separate FastAPI execution/market gateway is a long-running service; its former Railway domain currently returns `404 Application not found` on both `/health` and `/quotes/public-stream`, so the gateway is not currently reachable at that hostname. This is not a frontend routing fix.

No broker or real-money execution MCP is approved for the LUNA runtime. Paper mode, kill switches, source verification, and backend risk gates remain authoritative.

## Catalog review method and limits

- Read the curated catalog JSON from [mcpHQ/awesome-mcp-servers](https://github.com/mcpHQ/awesome-mcp-servers/blob/main/data/servers.json): **598 catalog entries**. This is an index, not a single canonical list or proof that every entry is maintained.
- The curated catalogue marks 455 entries as `official` and 143 as community-maintained; those are catalogue labels, not an independent security certification.
- Category distribution in that snapshot: Finance/Commerce/Business 123; Communication/Productivity 74; Developer Tools/Code Intelligence 66; AI Agents/Memory 65; Data Analytics/BI 63; Browser/Search/Web Automation 61; Security/Identity 29; Cloud/Infrastructure 29; Utilities/Examples 25; Documents/Filesystem 24; Database/Storage 18; Official/Reference 11; Legal/Court Data 9; Logistics/Shipping 1.
- Reviewed the official [MCP Registry](https://registry.modelcontextprotocol.io/) API and pagination contract. Query `version=latest`, use the opaque `nextCursor`, and deduplicate by canonical server name. A full registry snapshot was not treated as complete solely because the first page returned; the official registry is mutable.
- Deep source review was focused on repositories that affect LUNA's browser automation, deploy pipeline, database access, market research, or security. The 598 index entries were not all cloned or source-audited; do not represent this review as a security audit of all 598 packages.

## Selected repository review

| Repository | Finding | LUNA decision |
|---|---|---|
| [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry) | Canonical registry API; cursor pagination; version filtering. | Use as the authoritative discovery source. Resolve latest versions and inspect ownership/status before selection. |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Reference/example implementations; useful for protocol patterns but not automatically production-hardened. | Use for learning and interoperability examples only. |
| [mcpHQ/awesome-mcp-servers](https://github.com/mcpHQ/awesome-mcp-servers) | Curated 598-entry index; broad discovery, but catalogue flags do not certify safety or freshness. | Use for discovery and categorization, not as a trusted install manifest. |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Apache-2.0; browser-session MCP with iterative inspection. Its README distinguishes this from the CLI workflow for coding agents. | Do not add a duplicate MCP dependency to this repo. Use the existing Playwright runner for deterministic regression and MCP/browser session tools for interactive diagnosis. |
| [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) | Apache-2.0; official CLI + skills workflow. The checked package referenced a prerelease Playwright build at audit time. | Adopt the CLI/skills operating pattern, but pin stable versions before adding it as a repo dependency. Existing Playwright tests already cover the needed workflows. |
| [supabase/mcp](https://github.com/supabase/mcp) | Official Supabase MCP; supports project scoping and read-only mode. | Prefer the connected Supabase connector with least privilege; use `project_ref` and `read_only=true` for diagnostic sessions. Do not attach broad write access just for inspection. |
| [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) | MIT; source defaults to `UNRESTRICTED` unless configured otherwise; restricted mode is read-oriented. | **Do not use defaults against production.** Only consider in an isolated workspace with `--access-mode restricted` and a read-only database role. |
| [upstash/context7](https://github.com/upstash/context7) | MIT; retrieves current library/framework documentation. | Already available as a connector; use it to verify current API contracts instead of duplicating the server. |
| [getsentry/sentry-mcp-stdio](https://github.com/getsentry/sentry-mcp-stdio) | Legacy STDIO repository points users to the newer Sentry MCP. | Do not install the superseded STDIO package. Use the maintained remote Sentry service if/when Sentry observability is connected. |
| [financial-datasets/mcp-server](https://github.com/financial-datasets/mcp-server) | Market/company data product focused on US securities. | Not a replacement for SET/mai source-of-record data. Do not use it to synthesize Thai quotes or order books. |
| [alpacahq/alpaca-mcp-server](https://github.com/alpacahq/alpaca-mcp-server) | Trading-oriented API surface can reach order-related functionality and is designed around Alpaca-supported US markets. | Excluded from LUNA's production toolchain. No third-party order-execution MCP may bypass LUNA's backend admission and kill-switch controls. |
| [cloudflare/mcp-server-cloudflare](https://github.com/cloudflare/mcp-server-cloudflare) | Broad Cloudflare resource-management surface. | Optional only if infrastructure is intentionally moved to Cloudflare. Not required while the existing Vercel frontend is healthy. |
| [vercel-labs/mcp-on-vercel](https://github.com/vercel-labs/mcp-on-vercel) | Repository is archived. | Do not select as a primary deployment integration. Use the maintained Vercel connector and pinned GitHub workflow. |

## Current connector/tooling choice

| Need | Preferred tool | Why |
|---|---|---|
| Source code, branches, PRs, Actions | Connected GitHub MCP | Directly scoped to `ceos-platform`; use commit-pinned branches and reviewable PRs. |
| Frontend deployment, preview, logs | Connected Vercel MCP | Project is already linked to this repository and deploys Next.js correctly. Keep SSO/protection enabled. |
| Database/auth/edge functions | Connected Supabase MCP | Project-scoped native integration; least privilege and SQL/RLS rules remain in force. |
| Browser regression | Playwright CLI/Test runner | Reproducible E2E, assertions, traces and repeatable runs. |
| Interactive browser diagnostics | Browser Use or Firecrawl browser session | Use for live exploration; do not substitute for deterministic test assertions. |
| Current technical documentation | Context7 connector | Verify current SDK/framework contracts before coding. |
| Gateway hosting | Long-running container web service | FastAPI/WebSocket gateway requires a persistent service, separate from the Next.js/Vercel UI. |

## Hosting assessment

- **Vercel:** selected and verified for the Next.js frontend. A preview deployment from the baseline Git SHA reached `READY`; SSO protection remains on. A shareable preview URL is temporary and must not replace the protected production domain.
- **Railway:** former gateway host `luna-execution-gateway-production.up.railway.app` currently returns HTTP 404 `Application not found`, including on `/health`. Railway connector account lists no accessible projects, so this hostname is not a usable gateway endpoint at audit time.
- **Render:** suitable technical candidate for a separate FastAPI/WebSocket web service. Its free web services spin down after 15 minutes with no inbound HTTP request or WebSocket message, and Render explicitly says free instances are not for production. The current Starter compute plan is 0.5 CPU / 512 MB and the official price page listed $7/month at audit time; the workspace owner must choose the workspace and approve a paid plan before a production service is created. A free preview may validate builds/routes only; it is not production HA.
- **Fly.io:** technically supports long-running machines, but requires a separate app/account deployment workflow and region/volume/billing configuration; no connected app project was present to manage it. Do not create an unscoped paid VM.

## LUNA-specific safety requirements for future MCP additions

1. No MCP may place, amend, cancel, or route broker orders for LUNA. Broker execution remains backend-guarded and locked.
2. Market values, candles, books and fills must keep source, source timestamp, ingestion timestamp, freshness and validation state. A missing field remains unknown, not zero or synthetic.
3. Database diagnostic tools must be project-scoped and read-only. Never run an unrestricted SQL server against production.
4. New MCPs must be pinned to a reviewed version, checked for license and maintenance, sandboxed, and tested with non-production credentials before being exposed to agents.
5. Secrets must be entered through a secure secret manager or provider dashboard. Never paste them into code, PRs, logs or chat.
6. A repository change is not production-ready until typecheck, architecture/data-quality/safety tests, browser tests and a preview smoke test have passed on the exact commit SHA.
7. Deployment release and data readiness are distinct. Vercel `READY` means the UI deployed; it does not imply fresh market data, current gateway connectivity or order readiness.

## Immediate follow-up findings

- The live LUNA browser check found a repeated WebSocket handshake failure against the Railway hostname. Direct HTTP checks also returned `404 Application not found` for `/health`; the original repository's FastAPI source does contain `/health` and `/quotes/public-stream`. This indicates the public hostname no longer maps to the gateway service, rather than a missing route in the checked source.
- The frontend now has a regression guard so authorization/configuration close codes `4401` and `4403` do not trigger futile infinite reconnects. Transient reconnect delay uses a 5-second base and a 60-second ceiling.
- The current dashboard reports 0/930 verified books and a stale public fallback quote. Do not mark the system execution-ready until authorized market data is fresh and coverage gates actually pass.
