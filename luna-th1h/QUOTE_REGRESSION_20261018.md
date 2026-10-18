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
- The current DB verified-ingest RPC validates timestamps, book fields, universe membership, and row persistence before marking a new batch accepted. Its early idempotency return, however, trusts an old accepted batch row without checking that retained tick rows still exist. The retained batch table may therefore say a previous batch was accepted after its raw tick rows have expired. This should be hardened separately so the metadata is not mistaken for a live feed heartbeat.
- Railway's latest listed deployments for the worker and gateway were `FAILED`. A worker build log reports a TypeScript `M1OverlayAction` enum mismatch; the gateway deployment failed its health check. Those deployment records are older than this investigation and do not alone establish the current process state, but the connector did not show a successful newer deployment to validate. Treat this as an unresolved consumer-path risk until a successful build/deployment and post-open quote flow can be observed.

## Safe next checks

1. During the next SET/mai session, inspect the scheduled TopTrader ingest function response and the verified-feed heartbeat before the 35-minute retention window expires.
2. Compare the batch RPC result (`rows_ingested`, `idempotent`, rejection reason) to the actual tick count and latest tick timestamp immediately after ingestion.
3. Verify a successful Railway gateway/worker deployment and quote counts before declaring the consumer path healthy.
4. Do not disable retention globally: it is a deliberate storage-control mechanism. Fix the idempotency/heartbeat semantics and validate worker consumption instead.
