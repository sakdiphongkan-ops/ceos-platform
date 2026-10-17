# LUNA paper valuation guard — staging validation plan

Status: draft only. None of the draft migrations has been applied to Supabase or Production, and SQL execution tests are still outstanding.

## Included draft migrations
- `202610170001_luna_paper_snapshot_valuation_guard.sql`: defense-in-depth trigger for snapshot inserts/updates.
- `202610170003_luna_cycle_fail_closed_valuation.sql`: replacement for the current cycle function, captured from the live database read-only on 2026-10-17 and modified to remove average-cost fallback, enforce a 60-second quote freshness window, return `VALUATION_INCOMPLETE` with missing symbols, avoid writing incomplete snapshots or updating peak equity, and timestamp complete snapshots at valuation time.\n- `202610170004_luna_verified_ingest_marker.sql`: replacement for the existing verified-batch ingestion function. After the configured source, freshness, complete-book, row integrity, positive bid/ask/sizes, active-universe and open-session checks pass, the database stamps the tick JSON with explicit verification metadata. It rejects malformed/null payloads and stale individual ticks. This contract is drafted from the current function definition read-only on 2026-10-17; it has not been executed or tested.

## Safety contract
- A held position is markable only with a recent `TOPTRADER_REALTIME` quote, valid positive bid/ask and sizes, ask >= bid, timestamp no more than one second in the future and no older than 60 seconds, plus explicit verification marker `raw.data_quality = "verified"` or `raw.verified = true`.
- Mark-to-market uses bid as the liquidation-side mark; it never substitutes `avg_price`.
- If any open position is unpriced, the cycle returns `status = VALUATION_INCOMPLETE`, `valuation_ready = false`, lists `unpriced_symbols`, writes no equity snapshot and does not update peak equity. Runtime cash/reservations/realized P&L/fees and heartbeat are updated so the paper ledger remains observable.
- With zero open positions, cash-only valuation is permitted.
- The JSON verification marker is now designed to be stamped by the database ingestion function only after its source and row-validation checks pass; that new ingestion-function migration must be tested together with the cycle guard before rollout. Current database evidence reports zero TOPTRADER_REALTIME ticks in the last 24 hours, so the correct current behavior is to block valuation rather than invent a mark.

## Regression cases required before rollout
Run on an isolated, no-cost local PostgreSQL/Supabase-compatible test instance, not the production database:
1. Fresh verified quote for every open position: valuation succeeds and snapshot timestamp is current.
2. Quote older than 60 seconds: valuation incomplete; no snapshot or peak-equity update.
3. Missing quote for one position and partial coverage: missing symbol is listed; no snapshot.
4. Future timestamp more than one second ahead: valuation incomplete.
5. Null/zero bid, null ask, ask < bid, or nonpositive sizes: valuation incomplete.
6. Wrong source or missing verification marker: valuation incomplete.
7. Zero open positions: cash-only valuation is allowed.
8. Repeat calls and snapshot uniqueness: no duplicate/overwrite surprises.
9. Verify incomplete valuation leaves prior verified snapshot and peak drawdown state unchanged.
10. Invalid/null payload, duplicate symbol, stale row timestamp, missing sizes, zero bid/ask, or source not configured/book-grade is rejected and never receives a verified marker.\n11. An accepted batch receives `data_quality=verified`, `verified=true`, source, batch ID and verified timestamp; caller-supplied raw fields cannot override those database-stamped values.\n12. Compare SQL and TypeScript results on identical fixtures, including cash, market value, realized/unrealized P&L, fees, slippage and drawdown.

## Rollout gate
- Confirm the actual ingestion JSON contract for verification markers.
- Run the complete regression matrix on an isolated no-cost environment. Do not create a paid branch or project.
- Review the full function replacement and prepare rollback from the captured prior definition.
- Confirm the UI/API never labels a stale snapshot as current.
- Keep paper-only mode, live-trading disarmed, and gateway kill switch enabled.
- Do not apply to production while the feed is stale or missing; current evidence says no TOPTRADER_REALTIME ticks in the last 24 hours.
