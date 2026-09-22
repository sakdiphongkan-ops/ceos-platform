# LUNA Realtime Hardening v2

Date: 2026-09-22

## Runtime

### Fair telemetry batching
- Ticks remain coalesced by session + symbol.
- Signals remain FIFO and bounded.
- When both queues are busy, a configurable share of each batch is reserved for fresh ticks.
- When no signals are waiting, the queue drains available ticks at full batch capacity.
- Queue diagnostics now expose coalesced ticks, flushed batches/items, and failed flushes.
- Configuration: `LUNA_TELEMETRY_TICK_SHARE`, default 0.25.
- HOLD quotes are now persisted at most 250 ms apart by default (configurable with `LUNA_HOLD_TICK_PERSIST_MS`) instead of the previous 5 s throttle, keeping the fast state near real time without writing every raw quote.

### Session-close reliability
Session shutdown now treats reconciliation, snapshot, telemetry flush, audit, and database session-close as independent stages. A telemetry failure is recorded but does not prevent the final `end_session` request.

### Out-of-order market-data protection
`public.luna_update_fast_live_tick` now rejects an older quote timestamp when the stored `last_quote_ts` is newer. The batch RPC inherits the same ordering guard.

## Security

### Research data surface
- `luna_research_prices` is explicitly read-only for anon/authenticated clients.
- Anonymous reads are limited to the fixed public research dataset and historical date window already used by the export/helpers.
- `luna_research_prices_export_v1` uses caller permissions/RLS instead of owner-bypass behavior.
- `luna_research_month_blob` and `luna_research_symbol_batch` execute as invoker.
- `luna_research_ranked_v2` has RLS, read-only client grants, and primary key `(symbol, month_end)`.

## Verification

- Telemetry queue test: PASS using Node 22 TypeScript stripping.
- Fast-tick order-guard rollback test: PASS; a newer quote at price 101 remained after an older quote at price 99 was submitted.
- Batch fast-tick order-guard test: PASS; final state remained on the newer quote.
- Anonymous research view/helper test: PASS; view, monthly blob, symbol batch, and ranked table remained readable under explicit policies.
- Supabase security advisor: previous research SECURITY DEFINER/view/RLS-ranked errors are no longer present; remaining finding is the existing set of 16 RLS-enabled tables without policies.
- Supabase performance advisor: the ranked_v2 primary-key finding and overlapping-policy warning were removed; remaining findings are unused-index INFO notices.
- GitHub combined-status endpoint returned no status entries for the current head, so full GitHub Actions CI is not claimed as independently verified here.