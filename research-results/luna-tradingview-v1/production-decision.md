# LUNA TradingView Tournament — Production Decision

## Result

The final 35-candidate A/B tournament does **not** justify adding the TradingView-derived indicator gates/reranks to the production selector.

The production core remains:

**M1 only — select the 20 lowest completed-calendar-month raw-close returns at month-end, equal weight, monthly rebalance.**

The indicator engine remains available as a **research-only layer**.

## Control @ 20 bps

| Metric | M1 control |
|---|---:|
| FULL5Y geometric monthly | 0.613% |
| FULL5Y cumulative | +43.39% |
| FULL5Y positive months | 54.24% |
| FULL5Y max drawdown | -47.36% |
| OOS geometric monthly | 1.604% |
| OOS positive months | 50.0% |
| OOS max drawdown | -29.37% |
| HOLDOUT geometric monthly | 4.077% |
| HOLDOUT positive months | 75.0% |
| HOLDOUT max drawdown | -2.89% |

## Indicator test

No tested candidate beat the same-data M1 control on both frozen OOS and HOLDOUT while remaining positive under 20/40/60 bps.

For context, RSI_DIV_TV_OSC produced 0.021% monthly OOS and 0.092% monthly HOLDOUT at 20 bps. ATRP_RISK_GATE produced 0.836% monthly OOS and 1.484% monthly HOLDOUT, still below the M1 control.

## Implementation

TradingView-derived indicators should not be added to the live/production selector from this tournament. The indicator engine, candidate catalog, and tournament remain available for future experiments and can be revisited only through another frozen OOS/HOLDOUT test.
