# LUNA Formula F09542 Forensic Audit

- Audit date: 2026-10-11 (Asia/Bangkok)
- Repository branch: `research/meta-ensemble-data-contract-guards-20261011`
- Pull request: [#29 — Fix LUNA formula research data integrity and look-ahead guards](https://github.com/sakdiphongkan-ops/ceos-platform/pull/29)
- Scope: trace the reported label `F09542` and the metric vector `0.68%, 79.98%, 18.57%, 76.86%`; validate whether existing research data can support a new formula tournament.
- Database writes/deletes: none.

## Finding 1 — Exact label and metric fingerprint are not traceable in current records

The exact label `F09542` was not found in the current formula catalog, formula returns, candidate tables, comparison tests, research-run metadata, or the major LUNA backtest/overlay/ablation result tables searched during this audit. In particular:

- `luna_research_formula_catalog_v2`: 2,000 records, formula IDs 0–1,999; exact `F09542` absent.
- `luna_research_formula_returns_v2`: 88,500 monthly-return records, formula IDs 0–1,499; exact ID/name absent.
- `luna_research_candidates`: 80 candidates (candidate numbers 0–79); exact label absent.
- `luna_research_candidate_monthly`: 3,760 monthly candidate records (candidate numbers 0–79); exact label absent.
- `luna_formula_tournament_1000`: 1,000 records, candidate IDs 21–1,020, 1,000 distinct `run_id` values, all created at the same timestamp (2026-09-19 16:22:28.790554 UTC); exact label absent. This table should not be treated as evidence of a single, reproducible 1,000-candidate run.

The wider database search covered 15 high-relevance research/result tables and returned zero rows whose serialized records contained the exact text `F09542`. This is evidence that the formula is untraceable in the inspected current database—not proof that it never existed in any historical branch, export, or external artifact.

The four reported metrics are also not attached to an identifiable `F09542` row in those records. They must not be used to guess a formula definition or to re-create a candidate under the same label.

## Finding 2 — Current `F0954` is a different, non-equivalent record

The current `luna_research_formula_catalog_v2` contains `formula_id=954, formula_name=F0954`, created at 2026-09-20 08:13:50.6752 UTC. Its current weights are:

| Factor | Weight |
|---|---:|
| `mom12` | -0.222392638036809815951 |
| `mom3` | -0.210122699386503067485 |
| `avg_amount20` | -0.222392638036809815951 |
| `mom1` | -0.345092024539877300613 |

That row is **not** a proven match for `F09542` and does not reproduce the four reported metrics from the stored monthly-return series.

For orientation only, recalculation of this current `F0954` record from its stored monthly net returns produced the following diagnostics (before solving the universe-provenance problem):

| Window | Months | Cumulative return | Mean monthly net return | Positive months |
|---|---:|---:|---:|---:|
| Train, through Aug 2024 | 35 | +58.04% | +1.608% | 60% |
| OOS, Sep 2024–Aug 2025 | 12 | +19.659% | +1.897% | 50% |
| Holdout, Sep 2025–Aug 2026 | 12 | +82.799% | +5.274% | 75% |

These are **exploratory record diagnostics**, not approval or a production-ready performance claim. The current price universe has material survivorship-bias concerns (Finding 4).

## Finding 3 — The same display label has been reused for different formulas

The label `F0954` appears in multiple stored formula-catalog artifacts with incompatible factor definitions. Examples inspected include:

- Adaptive Tournament v2: `mom3`, `mom12`, `avg_amount20`.
- Adaptive Tournament v3 public: `MOM_120`, `ATR_PCT`, `MOM_60`.
- Direct Current Supabase Adaptive 1000 v1: `mom6`, `mom3`, `mom1`.
- Direct Supabase 1000 v1: `vol20`, `mom12`, `mom6`.
- Current Supabase catalog: `mom12`, `mom3`, `avg_amount20`, `mom1`.

Therefore a display name such as `F0954` or `F09542` cannot be used as a globally unique primary key. Formula identity must include a run identifier, immutable dataset identifier/hash, normalized factor definition, and formula-definition hash. Existing catalog artifacts must be preserved rather than overwritten by display label.

## Finding 4 — The existing 925-symbol universe is not approved for ranking formulas

The stored dataset `LUNA_RESEARCH_PRICES_DAILY_5Y_COMPACT_20260919` is sourced from `YAHOO_FINANCE_CHART:1d` and has:

- 1,047,656 daily price rows across 925 symbols, 2021-09-20 through 2026-09-18.
- 52,485 monthly factor rows across 925 symbols, 2021-09 through 2026-09.
- All 925 daily-price symbols have an observed last date of 2026-09-18; 166 symbols have their first observation after 2021-09-20; none has its final observation before the dataset end.
- Several known delisted symbols queried directly (including `ALL`, `STARK`, and `3K-BAT`) are absent from the current daily-price table.
- The prior baseline run `LUNA_M1_S0_K20_REV_925_UNIVERSE_5Y_20260919` already records `survivorship_bias_warning: true` in its config.

This pattern is consistent with a survivor-oriented snapshot and is insufficient for historical point-in-time (PIT) universe eligibility. OOS/holdout figures from this universe must not be promoted as robust results without a defensible historical membership reconstruction and coverage checks.

The official SET website was inspected for both currently listed securities and the delisted-securities statistics page. The latter showed 346 delisted records as of 11 Oct 2026, with symbols, market, first trading dates, and delisting dates. Those official-source rows are useful input evidence, but the complete raw source capture plus a verified transformation into the repository's membership CSV has not yet been committed as a versioned artifact. No manifest was fabricated to bypass this gap.

## Finding 5 — The current M1 comparison series are not identical

The monthly series labelled `formula_id=0` and canonical strategy `luna-m1s0k20rev-v1` align for 59 months (Oct 2021–Aug 2026), but:

- Return correlation: 0.95597.
- Mean absolute monthly-return difference: 0.015067 (about 1.5067 percentage points).
- Maximum absolute monthly-return difference: 0.142684 (about 14.2684 percentage points).
- 50 of 59 months differ by more than the strict 0.0001-percentage-point-scale tolerance used by the audit (fraction-return tolerance 1e-6).

A separately computed top-20 momentum/reversal holdings comparison overlaps an average of 16.63 of 20 securities (median 17, minimum 10) across 59 months. That is not sufficient to assert benchmark identity. Exact month-level holdings and return equality, along with dataset/config/version fingerprints, are required.

## Implementation and CI status

The open Draft PR #29 contains:

- Run-scoped formula identities and formula-definition hashing.
- Fail-closed monthly forward-return and look-ahead checks.
- A PIT membership manifest verifier requiring a versioned source artifact, SHA-256, source metadata, row count, and non-overlapping membership intervals.
- A strict monthly benchmark-alignment audit which fails on different month coverage, duplicate months, or return differences even when correlation is high.
- Browser/login accessibility and client-error telemetry improvements required to get the existing LUNA CI green.

At the audited head `c82d86fe1abf9239d5046f4414f5c6cfc8a413b4`, the latest runs for CEOS Platform Build, LUNA-TH1H CI, LUNA 2.0 CI (including browser compatibility), Next.js Security Upgrade CI, and LUNA formula research integrity CI all completed successfully.

The adaptive-search workflow now intentionally requires both `LUNA_PIT_UNIVERSE_MEMBERSHIP` and `LUNA_PIT_UNIVERSE_MANIFEST`; it will stop rather than run a new ranking if either input is missing or fails validation. Passing code tests does not mean the new historical PIT dataset has been supplied.

## Release decision / next gate

**Status: code guardrails tested; F09542 and the research rerun are not fully resolved.**

Do not merge/promote the research result, rank the formula as a winner, or deploy it to customer/paper strategy selection yet. The next release gate is to recover the original run/catalog that contains both the `F09542` definition and its metric definitions, preserve its source file, compute its definition hash, and provide a source-verified PIT membership CSV plus manifest and raw SET source artifact. Then rerun the monthly benchmark identity test on the same dataset and configuration. If the original source artifact cannot be recovered, retire the unresolved label and rerun as a **new, separately named** experiment; do not claim it is the same formula.
