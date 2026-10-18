# LUNA quote regression investigation — 2026-10-18

## Regression matrix

Owner references: `202610170003` and `202610170001`.

Run from `luna-th1h/`:

```sh
npm install --no-audit --no-fund
npm run test:quote-regression
npm run typecheck
```

The test matrix runs offline with a deterministic clock and synthetic inputs. It does not call TopTrader, write to Supabase, create paper/live orders, or enable live trading.

| Case | Expected behavior |
|---|---|
| Fresh quote | Accept only with usable price/book and explicit verification |
| Stale quote | Reject |
| Missing fields/prices | Reject; JSON null must remain null, not numeric zero |
| Future source timestamp | Reject |
| Invalid/crossed bid-ask | Reject |
| Missing verification provenance | Reject for non-Settrade/public fallback sources |
| SELL with zero position | Reject with `NO_LONG_POSITION` |
| Duplicate snapshot | Suppress exact duplicate; emit when source timestamp changes |

## Production findings (read-only inspection)

- `luna_market_ingest_batches` contains 259 accepted `TOPTRADER_REALTIME` batches and an aggregate 18,912 tick rows recorded in batch metadata. The latest batch timestamp observed was 2026-10-15 08:35:02 UTC (15:35 ICT).
- `luna_market_ticks` and `luna_worker_quote_cache` each had zero rows at the time of inspection.
- This database is intentionally configured to trim `luna_market_ticks` older than 35 minutes. Cron job 11 runs every five minutes; the free-tier retention job repeats the same tick retention policy every 30 minutes. Therefore an empty tick table on a closed-market day is not, by itself, proof that TopTrader failed.
- The TopTrader REST/WS ingest cron jobs are configured for weekdays, while the inspection date (2026-10-18) is Sunday. The Stock Exchange of Thailand listed Friday 2026-10-16 as an additional special holiday; thus 2026-10-15 was the last normal trading day before the weekend.
- Read-only provider probes on 2026-10-18 confirmed that the REST API returned symbols, but the latest examined tick observation was from 2026-10-15 and there were zero fresh tick observations, zero fresh matching books, zero two-sided depth symbols, and zero bid/ask-to-depth matches. The WebSocket probe opened the connection but received 0 frames and no tick/book symbols. These results are consistent with a closed market and the provider serving stale end-of-session data; they do not establish whether the feed will resume correctly at the next market open.
- The gateway reports TopTrader as a paper/continuity source. The gateway's live-readiness coverage matcher recognizes SETTRADE and SET_API only; TopTrader snapshots must not be used as authorization for live order routing.
- The data path is split: the TopTrader ingest Edge Functions call `luna_ingest_verified_market_batch` to insert verified ticks into `luna_market_ticks`; the worker cache `luna_worker_quote_cache` is populated separately by `luna-worker-api` telemetry batches sent by the TypeScript worker. An accepted TopTrader batch alone does not populate the worker cache.
- Retention inspection confirms `luna_free_tier_retention_v1` and `luna_trim_market_ticks_retention_v1` delete old `luna_market_ticks` but do **not** delete `luna_worker_quote_cache`. The zero-row worker cache therefore cannot be explained by the 35-minute tick-retention rule; together with all Railway worker services being Offline, it points to a separately absent or non-reporting worker telemetry path (an explicit deletion or a separate issue is not ruled out).
- The TopTrader cron wrappers call `net.http_post(...)` and return its request ID; a `cron.job_run_details` result of `succeeded / 1 row` confirms the SQL enqueue step, not the final Edge Function response or successful tick ingestion. During ingestion, the deployed function explicitly returns `OUTSIDE_MARKET_WINDOW` outside its market calendar/window and `NO_FRESH_MATCHED_BOOK` if it cannot assemble fresh quote/book matches. Because the last accepted batch is 15:35 ICT on Thursday 15 October (about 55 minutes before the regular session's 16:30 close), the precise reason no further batches were accepted that Thursday is still unresolved; the 16 October holiday and weekend explain the later gap, but cannot by themselves explain the early stop on 15 October. Capture the Edge Function response/rejection counters during the next actual market session before inferring a provider outage or loosening any freshness gate.
- Paper-cycle telemetry is also stale despite minute cron calls succeeding. Production runtime `LUNA-PAPER-LIVE-15M-VERIFIED` is marked `RUNNING` and its heartbeat updated on Sunday 2026-10-18 10:21 UTC, but `last_signal_bar_end` is still 2026-10-15 08:30 UTC, the latest equity snapshot is from that same Thursday bar, and the last ledger fill was 2026-10-15 07:47 UTC. The older `LUNA-PAPER-LIVE-15M` runtime is `PAUSED` with a heartbeat last updated 2026-10-12. Jobs 3 (shadow scheduler) and 8 (paper cycle) each had one `job startup timeout` in the last 24 hours but were succeeding at the latest check. The function code confirms job 8 can emit an idle heartbeat when there is no session today; that is not evidence of fresh market data or a new trade. The runbook now includes explicit paper-runtime, latest-bar, equity-snapshot and fill freshness queries so the next open check does not confuse liveness with progress.
- The current DB verified-ingest RPC validates timestamps, book fields, universe membership, and row persistence before marking a new batch accepted. Its early idempotency return, however, trusted an old accepted batch row without checking that retained tick rows still exist. A staged migration now checks that the exact expected number of tick rows tagged with the batch ID still exists before returning idempotent success; expired/partial batches fail closed with `IDEMPOTENCY_TICKS_NOT_RETAINED`. The migration is in this PR only and has NOT been applied to production. A static source-contract test and a disposable-Postgres integration suite now guard and exercise these scenarios in CI. The integration run passed at [GitHub Actions run 39116359949](https://github.com/sakdiphongkan-ops/ceos-platform/actions/runs/39116359949), including the quote matrix, migration contract, disposable-Postgres accepted/expired/partial/fresh cases, and TypeScript typecheck. Neither test applies the migration to production.
- Railway's `LUNA-TH1H` production project has no deployment with status `SUCCESS` in the deployment list returned at inspection time. The latest worker deployment attempt shown by `latestDeployment` is `FAILED` (2026-09-25); later worker builds from that date are marked `REMOVED`. The worker service has no service domain, and the gateway's most recent non-removed deployment is a failed health check; later gateway deployments are also marked `REMOVED`. This is stronger evidence of an absent/unverified Railway consumer than the empty worker cache alone. The worker's historical build error is TypeScript `TS2322`: lowercase `"shadow"` is not assignable to enum `M1OverlayAction` (`"SHADOW"`/`"ENFORCE"`). The gateway build completed, but Railway health-check attempts to `/health` returned HTTP 500 in that historical deployment. These deployment events date to 2026-09-25, so they establish that the connected project has no validated newer rollout, not that no separate platform/service exists elsewhere. Treat the Railway consumer path as unavailable/unverified until a successful deployment and post-open quote flow are observed.
- Migration source control is behind the connected database: the production migration registry includes several 2026-10-18 migrations that are absent from the repository's `supabase/migrations` directory. The proposed patch was generated from the current installed function definition and has been staged as a new migration, but no production schema change was run.

- A deeper read of `cron.job_run_details` found 21 historical scheduler startup timeouts in the last seven-day window: REST batch job 10 had 3 failures / 438 successes, priority REST job 12 had 9 failures / 2,193 successes, and WS job 13 had 9 failures / 2,148 successes. The failing window was 2026-10-16 07:24–08:53 UTC (14:24–15:53 ICT); each failure reported `job startup timeout`. All three continued succeeding later that day (latest job 10 success 23:56 UTC; jobs 12/13 success 23:59 UTC). Thus the scheduler was not permanently disabled, but the timeouts are a separate intermittent reliability issue; their root cause is not proven. At inspection, cron timezone was GMT, `cron.use_background_workers=off`, `max_worker_processes=6`, database connections were 23/60, and no cron jobs were currently running. These snapshots do not prove worker-process or connection exhaustion, so no scheduler setting was changed.
- A gateway regression check was added as `luna-execution-gateway/test_health_liveness.py`: it patches readiness diagnostics to throw and asserts `/health` remains HTTP 200 and reports `LOCKED` with live trading disarmed. The CI workflow runs this liveness regression, the existing order-guard tests, Python compile checks, and the quote/migration suite. Both jobs passed on commit `5d7c6828691acdcdb720be80520f1bffaad4261e`: [quote regression matrix](https://github.com/sakdiphongkan-ops/ceos-platform/actions/runs/39118376639), with the gateway liveness step, order-guard suite, and compile check all green.

## Safe next checks

1. During the next SET/mai session, inspect the scheduled TopTrader ingest function response and the verified-feed heartbeat before the 35-minute retention window expires.
2. Compare the batch RPC result (`rows_ingested`, `idempotent`, rejection reason) to the actual tick count and latest tick timestamp immediately after ingestion.
3. Verify a successful Railway gateway/worker deployment and quote counts before declaring the consumer path healthy.
4. Do not disable retention globally: it is a deliberate storage-control mechanism. Fix the idempotency/heartbeat semantics and validate worker consumption instead.
