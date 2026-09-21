# LUNA Competitive Gap Analysis — 2026-09-21

## Scope

LUNA is compared against public capabilities documented by QuantConnect/LEAN, QuantRocket, WorldQuant BRAIN, Numerai Signals, Interactive Brokers APIs, and MLflow. The comparison is capability-based, not a claim that one platform is universally superior.

## Benchmark observations

### QuantConnect / LEAN
Public documentation describes a modular, event-driven engine for backtesting and live trading, cloud/local workflows, optimization, data integration, version control, and asynchronous live order/fill events. QuantConnect also exposes pluggable transaction, fee and slippage models and emphasizes keeping backtest/live behavior consistent. LUNA already has event-driven quotes, paper/live paths, audit trails, and configurable fees/slippage, but still needs a stronger reality-model layer, order lifecycle reconciliation, and first-class research experiment tracking.

### QuantRocket
QuantRocket combines point-in-time security/factor pipelines, large-universe screening, factor analysis with Alphalens, parameter scans, live trading, and live-vs-backtest performance/implementation-shortfall tracking. LUNA's strongest current gap is the absence of a permanent factor tear-sheet/IC/quantile/sector-neutral analytics layer and a first-class live implementation-shortfall report.

### WorldQuant BRAIN
BRAIN emphasizes a large research dataset/field library, a simulation environment, performance dashboards, multi-simulation workflows, and research tests such as production correlation and group neutralization. LUNA has formula tournaments and multiple search families, but its current factor library is materially narrower and its crowding/originality/neutralization diagnostics are not yet first-class.

### Numerai Signals
Numerai emphasizes signal originality, neutral correlation, diagnostics, and ensemble combination of many signals. LUNA has started model ensembles and formula evolution, but needs an explicit originality/crowding registry and ensemble-level correlation/neutralization controls.

### Interactive Brokers
IB documents asynchronous API event flows, live/paper environments, and market-data callbacks. LUNA's live gateway currently has a placement interface and preflight checks, but the repository does not yet expose a broker-side fill/reconciliation state machine.

### MLflow
MLflow provides experiment tracking, parameter/metric visualization, artifact lineage, model versioning, aliases, and production lifecycle governance. LUNA now has the beginning of this model-registry pattern, but it should be expanded into a durable research registry with immutable datasets, code hashes, promotion gates and rollback lineage.

## LUNA target architecture

1. Point-in-time Data Layer
   - versioned datasets
   - availability timestamps
   - survivorship/delisting controls
   - market/factor/fundamental/alternative-data families
   - data-quality and drift checks

2. Alpha Research Lab
   - formula DSL
   - factor families
   - interaction/evolution search
   - IC/ICIR
   - quantile spread
   - turnover
   - factor correlation
   - neutralization
   - crowding/originality

3. Validation Engine
   - train/dev/OOS/frozen holdout
   - nested walk-forward
   - multi-seed replication
   - universe perturbation
   - cost/K stress
   - block bootstrap confidence intervals
   - multiple-testing controls

4. Portfolio / Risk Engine
   - position limits
   - gross/net exposure
   - liquidity participation
   - factor exposure constraints
   - daily loss guard
   - kill switch
   - order-rate limits

5. Reality Backtester
   - bid/ask spread
   - visible depth
   - slippage
   - market impact
   - latency
   - partial fills
   - rejection
   - stale quote handling
   - transaction costs and taxes

6. Live Execution
   - asynchronous order lifecycle
   - broker order state reconciliation
   - duplicate/idempotency protection
   - implementation shortfall
   - paper-vs-live divergence

7. Model Registry
   - immutable dataset/code/artifact hashes
   - research candidate version
   - evidence bundle
   - approval state
   - promotion/rollback history

## Implemented in this iteration

- Failure-driven 5,000-formula nested search.
- Full-factor monthly builder with strict calendar forward-return guard.
- Institutional research scorecard:
  IC, ICIR, quintile spread, redundancy, turnover, K/cost stress, exact M1 overlap.
- Auditable research model registry with dataset/search/scorecard/benchmark hashes.
- Max-position enforcement in the execution planner.
- Visible-depth market-impact model in paper execution.
- HOLD signals removed from execution queue while heartbeat remains active.

## Next highest-value gaps

### A. Point-in-time fundamentals and alternative data
The current public SET workflow mostly exercises price/technical factors. The next research expansion should attach a true point-in-time fundamentals feed and alternative-data layer, preserving available_at semantics.

### B. Neutralized alpha / crowding engine
For every candidate signal, calculate raw IC, neutralized IC against known factor families, and correlation against already-selected models. Penalize redundant alpha before promotion.

### C. Reality backtest v2
Add latency, partial fills, stale quotes, participation curves and market-impact calibration from actual live fills. The calibration should be based on observed live/paper execution rather than arbitrary constants.

### D. Live reconciliation state machine
Represent every broker order as:
SUBMITTED -> ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED / CANCELED / REJECTED / UNKNOWN,
with periodic reconciliation against the broker as the authoritative source.

### E. Reproducibility and promotion gates
A production candidate should require:
- positive frozen holdout,
- positive OOS,
- positive cost-stress,
- stable K sensitivity,
- non-negative IC/ICIR,
- bounded drawdown,
- fresh-seed replication,
- no excessive factor/model crowding,
- successful shadow/paper tracking.

The 7% geometric-monthly hurdle remains a research target, not something the optimizer is allowed to achieve through future leakage or holdout tuning.


## Addendum — 2026-09-21

The next implementation layer is now in the repository:

- Neutralized alpha diagnostics: raw IC vs factor-neutralized IC, annualized neutral ICIR, neutral churn, and peer crowding correlations.
- Broker order lifecycle state machine with explicit transitions from submitted through partial/final fill, cancellation, rejection, or unknown.
- Optional live reconciliation gateway endpoint and periodic reconciliation loop.
- Reconciled broker fills can be recorded idempotently and applied to local portfolio state.
- Configurable visible-depth market impact plus max-position enforcement remain active in the execution model.
- Dependent-data multiple-testing diagnostic using a moving-block bootstrap over the full searched formula family.
- Fresh-seed replication runner using the same search specification under three independent seeds.
- Research quality gate v2 binding holdout/OOS/IC/cost/K/neutralization/replication evidence before registry promotion.
- Full formula monthly-return matrix persisted as compressed research evidence for downstream inference.
- Point-in-time fundamental factors carried through the monthly panel and automatically admitted only when coverage exists.

These changes are motivated by documented platform practices: LEAN treats live fills as asynchronous order events and provides explicit order status/order-event handling; QuantRocket/Alphalens emphasizes factor tear sheets, quantile spreads, IC and turnover analysis; Numerai explicitly evaluates neutralized information coefficients, neutral churn, and model correlations. citeturn342024search0turn250777search3turn342024search1


## Addendum — Thai-native data moat and PIT contract

SET currently exposes several native data surfaces through SMART Marketplace / SETSMART, including company fundamental data, financial statements, One Report, ESG, corporate action/reference data, EOD/intraday data, and related feeds. Company fundamental data is available through JSON APIs for SETSMART members, while the financial-statement service supports structured company financial data and a last-update workflow. The official financial-statement specification distinguishes a statement's `asOfDate` from the operational update process; LUNA must therefore never treat `asOfDate` alone as `available_at`. The research contract requires an actual source-availability timestamp before a fundamental observation can enter the point-in-time feature matrix.

This creates a concrete upgrade path:

1. ingest SET/SETSMART raw observations,
2. ingest the corresponding disclosure/update event timestamp,
3. normalize to `symbol + available_at + effective_period + value + source`,
4. merge backward into the decision timestamp,
5. reject any future-timestamp match,
6. retain raw-response hash and source metadata for audit.

The official SET documentation also exposes real-time/market-data and news surfaces, making the timestamped disclosure layer a viable future source for reconstructing when information became public rather than merely when the accounting period ended.

Sources:
- SET Listed Company Fundamental Data: https://www.set.or.th/app/online-data/fundamental-data
- SET SMART Marketplace: https://www.set.or.th/en/services/connectivity-and-data/data/smart-marketplace
- SET Financial Statement API specification: https://media.set.or.th/set/Documents/2025/Apr/16_SMART_Marketplace_Financial_Statement_Specification.pdf
- SET Company Fundamental API specification: https://media.set.or.th/set/Documents/2022/Oct/05_1_Company_Fundamental_Specification.pdf
