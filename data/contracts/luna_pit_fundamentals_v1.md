# LUNA PIT Fundamentals Contract v1

The fundamental feed is usable for research only when the source preserves **availability time**.

SET's current SMART Marketplace documentation exposes Company Fundamental Data with financial data and important ratios, while its financial-statement specification exposes fields such as symbol, fiscal year, quarter, statement type, as-of date and adjustment status. Source: SET SMART Marketplace Company Fundamental Data and Financial Statement Data Specification.

## Required time semantics

- `available_at`: when the observation became available to the research consumer.
- `as_of_date`: accounting/reporting date represented by the observation.
- `available_at` must not be inferred from `as_of_date`.
- A point-in-time join uses only rows with `available_at <= decision_ts`.

This distinction is required because an accounting period's end date does not by itself prove when the market could have known the value.

## Revision handling

The feed should preserve restatements rather than overwrite history. Keep:

`statement_type + adjustment_status + available_at + source_record_id`

so a later restatement becomes a new observable record.

## Quarantine

Rows are quarantined when:

- symbol or available_at is missing
- timestamps are malformed
- fiscal period fields are inconsistent
- duplicate source identities are ambiguous
- required numeric fields contain non-numeric values

A validated feed is still research data; the model registry must retain its source hash and validation artifact.
