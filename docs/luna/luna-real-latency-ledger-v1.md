# LUNA real latency ledger v1

The TH1H worker records a `LATENCY_METRIC` audit event after each non-HOLD execution completes.

Recorded fields include:

- `quote_ts`
- `market_lag_ms`
- `prewarm_ms`
- `analysis_ms`
- `queue_wait_ms`
- `execution_ms`
- `end_to_end_ms`
- `market_phase`
- `source`

The production `luna-api` Edge Function v33 exposes:

- default feed: `latency.summary`
- dedicated view: `?view=latency`
- percentile metrics: p50 / p95 / p99 / max
- sample count

Important interpretation rule:

`sample_count = 0` means that no execution has produced a `LATENCY_METRIC` event yet. It must not be displayed as a measured zero-latency result.

The synthetic latency/backpressure harness remains separate from this real execution ledger. The harness validates processing capacity; the production ledger measures observed runtime latency.

## Latency interpretation update — 2026-09-21

`prewarm_ms` measures the point-in-time strategy warm-up lookup performed before a symbol can be evaluated. It is included so a slow historical lookup is not incorrectly attributed to the core signal calculation.

Session startup now keeps only the mandatory session-creation request on the quote critical path. The initial audit event is queued and the opening snapshot is written asynchronously; session shutdown still waits for the audit queue and writes a final snapshot before closing the session.

The market clock is implemented as a deterministic `marketPhaseAt()` function in `luna-th1h/src/market-session.ts` and regression-tested across ACTIVE, lunch CLOSED, REDUCE_ONLY, FORCE_CLOSE, post-close, weekend, and invalid close-time ordering cases.

## Async prewarm update — 2026-09-21

Strategy prewarming no longer blocks the quote analysis critical path. On the first quote for a symbol, LUNA starts a bounded single-flight `recent_ticks` lookup in the background while the live quote is evaluated immediately.

When the historical seed arrives, it is applied only if the symbol still has a sparse live state (at most two live prices). Existing live prices are replayed on top of the historical seed. A mature live state is never overwritten by late warm-up data.

Warm-up results are generation-scoped to the active session. A warm-up request that completes after a session closes or rolls over cannot populate the next session's strategy state.

Latency logs therefore distinguish:
- `prewarm_ms`: blocking prewarm time on the critical path (expected 0 after this change)
- `prewarm_applied`: whether a completed historical seed was merged
- `prewarm_fetch_ms`: elapsed time of the background historical lookup

## Bounded execution update — 2026-09-21

The execution path now uses bounded concurrency of four jobs with FIFO ordering per symbol. Different symbols can execute concurrently, while repeated orders for the same symbol remain serialized.

A reservation ledger is applied before the first network await. BUY orders reserve estimated cash and gross exposure; SELL orders reserve sellable quantity. The planner subtracts these reservations when calculating available capacity, preventing concurrent jobs from independently consuming the same portfolio headroom.

Live-order reservations remain held until broker reconciliation reaches a terminal state (`FILLED`, `CANCELED`, or `REJECTED`). Paper reservations are released after the fill is recorded and local portfolio state is updated.

## Latest-signal-wins execution update — 2026-09-21

Execution scheduling now uses a per-symbol mailbox. At most one execution for a symbol may be running, and at most one not-yet-started execution for that symbol is retained. When a newer signal arrives before the older one starts, the older pending signal is marked `superseded` and never reaches planning, reservation, broker, or paper-fill execution.

This removes stale queued work rather than merely detecting staleness after queue wait. Different symbols still execute concurrently up to `LUNA_MAX_EXECUTION_CONCURRENCY`.

Pending mailbox entries are canceled when a session closes, so signals cannot carry across a market session boundary. Each scheduled execution also carries the session id/generation; a running task that returns after a rollover cannot mutate the new session's local paper portfolio.

The audit ledger records `SIGNAL_SUPERSEDED` for replaced pending signals and `ORDER_SUPPRESSED_SESSION_GENERATION` when a scheduled task reaches execution after its session is no longer current.


## Audit and broker-recovery update — 2026-09-21

The audit hash chain now advances only after the corresponding audit write succeeds. A failed ingest therefore does not silently advance the in-memory chain past an unwritten event.

Live orders are session-tagged with the session id, generation, and strategy version that created them. Broker reconciliation records a late fill against the originating session rather than whichever session happens to be active when the broker reports it. If the local worker has already rolled into a new session, the late fill is recorded but its local portfolio mutation is suppressed and an explicit LIVE_FILL_LOCAL_APPLY_SUPPRESSED_SESSION_GENERATION audit event is emitted.

A live placement request with an ambiguous network outcome is reconciled by client_order_id before its reservation is released. If the broker already accepted the order, LUNA keeps the reservation and tracks the recovered order instead of risking a duplicate placement. Live mode now also requires broker reconciliation to be enabled during preflight.

## Market-feed deadline update — 2026-09-21

The Settrade gateway polling loop no longer performs multi-second exponential retries inside the quote critical path. Each fetch has a bounded timeout (LUNA_MARKET_GATEWAY_TIMEOUT_MS, default 750 ms, minimum 200 ms) and failed cycles advance to the next poll interval. Poll timing compensates for fetch time so a fast gateway does not accumulate avoidable polling drift.

This changes the latency contract from retry until the gateway recovers to prefer fresh bounded snapshots and let the next poll recover. A gateway that repeatedly exceeds the deadline is observable as LUNA_GATEWAY_FETCH_FAILED rather than silently holding the market-data loop for several seconds.


## Session-boundary and execution-time update — 2026-09-21

Each quote-processing cycle captures its session id and session generation after session startup/rollover. A concurrent quote handler that crosses a session boundary is discarded before it persists the quote or signal into the wrong session. Scheduled execution continues to carry the same generation guard as a second line of defense.

Paper fills now use the actual execution timestamp rather than the source quote timestamp. The fill audit records both quote time and execution time so delayed market data cannot make the execution history look artificially earlier than the decision.


## Broker-authoritative state update — 2026-09-21

Live sessions now initialize the local portfolio from the broker account state instead of the paper `initialCapital` balance. The gateway exposes normalized cash and equity positions from Settrade account/portfolio data; unparsed holdings fail live startup rather than being guessed.

While live reconciliation is enabled, LUNA periodically compares broker cash and position quantities with the local execution state. A drift beyond configured tolerances blocks the live execution path and records `LIVE_ACCOUNT_STATE_DRIFT`. Broker synchronization is serialized after broker-order reconciliation so a newly reported fill cannot race the drift check.

## Restart safety update — 2026-09-21

On live startup LUNA also checks for broker orders that are still non-terminal. Because a restarted worker may no longer have the original in-memory reservation/client-order mapping, any remaining broker open order causes live session startup to fail closed rather than risk duplicate BUY or SELL exposure. The gateway treats only explicitly terminal order statuses as safe to ignore; unknown statuses remain active for safety.


## Broker risk-capital update — 2026-09-21

Live risk sizing now uses broker account equity rather than broker cash alone. The gateway computes normalized equity as cash plus explicitly reported position market value, or market price multiplied by quantity when an explicit market value is unavailable. Portfolio cost fields are not treated as market value. This prevents an account that already holds stocks from being sized as though only its idle cash were the entire risk capital.

Settrade's public Python SDK examples/snippets confirm the Equity interface exposes `get_account_info()`, `get_portfolio()`, `get_orders()`, place/cancel/change order functions, and realtime equity order subscription. LUNA therefore uses the SDK's equity order-list capability for restart safety rather than depending on an invented broker method. citeturn134614view0turn987317search6
