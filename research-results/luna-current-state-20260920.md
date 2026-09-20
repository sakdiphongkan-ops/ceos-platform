# LUNA Current Research State — 2026-09-20

## Locked benchmark
M1 production benchmark is preserved as:
- strategy_version: luna-m1s0k20rev-v1
- strategy_id: M1_S0_K20_REV
- universe: 925
- monthly rebalance
- equal weight
- 20 bps round-trip
- period: 2021-10-31 to 2026-08-31
- months: 59
- geometric monthly return: 0.6556128%
- cumulative return: 47.0421%
- positive months: 54.2373%
- max drawdown: -47.3576%

Canonical files:
- research-results/luna-m1-benchmark-locked-20260920.json
- research-results/luna-m1-benchmark-locked-20260920.csv

Rule: future formula research must compare its monthly net_return series to this locked M1 series when the same period is available. Public-data M1/REV21 proxies must never be labelled as exact M1.

## Adaptive lineage
### Adaptive v1
Historical exploratory walk-forward engine. Superseded by later engines.

### Adaptive Tournament v2
The original Supabase-secret run covered an invalid time window and is marked INVALIDATED_FOR_5Y_COMPARISON in:
- research-results/luna-adaptive-tournament-v2-window-audit.json

A corrected independent public-data run exists:
- 1,000 formulas
- 48 traded months
- 20 bps
- geometric monthly return: 0.15598%
- cumulative: 7.7682%
- max drawdown: -30.40%
- benchmark in that file is an M1 factor-table alias, NOT exact production M1.

### Fresh-seed replication
Five independent formula catalogs (earlier v2 replication):
- mean geometric monthly return: -0.02096%
- max across seeds: 0.37750%
- zero seeds reached the 7% monthly hurdle.

### Adaptive v4
Expanded public factor set including REV21, momentum horizons, volatility, drawdown, liquidity, 52W-high and technical factors.

Seed 20260920:
- adaptive: 0.71331%/month
- cumulative: 40.66%
- max DD: -21.14%
- rank-1 frozen holdout: -1.3847%/month

Seed 20260921:
- adaptive: -0.72739%/month
- cumulative: -29.56%
- max DD: -46.20%
- rank-1 frozen holdout: -2.4939%/month

Seed 20260922:
- adaptive: 1.06236%/month
- cumulative: 66.07%
- max DD: -23.06%
- rank-1 frozen holdout: -0.8077%/month

Replication conclusion: no formula has passed the requirement of positive robust holdout performance across all fresh seeds, and none demonstrated the 7% geometric-monthly hurdle.

## Structured/theory research
Completed searches include:
- 113/121 theory-family formulas
- 144 structured family candidates
- 2,000 structured interaction/evolution candidates
- 5Y public-data structured searches
- hybrid regime experiments

Observed strongest recurring mechanisms include short-term reversal, reversal + liquidity/risk filters, and some momentum/52W-high/low-volatility combinations. However, validation-selected candidates repeatedly deteriorated on frozen OOS/holdout.

Example: direct theory-family search top validation candidate produced 1.79%/month OOS and 4.90%/month final holdout, still below 7%.

## Current active work
LUNA Formula Evolution Lab v1 run is currently in progress on GitHub Actions:
- run: 35497918928
- formula evolution: 3 generations, seeded historical theories + random formulas + mutations/crossovers
- meta-ensemble mechanism lab runs after evolution
- selection is TRAIN+DEV only
- OOS/HOLDOUT remain blind
- stress grid includes K=5/10/20/50 and 0/20/45/60 bps

This is the next research stage; M1 remains locked and is not replaced by the adaptive engine.

## 7% hurdle
7% geometric monthly implies approximately 125.2% annual compounded return. Across the completed robust searches so far, this hurdle has not been demonstrated robustly out-of-sample.

## Promotion rule
No candidate is promoted to production LUNA solely from training, validation, or a single impressive backtest. A candidate must survive frozen holdout, fresh-seed replication, cost stress and exact M1 comparison.
