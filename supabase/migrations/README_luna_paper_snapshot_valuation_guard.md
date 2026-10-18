# LUNA paper valuation guard — rollout and market-open validation

## Status as of 2026-10-18 (Asia/Bangkok)

The three database migrations below were applied to the production Supabase project on 2026-10-18, after isolated PostgreSQL 16 regression tests passed in GitHub Actions run #1559.

- `202610170004_luna_verified_ingest_marker.sql` — `public.luna_ingest_verified_market_batch(...)` now stamps database-owned verification metadata only after source, freshness, complete-book, row integrity, positive prices/sizes, active-universe and open-session checks pass.
- `202610170003_luna_cycle_fail_closed_valuation.sql` — `public.luna_run_live_paper_cycle(...)` requires a fresh verified `TOPTRADER_REALTIME` book for every open position, has no average-cost fallback, writes no equity snapshot and does not update peak equity when valuation is incomplete, and uses the current valuation timestamp for complete snapshots.
- `202610170001_luna_paper_snapshot_valuation_guard.sql` — enabled trigger blocks snapshot INSERT/UPDATE when any held position lacks a fresh, valid verified book in the exact session.

No Supabase branch/project was created and no paid infrastructure was used. No broker calls or real orders were made.

## Verified evidence

- CI run #1559: `typecheck`, `db_verified_ingest_regression`, and `db_paper_valuation_regression` passed. The PostgreSQL 16 behavioral matrix covered complete quotes, missing/stale/unverified/wrong-source/future/malformed quotes, partial position coverage, cash-only accounts, preservation of the previous snapshot and peak equity, insert/update trigger rejection, and old-session weekend/holiday idling.
- Production read-only checks confirmed the ingest function stamps `data_quality=verified`, `verified=true`, verification source and batch ID; the cycle function contains the 60-second guard and no former `coalesce(t.last,p.avg_price)` fallback; and the snapshot guard trigger is enabled.
- A production cycle invocation on Sunday 2026-10-18 returned `IDLE_OUTSIDE_MARKET_SESSION`, `live_orders_created=false`, and `live_fills_created=false`. Snapshot count remained 30; latest snapshot timestamp remained 2026-10-15 08:30 UTC (15:30 Bangkok). No new snapshot was written on the closed market.
- There are 16 open paper positions. The retained tick table currently has zero rows and no fresh verified ticks; the most recent accepted TOPTRADER batch was received at 2026-10-15 08:35 UTC (15:35 Bangkok). Market ticks are subject to retention, so absence of retained rows alone is not proof of an upstream feed failure.
- The Stock Exchange of Thailand lists Friday 2026-10-16 as an additional special holiday; Saturday 17 and Sunday 18 are the weekend. Therefore the absence of new ticks during that interval is expected, but live-feed health has not yet been proved for the next trading session.

## Safety contract

- A held position is markable only with a recent `TOPTRADER_REALTIME` quote, valid positive bid/ask and sizes, ask >= bid, timestamp no more than one second in the future and no older than 60 seconds, plus the explicit verification marker `raw.data_quality = "verified"` or `raw.verified = true`.
- Mark-to-market uses bid as the liquidation-side mark. It never substitutes `avg_price`.
- If any held position is unpriced, the cycle returns `status = VALUATION_INCOMPLETE`, lists `unpriced_symbols`, writes no snapshot and does not update peak equity. This prevents a fresh-looking P&L from being invented during a feed outage.
- With zero open positions, cash-only valuation is permitted.
- This is a paper-only workflow. It must not place real broker orders. Live trading remains disarmed.

## Next market-open validation gate

Run only during the next official SET trading session; do not fabricate a quote or use a stale cached price.

1. Confirm the TopTrader REST and WebSocket probes return fresh timestamped tick and book observations for a sample of active symbols.
2. Confirm accepted batches arrive and each inserted tick has the database-owned verification marker.
3. Confirm all 16 held paper symbols (and any position changes) have a matching valid book no older than 60 seconds, with positive bid/ask sizes and non-crossed prices.
4. Confirm a complete valuation creates a snapshot timestamped near the current time and the equity math reconciles to cash plus liquidation-side marked positions, fees, and realized/unrealized P&L.
5. If any gate fails, expect `VALUATION_INCOMPLETE` or no-session idle and no new snapshot/peak-equity update. Keep the PR in Draft until this live feed validation is evidenced.

## Rollback / change discipline

The migrations change database function/trigger definitions but do not rewrite historical fills or snapshots. Do not manually edit prior snapshots to make them look current. Any rollback must restore a captured prior function definition and re-run the same regression suite before rollout.