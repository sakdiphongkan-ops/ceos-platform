---
name: mcp-tooling
description: Safe discovery, assessment and integration of MCP servers and deployment connectors for LUNA/ceos-platform.
---

# LUNA MCP tooling skill

## Purpose

Choose and operate MCPs as narrowly-scoped engineering tools. Do not add MCPs simply because they appear in a directory. Use the review register in [MCP_TOOLING_AUDIT.md](../../../docs/MCP_TOOLING_AUDIT.md).

## Discovery

1. Query the official MCP Registry with `version=latest`.
2. Follow only the returned opaque `nextCursor`; never fabricate or edit a cursor.
3. Deduplicate by canonical server name. A registry listing is discovery metadata, not a security certification.
4. Use curated lists only as secondary indexes. Confirm the repository, owner, release, license, maintenance status and exact package source independently.

## Security review checklist

Before adding any MCP server, record:

- Canonical GitHub/repository owner and exact version/commit.
- License and whether upstream is active, archived or superseded.
- Tool scopes and mutations (read, create, update, delete, deploy, trade).
- Auth model, project/account scoping, environment exposure, secret handling and outbound network access.
- Default modes and least-privilege flags. A database MCP with an unrestricted default is not acceptable for production.
- Dependency stability, transitive packages, telemetry and update strategy.
- Test plan in an isolated project with non-production credentials.

## LUNA policy

- Keep market-data, research, and execution permissions separated.
- Use GitHub/Vercel/Supabase connectors already linked to the intended project before adding duplicate third-party MCPs.
- Use Playwright Test for deterministic browser regression. Use interactive browser tools for exploratory diagnosis, not as a substitute for test assertions.
- Use Supabase project scoping and read-only access for data inspection.
- Never run `crystaldba/postgres-mcp` with its unrestricted default against LUNA production; require restricted mode and a DB role that is itself read-only.
- Exclude trading/order MCPs from the LUNA production agent toolset. No external MCP may bypass server-side order admission, idempotency, risk checks, paper-only mode or kill switches.
- Keep secrets out of source, issue text, chat transcripts, browser console output and test artifacts.

## Release verification

A code change is not complete because an MCP reports a successful operation. Verify all of the following on the exact commit:

1. Typecheck and production build.
2. Architecture, RLS, data-quality, PIT, risk-gate and paper-only tests relevant to the change.
3. Browser E2E and accessibility/overflow checks.
4. Preview deployment state and direct HTTP/browser smoke tests.
5. Backend health, source revision, authorized feed status, quote freshness and verified book coverage.
6. Confirm live execution remains locked.

Never infer market freshness or execution readiness from deployment state.
