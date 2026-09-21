# SET SMART Marketplace ingestion runbook

SET documents SMART Marketplace API delivery for Security Profile/Corporate Action and Company Fundamental Data. The current Company Fundamental Data specification documents endpoints for EOD price/statistics, financial data and ratios, and a 30 requests/minute limit with at least 2 seconds between consecutive requests.

## Pull

Use:

`python scripts/research/pull_set_smartmarketplace_v1.py --endpoint <name> --params-json '<json>' --output data/raw/set/<file>.json`

For batches:

`python scripts/research/batch_pull_set_smartmarketplace_v1.py --plan data/contracts/set_smartmarketplace_request_plan_v1.json --output-dir data/raw/set`

The API key is read from `SET_API_KEY`; it is never written into a file or command manifest.

## PIT rule

Raw retrieval time is stored for audit only. It is **not** automatically treated as `available_at`.

Before a raw financial/fundamental payload enters LUNA:

`normalize_set_pit_fundamentals_v1.py`

must receive an explicit:

`--available-at <timestamp>`

This prevents `asOfDate`, fiscal period, or current retrieval time from being silently misused as historical information availability.

## Official source references

- Security Profile endpoint documented by SET: `https://marketplace.set.or.th/api/public/reference-data/security-profile`.
- Financial Statement all-companies endpoint documented by SET: `https://marketplace.set.or.th/api/public/financial-statement/all`.
- Financial Statement Last Update endpoint documented by SET: `https://marketplace.set.or.th/api/public/financial-statement/last-update-date`.
- Company Fundamental Data endpoints documented by SET include EOD statistics and Financial Data & Ratio services.
