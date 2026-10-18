# LUNA paper valuation guard — rollout and market-open validation

## Status as of 2026-10-18 (Asia/Bangkok)

Five database migrations were applied to the production Supabase project on 2026-10-18 after isolated PostgreSQL 16 regression tests passed in GitHub Actions run #1585. The REST market-ingest Edge Function was deployed as version 11 on 2026-10-18; this does not enable trading or change the paper-only contract.

- `20261018014106_202610170004_luna_verified_ingest_marker.sql` — `public.luna_ingest_verified_market_batch(...)` now stamps database-owned verification metadata only after source, freshness, complete-book, row integrity, positive prices/sizes, active-universe and open-session checks pass.
- `20261018014120_202610170003_luna_cycle_fail_closed_valuation.sql` — `public.luna_run_live_paper_cycle(...)` requires a fresh verified `TOPTRADER_REALTIME` book for every open position, has no average-cost fallback, writes no equity snapshot and does not update peak equity when valuation is incomplete, and uses the current valuation timestamp for complete snapshots.
- `20261018014128_202610170001_luna_paper_snapshot_valuation_guard.sql` — enabled trigger blocks snapshot INSERT/UPDATE when any held position lacks a fresh, valid verified book in the exact session.
- `20261018020812_luna_ingest_rejected_batch_idempotency_20261018.sql` — only a previously accepted batch is treated as an idempotent success; rejected batches are revalidated, and partial tick insert conflicts are removed and returned as `TICK_INSERT_CONFLICT`.
- `20261018021547_luna_ingest_source_lookup_fail_closed_20261018.sql` — captures `FOUND` after source registry lookup and requires configured/enabled/execution-grade/book-grade flags to be explicitly true; a missing source row or NULL flag cannot bypass validation.

No Supabase branch/project was created and no paid infrastructure was used. No broker calls or real orders were made.

## Verified evidence

- LUNA-TH1H CI run #1611: `typecheck`, `edge_functions_typecheck`, `db_verified_ingest_regression`, and `db_paper_valuation_regression` passed. The PostgreSQL 16 tests include marker RED/GREEN, rejected-batch retry idempotency, partial-insert collision handling, unknown-source fail-closed behavior, stale/future feed timestamps, incomplete/crossed books, duplicate symbols, inactive universe membership, missing session, partial position coverage, cash-only account, snapshot preservation, INSERT/UPDATE trigger rejection, and duplicate snapshot upsert (valid conflict updates one row; incomplete conflict cannot overwrite the verified snapshot).
- Production read-only checks confirmed the ingest function stamps `data_quality=verified`, `verified=true`, verification source and batch ID; the cycle function contains the 60-second guard and no former `coalesce(t.last,p.avg_price)` fallback; and the snapshot guard trigger is enabled.
- The current production runtime remains `RUNNING` with `paper_only=true`, a fresh heartbeat at 2026-10-18 11:46 Bangkok, cash THB 1,455.731524 and zero queued paper orders. Snapshot count remains 30; latest snapshot timestamp remains 2026-10-15 08:30 UTC (15:30 Bangkok). No fresh valuation snapshot was written on the closed market.
- There are 16 open paper positions. The retained tick table currently has zero rows and no fresh verified ticks; the most recent accepted TOPTRADER batch was received at 2026-10-15 08:35 UTC (15:35 Bangkok). A fresh read-only probe against REST Edge Function v11 on 2026-10-18 at 11:42 Bangkok returned HTTP 200 and `no_database_writes=true`. It returned tick and book rows for all 16 held symbols but **0/16 fresh matching two-sided books**. The ARIN tick observation timestamp was `2026-10-15T10:47:29Z` (approximately 65.9 hours old at probe time), while the book observation timestamp was null despite a current API `generatedAt`; the result correctly set `execution_snapshot_valid=false`. The WebSocket probe connected but received zero frames outside market hours. The official TopTrader docs distinguish market-event timestamps (`datetime`) from API response-generation timestamps (`generatedAt`), so the current-generation time cannot substitute for a fresh book observation ([TopTrader Market Data API](https://developers.toptrader.co.th/docs/)). Market ticks are subject to retention, so absence of retained rows alone is not proof of an upstream feed failure.
- The Stock Exchange of Thailand lists Friday 2026-10-16 as an additional special holiday; Saturday 17 and Sunday 18 are the weekend. The internal trading calendar marks Monday 19 October as the next trading day. No accepted batches arrived in the last 24 hours; in the 15:00 Bangkok hour on 15 October, only 3 batches / 21 ticks were accepted (with no recorded rejected batches), a late-session coverage drop that still needs to be checked during an open market. The cron logs' `1 row` return only proves the SQL wrapper ran/queued its request, not that ingestion accepted fresh rows. Live-feed health therefore remains unproven.

## Safety contract

- A held position is markable only with a recent `TOPTRADER_REALTIME` quote, valid positive bid/ask and sizes, ask >= bid, timestamp no more than one second in the future and no older than 60 seconds, plus the explicit verification marker `raw.data_quality = "verified"` or `raw.verified = true`. The REST adapter also rejects tick observations older than 50 seconds and book observations older than 30 seconds; the WebSocket adapter has 25-second tick/book/pair-skew gates.
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