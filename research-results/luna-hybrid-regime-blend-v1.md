# LUNA-HYBRID-R1 Research Record

Status: CANDIDATE — not promoted to production.

## Formula
Monthly rebalance, equal-weight top K=20, one-month forward holding.

Base reversal score:
- REV1 = 1 - cross-sectional percentile rank(mom1)

Regime score:
- Compute breadth1 = fraction of symbols with mom1 > 0
- Compute breadth6 = fraction of symbols with mom6 > 0
- For each current month, compute each breadth z-score against the prior 12 months only.
- regime_z = 0.5*z(breadth1) + 0.5*z(breadth6)

Regime score:
- ON: 0.55*rank(high52_ratio) + 0.30*rank(mom6) + 0.15*(1-rank(vol20))
- OFF: 1-rank(mom1)
- NEUTRAL: 0.50*(1-rank(mom1)) + 0.30*rank(high52_ratio) + 0.20*(1-rank(vol20))

Final score:
0.50*REV1 + 0.50*RegimeScore

Transaction cost:
- one-way turnover cost = turnover * cost_bps
- primary test: 20 bps

No-lookahead:
- factor ranks use current month only
- regime z-score uses prior 12 months
- forward return requires the next observation to be the next calendar month
- development/test selection is separated from the 2026 holdout

## Tests on persisted Supabase monthly-factor dataset
Dataset period used for forward-return testing: 2021-10 through 2026-07 (58 investable months).

Full period @ 20 bps:
- geometric monthly return: 1.0290%
- cumulative return: 81.08%
- positive months: 55.17%
- worst month: -17.97%
- best month: +29.66%
- max drawdown: -33.63%

Frozen holdout:
- Holdout months: 2026-01 through 2026-07 (7 months)
- geometric monthly return: 4.0735%
- cumulative return: 32.25%
- positive months: 7/7
- worst month: +0.571%
- best month: +9.806%

Cost stress on the same frozen formula, K=20, holdout:
- 0 bps: 4.2692% geometric/month
- 10 bps: 4.1713%
- 20 bps: 4.0735%
- 30 bps: 3.9756%
- 40 bps: 3.8778%
- 60 bps: 3.6821%
- 80 bps: 3.4864%

## Benchmark references
Persisted exact M1 strategy:
- full 59-month history through 2026-08: 0.6556% geometric/month, +47.04% cumulative, -47.36% max drawdown.
- 2026-01 to 2026-07 holdout: 3.2291% geometric/month, +24.92% cumulative, 5/7 positive months.

Same monthly-factor research M1 alias:
- 2026-01 to 2026-07 holdout: 2.7525% geometric/month, +20.93% cumulative, 6/7 positive months.

The hybrid therefore exceeds both benchmark references on this particular 7-month holdout, but the holdout is too short to treat that as validation by itself.

## Important anti-overfit note
A fine weight sweep around 50/50 produced unstable holdout results across nearby weights. Therefore 50/50 is retained as a simple pre-registered structural blend, not because the holdout was used to choose it.

## Next validation gate
1. Reproduce this candidate from a standalone research script.
2. Run fresh-seed formula generation around this architecture, not around the old formula family alone.
3. Run a longer unseen holdout when new months become available.
4. Run integer-share implementation and turnover/fee/slippage stress.
5. Do not enable for real-money trading until the candidate survives those tests.
