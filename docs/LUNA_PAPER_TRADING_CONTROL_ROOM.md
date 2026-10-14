# LUNA Paper Trading Control Room — Implementation Contract

## Goal
Build a Jex-inspired operational control room for Thai equities (SET/mai), while keeping the existing LUNA production app unchanged. This is not a clone and not a live-broker trading system.

## Screen areas
1. Market — SET/mai and watchlist, 15-minute candles, source, timestamp, staleness and feed health.
2. Paper portfolio — starting simulated capital THB 30,000; cash, equity, realized/unrealized P&L, open positions and orders/fills.
3. LUNA engine — active work order, last evaluation, next scheduled evaluation, decision explanation, evidence, blockers, evaluation count and heartbeat.
4. Performance — net return after costs, win rate, closed-trade count, maximum drawdown in THB and %, Sharpe/Calmar where calculable, OOS/HOLDOUT and benchmark comparisons.
5. ERP Workbench — agent registry, owner, dependencies, state, acceptance criteria, evidence, approvals and audit timeline.

## Non-negotiable data rules
- No synthetic prices, P&L, fills, connected statuses, or claimed reasoning in production UI.
- Unknown values render as an em dash; disconnected sources render NOT CONNECTED; illustrative records must carry a persistent DEMO label.
- Every quote and bar includes source and event timestamp. Reject stale or unverifiable market data.
- Never infer actual trade fills from signals. Orders, fills, positions, and cash must reconcile against the paper ledger.
- Execution remains PAPER ONLY. No broker keys, live orders, or live-trading enablement.
- Fail closed when source verification, quote freshness, universe completeness, risk checks, or idempotency checks fail.
- Routine low-risk work may auto-progress only after deterministic acceptance gates pass. Production publishing, destructive data changes, secrets, policy changes, and live trading require a human gate.

## ERP workflow
QUEUED -> RUNNING -> VALIDATION -> RISK_REVIEW -> PAPER_TRIAL -> COMPLETED. Exceptional states: BLOCKED, FAILED, CANCELLED. A state transition must write an audit event. Each work order has exactly one accountable owner, stable idempotency key, dependency list, acceptance criteria and evidence. Independent validation must not be performed by the formula authoring agent.

## Backend contract
The migration at supabase/migrations/202610150001_luna_erp_core.sql creates workflow control-plane tables. RLS is enabled with no direct client policies yet, so it fails closed. Do not expose service-role keys to the browser. Add authenticated server routes/RPCs and explicit role policies only after review and tests.

## Acceptance tests
- Duplicate idempotency key is rejected.
- Illegal status values are rejected by constraints.
- Audit events cannot be updated or deleted.
- Direct anon/authenticated access is denied until explicit policies are added.
- No connected status appears without a verified heartbeat/source.
- Stale or unverified quotes cannot produce executable paper orders.
- No order can leave PAPER mode or call a broker.
- Dashboard distinguishes actual persisted data from unavailable and demo data.
- P&L and equity reconcile from fills, fees, slippage and positions.
- A failed gate creates a blocker and audit event rather than silently proceeding.

## Status
This branch is an implementation foundation only. The Lovable project is currently blocked by exhausted workspace credits; this document and migration do not imply a completed UI or connected market feed. Do not merge or apply to production until reviewed and tested.
