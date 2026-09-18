# LUNA-TH1H

Paper-trading infrastructure for an auditable SET/mai intraday experiment.

## Rules
- Initial capital: THB 1,000,000
- SET/mai equities only
- Long-only; no leverage
- Max position per symbol: 20% of initial capital
- Max gross exposure: 100%
- No look-ahead / hindsight
- Fees and slippage must be explicit
- Every order/fill/decision is auditable
- All positions must be closed before end of day
- Live trading is disabled until an authorized market-data/execution adapter is configured

## Architecture
Railway worker -> Supabase/Postgres -> Vercel dashboard

The market-data adapter is deliberately provider-neutral. Configure a licensed SET real-time feed before enabling live market mode.
