# LUNA Paper Trading Control Room — Implementation Contract

## Goal
Extend the existing LUNA `/luna` control room for Thai equities (SET/mai). Reuse its current UI, API client, market stream and research endpoints; do not create a parallel dashboard. This is not a clone and not a live-broker trading system.

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
This branch extends the existing `/luna` page and adds an ERP control-plane schema contract. It does not imply that the new ERP tables have been applied or wired to server routes. Do not merge or apply to production until reviewed, built and tested.

## Public reference review: JEX

Reviewed the public root page at https://jex.probably-anything.com/ on 2026-10-14 using read-only browser inspection. No authentication, form submission, private API access, or state-changing interaction was used. The public page presents a single dashboard with XAU/USD and BTC/USD selectors, a market card and full candlestick chart, account balance/P&L with Today / 7 days / Since start filters, an expandable Jev reasoning view, recent open/closed trades, lifetime win/loss and drawdown summary, and a responsive mobile layout. Live figures observed on that site are volatile and must never be copied into LUNA.

### LUNA adaptation (same existing /luna route)

- Keep LUNA's Thai-equity universe (SET/mai), current API clients, session/ledger tables, and existing /luna route. Do not create a parallel dashboard or copy JEX assets/source.
- Adapt the expandable bot-reasoning interaction to LUNA's existing shadow_status response. The new AgentDecisionPanel renders only returned decisions, source/book verification flags, factor values, evaluation time, blockers and candidate action. It labels each item as a research candidate, never as an executed order or fill.
- Keep portfolio values sourced from the verified LUNA snapshot and recorded fills; missing values remain an em dash. JEX balances, prices, P/L, trades and performance values are not LUNA data.
- Keep the existing order/trade tables, runtime health, paper/live gate and audit controls. The agent trace is inserted into the existing control room rather than creating a second workspace.
- Match the reference's compact, expandable, mobile-responsive interaction pattern with local LUNA styles. Do not copy its branding or claim that LUNA has JEX's runtime behavior.

### Remaining integration gate

LUNA's current client contract does not expose a verified historical OHLC/candlestick endpoint in this page. Do not draw synthetic candles or derive a fake 1m/5m/15m/1h history from isolated quote updates. Before adding the JEX-like full chart and performance-period selector, identify or implement a server-side endpoint that returns real SET/mai OHLC bars with source, event timestamp, timeframe, stale-data handling and universe/symbol validation. The lifetime summary also needs a reconciled ledger query for closed trades, win rate, net P&L and maximum drawdown; do not infer these from a partial current-session order list.

### Validation

- Static regression coverage asserts the decision trace reads from the existing shadow API, shows an empty state if no decision evidence is returned, and does not imply a fill.
- The existing branch's full browser compatibility CI must still be green before merge. Build/typecheck passing alone is not release approval.
## Verified historical chart integration

The existing `luna-execution-gateway` already exposes an authenticated `/historical-candles/{symbol}` endpoint backed by Settrade Open API. The existing UI did not consume that endpoint. The branch now adds an authenticated same-origin proxy at `/api/luna/market-bars` and a candlestick panel inside the existing `/luna` page.

- The browser never receives the gateway key. The proxy reads server-only `LUNA_GATEWAY_URL` and `LUNA_GATEWAY_KEY`; do not prefix either variable with `NEXT_PUBLIC_`.
- The proxy requires an authenticated LUNA user, validates symbol syntax, allowed interval, requested row limit, gateway response source/symbol/timeframe, candle timestamps and OHLC invariants, applies a per-user request limit, and returns `private, no-store` responses.
- The chart uses only normalized rows returned by the proxy. If environment configuration, authentication, source validation or candle normalization fails, it shows an explicit unavailable state and does not draw substitute prices/candles.
- The chart currently offers the short liquid SET symbol list and 1m / 5m / 15m / 1h timeframes. These are selectors, not claims that all symbols or intervals are available for every SETTRADE account.
- Deployment remains gated: the proxy's server-only gateway variables must be configured in the Vercel environment, and the actual `/historical-candles` payload format must pass the running CI/browser checks before any production publish.

### Historical data limitations

This panel is historical OHLC, not a guaranteed streaming last-trade chart. The existing websocket quote stream remains auxiliary and should not be used to invent historical candle open/high/low/close values. Daily performance and since-start summary still require a reconciled paper ledger and will remain unavailable rather than inferred.