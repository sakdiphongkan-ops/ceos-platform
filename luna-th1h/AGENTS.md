# LUNA-TH1H agent instructions

These rules apply to changes under `luna-th1h/`.

## Market data
- Never fabricate, interpolate or silently substitute an unverified quote.
- Treat `Quote.ts` as ingestion time and `Quote.sourceTs` as source-event time; assess both when source time is supplied.
- Do not accept provider response-generation time as a market-event timestamp unless the provider contract documents that meaning.
- Preserve rejection reasons so stale, malformed, future-dated and unverified observations remain diagnosable.
- Do not relax freshness limits merely to increase the number of accepted symbols.

## Research
- Use chronological validation and point-in-time availability timestamps.
- Model realistic costs and record the full parameter/configuration search.
- Keep OOS and HOLDOUT separate and preserve the independent holdout.

## Execution
- Keep paper/research mode and existing execution gates intact.
- A quote-quality pass is not broker authorization. A coverage threshold pass alone never authorizes orders.
- Do not enable or arm live execution as part of testing, refactoring, data-source work or research.

## Validation
- For changes to quote normalization or quality, run `npm run typecheck` and `npm run test:data-quality` from this directory.
- Add deterministic regression tests for every newly discovered data-quality failure mode.
