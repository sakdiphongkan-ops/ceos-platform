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
