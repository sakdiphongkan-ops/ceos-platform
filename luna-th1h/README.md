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


## Market-data modes

The worker is provider-neutral:
- `mock`: safe paper-mode heartbeat/execution fixture.
- `set-marketplace`: SET Market Data API adapter. Requires `SET_MARKETPLACE_API_KEY`; never enable without authorized credentials.

The SET adapter normalizes the first bid/offer level and last trade into the internal `Quote` contract. The underlying SET Market Data API exposes timestamped last price plus bid/offer levels; authentication is via an API key.

Environment variables:
```
MARKET_DATA_PROVIDER=mock
SET_MARKETPLACE_API_KEY=
SET_MARKETPLACE_BASE_URL=https://marketplace.set.or.th/api/public/realtime-data/stock
SET_MARKETPLACE_MARKETS=SET,mai
SET_MARKETPLACE_POLL_MS=1000
```

## Historical replay

Historical data must enter through the normalized CSV contract:
```csv
ts,symbol,bid,ask,last,bid_size,ask_size
2026-09-18T02:00:00.000Z,PTT,31.25,31.50,31.50,10000,8000
```

Commands:
```
npm run replay:file
BACKTEST_FILE=/path/to/file.csv npm run replay:file
HISTORICAL_CSV=/path/to/file.csv npm run import:csv
```

The importer stores immutable source metadata including SHA-256 checksum, time range, symbol count, row count and raw quote payload. Replay uses the same execution engine and risk limits as paper execution.

SET's historical tick service provides trading ticker and bids/offers, with SET tick history available from September 2012. Raw SET files should be transformed into the normalized CSV contract before import, preserving original timestamp/order sequence.

## SET raw-file normalization

The official SET service provides historical intraday tick data as daily files containing trading ticker and/or bids/offers. SET states that tick data is available from September 2012 and can be delivered by website download or API. Raw files must be normalized before replay. See SET's current data service for licensing and access terms.

This repository therefore uses a mapping-driven adapter rather than assuming an undocumented raw-file layout.

Workflow:

```bash
SET_RAW_FILE=/path/to/set-file.csv npm run inspect:set
SET_RAW_FILE=/path/to/set-file.csv npm run normalize:set
BACKTEST_FILE=/path/to/set-file.normalized.csv npm run backtest:15m
```

Optional column overrides are available when a purchased SET file uses headers that cannot be auto-detected:

```bash
SET_TS_COLUMN=... SET_SYMBOL_COLUMN=... SET_LAST_COLUMN=... \\
SET_BID_COLUMN=... SET_ASK_COLUMN=... \\
SET_BID_SIZE_COLUMN=... SET_ASK_SIZE_COLUMN=... \\
SET_RAW_FILE=/path/to/set-file.csv npm run normalize:set
```

The normalizer is deliberately conservative: it rejects invalid timestamps/prices, bid>ask, and timestamp regressions; it preserves source row sequence and emits a SHA-256 checksum. It does not fabricate missing bid/ask values or OHLC data.

## Research Engine v2 — multi-day / multi-stock OOS research

Research v2 treats all normalized CSVs as one chronological dataset and evaluates candidate entries cross-sectionally at the same timestamp. It:

- splits by trading sessions (60% TRAIN / 20% VALIDATION / 20% TEST), not arbitrary rows;
- ranks simultaneous BUY candidates using fixed, auditable weights for momentum, order-book imbalance and spread;
- caps simultaneous candidate selection;
- closes positions at each session end;
- selects the strategy variant using VALIDATION P&L only, then reports that locked variant's TEST result as OOS;
- deduplicates identical `timestamp + symbol` observations;
- supports a historical universe membership file so symbols are eligible only during their actual membership interval.

Run:

```bash
RESEARCH_INPUT=/path/to/normalized-csv-directory npm run research:v2
```

For a survivorship-control file:

```bash
RESEARCH_INPUT=/path/to/data \
UNIVERSE_CSV=/path/to/universe.csv \
npm run research:v2
```

Universe CSV format:

```csv
symbol,market,start_date,end_date
PTT,SET,2001-01-01,
ABC,mai,2020-01-01,2024-12-31
```

Without `UNIVERSE_CSV`, the report explicitly marks survivorship control as `UNVERIFIED_SURVIVORSHIP_CONTROL`; the engine does not claim that the dataset is survivorship-bias-free.

Environment controls:

```text
LUNA_MAX_CROSS_SECTIONAL_CANDIDATES=5
LUNA_RANK_MOMENTUM_WEIGHT=1
LUNA_RANK_IMBALANCE_WEIGHT=20
LUNA_RANK_SPREAD_WEIGHT=0.25
LUNA_ALLOWED_MARKETS=SET,mai
LUNA_TIMEZONE=Asia/Bangkok
```

Research v2 remains paper/research only. It does not enable live execution.
