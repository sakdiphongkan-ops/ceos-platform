# LUNA Research Data Pipeline v1

This layer is the gate before any 1,000,000-strategy result is allowed to be called a backtest result.

## Canonical flow

SET/mai raw files
-> `validate_and_prepare.py`
-> normalized EOD / fundamentals / corporate actions
-> `build_factor_dataset.py`
-> `factor.csv`
-> `scripts/one_million_search_staged.py`
-> deterministic 1M screen
-> exact finalists
-> OOS + locked holdout + costs

## Required price columns

`date,symbol,open,high,low,close,volume`

Optional: `adj_close,amount,market,available_at`.

If `available_at` is not supplied for EOD prices, the validator assigns the configured decision cutoff (default 17:00 Asia/Bangkok), then the factor builder uses the next trading observation for forward returns.

## Required fundamentals columns

`symbol,asof_date,available_at`

Recognized fields include:

`pe,pbv,ev_ebitda,fcf_yield,earnings_yield,div_yield,roe,roa,roic,gpm,npm,cfo_margin,rev_g,eps_g,ni_g,fcf_g,asset_g,capex_g,investment_rate,div_g,payout,buyback,de,net_debt_ebitda,interest_cover,current_ratio,adv20,turnover,amount`

The publication timestamp is mandatory. A value is eligible only when `available_at <= decision_ts`.

## Commands

```bash
python scripts/research/validate_and_prepare.py \
  --prices raw/prices.csv \
  --fundamentals raw/fundamentals.csv \
  --corporate-actions raw/corporate_actions.csv \
  --out-dir data/normalized

python scripts/research/build_factor_dataset.py \
  --prices data/normalized/prices.normalized.csv \
  --fundamentals data/normalized/fundamentals.normalized.csv \
  --benchmark raw/set_index.csv \
  --output data/luna_factors.csv

python scripts/one_million_search.py \
  --input data/luna_factors.csv \
  --output research/one_million \
  --max-trials 1000000 \
  --cost-bps 45
```

## Fail-closed rules

- No duplicate `date+symbol` price rows.
- Fundamental data without a publication/availability timestamp is rejected.
- No forward-looking joins.
- Forward returns are generated after the decision date only.
- Missing factors stay missing; they are not fabricated.
- Corporate actions remain a separate audit table.
- The 1M engine must not use the final holdout to generate or tune rules.
- A one-day purge is used at train/OOS and OOS/holdout boundaries because `fwd_return_1d` points to the next trading observation.
- Every hypothesis is screened; only deterministic finalists receive exact full-period OOS/holdout evaluation. The screen score is a ranking proxy, not a return estimate.

The Supabase schema lives in `migrations/002_luna_research_data_layer_v1.sql`.
