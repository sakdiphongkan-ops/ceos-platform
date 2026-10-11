# F09542 Recovery and New LUNA Formula — 2026-10-11

## Executive status

- Original F09542 is not recovered. Exact-label searches of current Supabase research records, GitHub code/commit search, and the connected knowledge-base search found no traceable record. This is not proof the formula never existed in another export, old chat, external workspace, or unsearched branch.
- Do not rename or alias F0954 as F09542. The catalog contains multiple incompatible definitions under the short display label F0954, and the four-number metric fingerprint supplied for F09542 could not be tied to an immutable definition.
- New candidate saved: LUNA_MR_70_30_V1, version 1.0.0, formula SHA-256 b8be7f0fcd9ad0f9d4c7d08becd6971fce8dd5a0821ed18f7bbfe3f678cca866.
- Supabase persistence verified: formula catalog ID 2000; run ID 1c2cadeb-7522-4013-9154-aa756b12c4ff; 57 monthly return records from 2021-12-01 through 2026-08-01; all 57 records have selected_count = 20.
- Release posture: PAPER_SHADOW_ONLY. These results do not authorize live-order enablement or production promotion.

## Why a formula can appear to be lost

The evidence supports a persistence and traceability failure, but it does not identify which past message or step lost the original. A conversation answer is not automatically a formula row or versioned research artifact; it must be explicitly written to a durable store.

The current research schema has weaknesses that make formula recovery ambiguous:

1. luna_research_formula_catalog_v2 has IDs 0–1,999, but a display label is not a globally unique identity. The short label F0954 occurs in artifacts with different factor definitions.
2. luna_research_formula_returns_v2 is keyed by (formula_id, month_end) and has no run ID or dataset ID on each return row. A return series alone therefore does not prove which data snapshot or exact factor definition generated it.
3. An audit of luna_formula_tournament_1000 found 1,000 rows with 1,000 distinct run_id values and an identical creation timestamp. That is not reliable evidence of one reproducible 1,000-candidate tournament.
4. Searches in the connected knowledge base returned no results for distinct queries about F09542, LUNA formula experiments, or prior-session records. These searches do not expose or prove the contents of every historical conversation.

Conclusion: the safest diagnosis is that the project did not consistently enforce a durable, immutable formula-record contract. It would be inaccurate to claim the exact original has been found, or to claim what happened to it beyond the evidence above.

## New candidate definition

Canonical formula file: [LUNA_MR_70_30_V1_20261011.json](./formula-registry/LUNA_MR_70_30_V1_20261011.json)

- Cross-sectional percentile rank each month, ascending within factor.
- Score: -0.70 × percentile_rank(mom1) - 0.30 × percentile_rank(mom3).
- Select the 20 highest-score symbols, equal weight, monthly rebalance, deterministic tie-break symbol ascending.
- Gross portfolio return: average next-month adjusted-close return for selected symbols.
- Turnover: 1 minus the overlap between previous month's top 20 and current top 20, divided by 20.
- Net return: gross_return minus 0.002 times turnover. The 0.002 is inferred from existing stored gross/net series and means a 0.20% return deduction per 1.0 turnover; it is a model assumption, not independently verified current trading costs.
- maxdd60 is deliberately not used: it is NULL in all 52,485 rows in the current monthly-price-factor table.

## Retrospective diagnostics

These are cumulative net returns within each fold, not annualized returns. Sharpe is annualized from monthly net returns. These are diagnostics from the current survivor-oriented universe, not production claims.

| Window | Usable months | Cumulative net return | Annualized Sharpe | Max drawdown | Positive months |
|---|---:|---:|---:|---:|---:|
| Train through Aug 2024 | 33 | +4.44% | 0.22 | -32.82% | — |
| Retrospective OOS, Sep 2024–Aug 2025 | 12 | +13.31% | 0.49 | -34.23% | 58.3% |
| Post-hoc window, Sep 2025–Aug 2026 | 12 | +14.66% | 0.74 | -8.10% | 58.3% |

The intended training window is not complete: only 33 usable months are available in this monthly-factor replay. The post-hoc window is displayed for transparency and must not be treated as a virgin holdout or used to select the candidate. The candidate has a material drawdown profile (greater than 30% in train and retrospective OOS) and high estimated monthly turnover (85.0% in the retrospective OOS window).

## Data provenance and critical limitation

- Dataset: LUNA_RESEARCH_PRICES_DAILY_5Y_COMPACT_20260919.
- Dataset ID: 1af83c59-a56f-461f-b03e-f3d04e67e384.
- Source label: YAHOO_FINANCE_CHART.
- 1,047,656 daily rows, 925 symbols, 2021-09-20 to 2026-09-18.
- luna_research_monthly_price_factors: 52,485 rows, 925 symbols, monthly labels from 2021-09-01 to 2026-09-01.
- The current symbols behave like a survivor-oriented universe: all 925 have data at the dataset end, and known delisted symbols are absent from the inspected price table. Historical point-in-time SET/mai membership and delisted price history have not been reconstructed and verified.

Consequently, survivorship bias can materially distort all reported results. The 2024–2025 OOS window was researched retrospectively in 2026, so it is not a clean prospective test. The candidate must remain shadow/paper-only.

## Database records

- Formula: public.luna_research_formula_catalog_v2.formula_id = 2000.
- Monthly returns: public.luna_research_formula_returns_v2, 57 rows for formula ID 2000.
- Run: public.luna_research_runs.id = 1c2cadeb-7522-4013-9154-aa756b12c4ff.
- Dataset: public.luna_research_datasets.id = 1af83c59-a56f-461f-b03e-f3d04e67e384.
- The run configuration stores the formula hash, definition, data-quality warnings, metrics, and paper-only gate. The JSON file in the repository is the human/audit-friendly canonical formula spec.

## Required promotion gates

1. Build a validated point-in-time SET/mai membership manifest from versioned official source artifacts, including IPO/listing dates, delistings, non-overlapping membership intervals, raw-source hashes, and row-count checks.
2. Rebuild adjusted-price history with delisted names included; audit corporate actions and price availability without using future eligibility to select holdings.
3. Rerun formulas on one immutable dataset snapshot with dataset hash, run ID, formula hash, benchmark identity, monthly returns, and logs linked in the registry.
4. Run cost/slippage sensitivity at 20, 30, and 40 basis points per turnover unit and preserve every candidate (including failed candidates) with its full monthly return series.
5. Freeze this formula before a new prospective paper-only validation window. Do not tune on the post-hoc window.
6. Promote only after risk-adjusted return, drawdown, consistency, and PIT/data-integrity gates pass. Do not enable real-money execution based on this report.

## Permanent saving rule

A formula is not considered saved because it was described in a chat. A candidate is saved only when all of the following exist and are verified:

- immutable formula specification plus SHA-256;
- database catalog ID and research run ID;
- dataset ID and source/data fingerprint;
- full monthly return series with cost model and selected-count checks;
- reproducible method/config and recorded limitations;
- CI validation of the registry entry.

The historical formula F09542 remains marked NOT RECOVERED until an exact source artifact or matching immutable definition is found.
