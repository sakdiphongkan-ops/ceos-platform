# LUNA Corporate Action Ledger Contract v1

SET's current Information Services pages list Security Profile and Corporate Action data as an API-delivered product, separate from historical EOD trading data. citeturn907553search0turn907553search8

LUNA records corporate actions as point-in-time events rather than silently rewriting research history.

## Time semantics

- `effective_date`: when the economic/security event takes effect.
- `ex_date`: when applicable for dividends/rights.
- `available_at`: when the event became available to the consumer.
- A decision can use an event only when `available_at <= decision_ts`.

## Adjusted-price guard

The current price pipeline can use an adjusted close. When adjusted prices already incorporate a split/dividend, the corporate-action ledger is **not** applied a second time.

The ledger therefore serves:

- security lifecycle and eligibility
- event-aware diagnostics
- auditability
- raw-price backtesting/reconstruction when explicitly configured

It must not silently double-adjust returns.

## Event identity

Keep `source + source_record_id` when supplied. Restatements/corrections should create new observable records rather than mutate historical evidence invisibly.
