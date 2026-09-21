# LUNA Point-in-Time Security Master Contract v1

LUNA treats security classification and lifecycle metadata as time-aware data.

## Minimum contract

Each observation must identify:

- `symbol`
- `effective_from`
- `available_at`

Optional but preferred fields:

- `isin`
- `market`
- `sector / sector_code`
- `industry / industry_code`
- `listed_date`
- `delist_date`
- `effective_to`
- `source`
- `source_record_id`

## Leakage rule

For a decision timestamp `decision_ts`, a metadata record is eligible only when:

`available_at <= decision_ts`

The classification effective at `decision_ts` is selected from eligible records using the latest `effective_from` that is not after `decision_ts`.

A statement/report `asOfDate` is not treated as an availability timestamp by itself. The source delivery/publication/API availability time must be preserved separately.

## Thai data-source mapping

SET currently documents SMART Marketplace services covering Reference Data and Corporate Action, including security profile information and corporate actions, and Company Fundamental Data including historical EOD prices/statistics and financial data/ratios. SET also lists PSIMS-Security for historical security details including corporate action and name-change information. citeturn912211search0turn912211search2turn912211search8

SET's financial-statement specification exposes fields such as `symbol`, `fiscalYear`, `quarter`, `statementType`, `asOfDate`, and `adjustmentStatus`; LUNA keeps `asOfDate` conceptually separate from `available_at` to prevent look-ahead leakage. citeturn912211search12

## Required audit fields

The ingestion pipeline should retain:

1. raw source row or immutable raw-file hash
2. source identifier
3. retrieval timestamp
4. source publication/availability timestamp when supplied
5. normalized effective interval
6. validation status
7. reason for quarantine when rejected

## Promotion rule

Absence of PIT lifecycle/sector evidence is a research-data limitation, not permission to silently substitute today's classification for historical observations.
