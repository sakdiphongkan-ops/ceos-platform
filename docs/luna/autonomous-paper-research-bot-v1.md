# LUNA Autonomous Paper Research Bot — Architecture Proposal v1
Date: 2026-11-12
Branch: research/autonomous-paper-bot-20261112
Status: design baseline; not deployed and does not change the production trading path.

## Objective

Run LUNA as an always-on, unattended research and paper-trading system. The browser is an observability/control surface only; it must never be required for collection, research, scheduling, or paper execution.

Hard constraints:
- SET/mai equities only; long-only; no leverage.
- PAPER only. Live broker execution remains locked and must not be armed by research automation.
- Only authorized/verified market data can qualify a candidate for production paper execution. Public/unverified last-price feeds may be used for explicitly labelled research/shadow work, never silently promoted to executable-book quality.
- No look-ahead, point-in-time availability semantics, survivorship controls, explicit fees/slippage/impact, and immutable audit lineage.
- AI/research workers may create candidate versions and reports; they cannot mutate the active strategy or execution policy. Promotion requires deterministic gates and an explicit human approval.
- All positions must be closed before end of day, subject to the existing market-session/risk policy.

## Current repository baseline inspected

Repository: https://github.com/sakdiphongkan-ops/ceos-platform
Default branch: master
Existing runtime architecture documented in luna-th1h/README.md: Railway worker -> Supabase/Postgres -> Vercel dashboard.
Existing assets include:
- TypeScript market/execution runtime under luna-th1h/src.
- bounded latest-quote analysis and execution schedulers.
- telemetry queue with coalescing ticks and FIFO signals.
- deterministic Asia/Bangkok market-session clock.
- paper execution ledger, risk checks, audit chain, latency ledger and reconciliation primitives.
- CSV normalization and historical replay.
- Research Engine v2 with session-based TRAIN/VALIDATION/TEST splits and survivorship-universe support.
- failure-driven nested walk-forward research under scripts/research/luna_failure_driven_search_v1.py.
- adaptive tournament research under scripts/research/luna_adaptive_tournament_v2.py.
- institutional gap analysis at research-results/luna-platform-gap-analysis-20260921.md.

Important: the checked-in execution.ts already contains allowPaperPriceOnlyExecution() and explicitly permits last-price BUY planning only when priceOnlyFallback=true, mode=paper, executionMode is not live, LIVE_TRADING_ARMED is false, and the source is tradingview-public-screener. This is code-level evidence only; runtime parity and current deployment state still require end-to-end verification.

## Open-source repository assessment

### 1. nautechsystems/nautilus_trader — candidate event/replay engine
https://github.com/nautechsystems/nautilus_trader
Use selectively as a benchmark/reference for deterministic event-driven replay, instrument/venue modelling, order lifecycle, fill models, and backtest/live semantic parity. Do not wholesale replace the existing TypeScript paper runtime in the first integration phase. A SET/mai adapter and Thai market microstructure assumptions would have to be built and validated; the framework itself does not provide a ready-made authorized SET feed.

### 2. microsoft/qlib — candidate quantitative research layer
https://github.com/microsoft/qlib
Best fit for deeper alpha research: data handlers, feature pipelines, model experiments, portfolio evaluation, and time-aware research. Integrate behind a LUNA adapter using immutable point-in-time datasets; do not allow its default data assumptions to bypass LUNA's available_at, symbol-lifecycle, and leakage checks. Start with offline experiments, not runtime signal generation.

### 3. nkaz001/hftbacktest — optional execution realism module
https://github.com/nkaz001/hftbacktest
Use only when licensed historical tick/order-book data with reliable sequence/timestamps is available. It can support latency, queue-position, and order-book-aware replay. It is not useful to pretend price-only public screener data is L2 depth. Keep this as an optional research extra, not a dependency of the always-on worker.

### 4. ranaroussi/quantstats — reporting utility
https://github.com/ranaroussi/quantstats
Use as an offline report generator for equity curves, drawdown, rolling risk, and tear sheets. Validate calculations against LUNA's own ledger and preserve LUNA's canonical THB/cost conventions.

### 5. lumduan/settfex and lumduan/thai-securities-data — discovery/reference only
https://github.com/lumduan/settfex
https://github.com/lumduan/thai-securities-data
Potentially useful for Thai symbol metadata and adapter exploration. They are not substitutes for an authorized SET/SETTRADE/SETSMART subscription, data entitlement, or source provenance. Validate licenses, freshness, coverage, delisted-symbol handling, and field semantics before ingestion. Never label these as official executable real-time data without proof.

### Orchestration decision
Do not add Prefect or Temporal as a first step. The current deployment model already has an always-on Railway worker and Supabase persistence. First implement a durable, database-backed LUNA job queue with leases, checkpoints, idempotency, retry/backoff, concurrency caps, and a scheduler in the existing deployment model. Reconsider an external orchestrator only if operational evidence shows the in-process/DB scheduler is insufficient.

## Target 24/7 architecture

Separate three responsibilities so heavy research cannot delay market decisions:

1. **Market Runtime (priority 0)**
   - Always-on service, independent of the dashboard/browser.
   - Collect/normalize quotes; maintain session state and heartbeats.
   - During SET trading sessions: prioritize freshness, signal evaluation, risk, paper order planning, fill simulation, and audit persistence.
   - Outside trading sessions: no order generation; collect only permitted data and maintain readiness.
   - Fail closed on stale data, feed identity mismatch, clock/holiday uncertainty, missing required fields, or persistence failure.

2. **Research Worker (priority 1; separate service/process)**
   - Runs continuously as a durable job consumer, not as a CPU-bound infinite loop.
   - Enqueues bounded jobs on a schedule and resumes from checkpoints after restarts.
   - Intraday/off-hours tasks: data-quality scans, feature refresh, candidate scoring, failure analysis, walk-forward experiments, cost/latency stress, drift and correlation checks.
   - Heavy full-universe searches run off-session and are pre-emptible. Research concurrency and CPU/memory budgets must be capped.
   - During market hours, research yields to the Market Runtime; no heavy model training on the same event loop.

3. **Control Room (Vercel frontend)**
   - Read-only observability by default; browser closure has no effect on worker execution.
   - Show process liveness, last heartbeat, current job, queue depth, oldest job age, last success/failure, data freshness/coverage, strategy version, evidence state, and PAPER/LIVE lock state.
   - Provide pause/resume/retry for research jobs only, protected by authenticated admin action. No UI control may arm live trading.

## Durable job types and cadence (Asia/Bangkok)

- Every 1 minute: worker heartbeat, queue lease renewal, feed freshness and ingestion lag check.
- Every 5 minutes: data-quality scan, duplicate/gap/out-of-order checks, source health and coverage.
- Every 15 minutes: incremental feature update and candidate/shadow evaluation using only completed bars.
- At market close: reconcile session ledger, close paper positions under existing policy, persist session snapshot, calculate daily P&L and risk.
- After market close: daily walk-forward refresh, cost/slippage stress, drift/correlation scan, and report generation.
- Nightly: bounded candidate tournament, multi-seed replication, frozen OOS evaluation, artifact/hash registration.
- Weekly: deeper full-universe robustness, parameter stability, universe perturbation, and dependency/security review.
- Monthly: locked benchmark comparison and model registry review.

These cadences are starting configuration, not permission to use stale or synthetic data. Jobs must record their input watermark and data coverage; skipped/failed jobs remain visible.

## Required durable tables/contracts

Reuse existing tables where possible; add migrations only after schema inspection:
- research_jobs: job_id, type, priority, status, scheduled_at, lease_owner, lease_expires_at, attempts, max_attempts, checkpoint, input_watermark, idempotency_key, created_at, started_at, finished_at, error_code.
- research_runs: run_id, job_id, code_sha, config_hash, dataset_hash, universe_hash, strategy_candidate_id, start/end timestamps, metrics, status.
- research_artifacts: run_id, artifact_type, storage_uri, sha256, metadata.
- strategy_candidates: immutable candidate_id, parent_version, code/config hash, evidence bundle, gate result, approval status, created_at.
- service_heartbeats: service, instance_id, last_seen_at, build_sha, current_job_id, mode, health.
- data_quality_events: source, symbol, event_time, observed_at, issue_type, severity, payload_hash.

All job claiming must be transactional (e.g. SELECT ... FOR UPDATE SKIP LOCKED or a single atomic claim RPC). A lease expiry permits safe re-claim after a crash. Every write must be idempotent. Store raw data/artifacts in durable storage, not process memory.

## Research candidate promotion gates

A candidate remains RESEARCH/SHADOW unless all applicable checks pass:
- exact dataset, universe, code and configuration hashes are recorded;
- no look-ahead and no future available_at joins;
- survivorship/delisting control is verified or explicitly marked unavailable;
- session-based nested walk-forward and frozen holdout are positive after all costs;
- positive cost/impact stress and reasonable parameter-neighbourhood stability;
- drawdown, turnover, liquidity participation and concentration within pre-set limits;
- multi-seed replication and block-bootstrap uncertainty checks;
- correlation/crowding and factor-neutral diagnostics available;
- paper shadow tracking passes a minimum sample/time requirement;
- no unresolved data-quality or execution-path blockers.
No 7% monthly target may be used as an optimizer reward if it encourages leakage or holdout tuning.

## Operational safety and SLOs

- Worker restart must recover session state and outstanding jobs from Postgres, not from memory alone.
- Market Runtime and Research Worker must be separate processes/services or isolated queues with strict priority.
- Heartbeat SLO: alert when missing for > 60 seconds; stale feed alert based on provider-specific SLA.
- Job retry: bounded exponential backoff with jitter; terminal failures go to dead-letter state and remain visible.
- Circuit breakers: stop new paper entries on stale feed, DB write failure, clock/calendar uncertainty, risk-state corruption, or unverified strategy version.
- Daily reconciliation: orders, fills, positions, cash, fees, realized/unrealized P&L and end-of-day closure must balance.
- All times stored in UTC and rendered in Asia/Bangkok.
- No secrets in source control or logs; provider credentials remain in Railway secret variables.

## Implementation sequence

### Phase 0 — baseline and deployment truth
- Pin current master commit and verify exact Railway service/replica state, worker build SHA, environment variables (names only), Supabase schema/function versions, and Vercel deployment.
- Run end-to-end health checks from feed -> normalized quote -> strategy -> planOrder -> paper fill -> durable ledger -> dashboard.
- Verify the checked-in price-only paper gate against unit/integration tests and deployed worker SHA.
- Do not proceed to deployment if the worker's source commit cannot be tied to the checked-in source.

### Phase 1 — durable scheduler and observability
- Add migration for jobs/heartbeats/artifacts only after checking for existing equivalents.
- Implement transactional job claiming, leases, retries, checkpointing, idempotency and queue metrics.
- Create a separate Research Worker service using the same repository and a distinct process command.
- Add health endpoints and a watchdog; dashboard reads health/queue metrics.

### Phase 2 — research integrations
- Build a Qlib adapter that exports only validated, point-in-time LUNA datasets and imports experiment metrics/artifacts.
- Add QuantStats report generation as a deterministic post-run task.
- Add NautilusTrader replay adapter only for normalized historical event streams where parity and licensing are verified.
- Add hftbacktest only after verified L2/tick history is available.
- Keep the TypeScript execution engine canonical for the existing paper runtime until a parity test suite proves otherwise.

### Phase 3 — unattended paper operations
- 7-day soak test with market-open sessions, weekends, holidays, forced restarts and simulated network/DB failures.
- Verify no duplicate jobs/orders/fills, no session carry-over, no stale entry, no data leakage, and correct EOD close.
- Require 99.5% worker availability during the soak window and 100% audit reconciliation before considering the system ready.
- Promote only after a human reviews the evidence bundle.

## Current access/verification limitation

The GitHub connection can read and write the user's repository, and a dedicated research branch has been created. The Railway environment-status action currently returns a permission error (viewer role), so this task cannot truthfully certify the current production worker's liveness or deploy a new Railway service. Do not claim 24/7 operation until Railway access is restored and a multi-day soak test passes.

## References
- NautilusTrader: https://github.com/nautechsystems/nautilus_trader
- Microsoft Qlib: https://github.com/microsoft/qlib
- hftbacktest: https://github.com/nkaz001/hftbacktest
- QuantStats: https://github.com/ranaroussi/quantstats
- SET Thai securities data helper: https://github.com/lumduan/settfex
- SET security master mirror: https://github.com/lumduan/thai-securities-data
- Existing LUNA research gap analysis: research-results/luna-platform-gap-analysis-20260921.md
