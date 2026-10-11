# LUNA Formula Lab v1 — Methodology, Evidence and Experiment Log

**Report date:** 2026-10-12 (Asia/Bangkok)  
**Research status:** exploratory only — no candidate is approved for real-money execution  
**Historical formula request:** F09542 remains NOT RECOVERED  
**Current candidate family run:** `acd03a11-a233-47e0-9875-500b6ba45e01` — FAILED as a complete family because five candidates have a missing selected forward outcome in formation month 2026-08

## 1. What we are trying to prove

The task is not to invent a formula that produces an attractive backtest number. It is to find out whether a rule has a repeatable, risk-adjusted return that survives data-integrity checks, trading costs, and a genuinely unseen evaluation window.

There are two separate workstreams:

1. **Recover the exact historical formula.** Preserve the original name, metrics, factor values, weights, code, dataset, run ID and full monthly return series if an authoritative matching artifact is found. A similar display label is not enough.
2. **Create and test new formulas.** Start with a testable market hypothesis, translate it into a mathematical score, freeze the definition, run a reproducible backtest and show both positive and negative evidence.

The two workstreams must never be merged. A newly created candidate cannot inherit the historical F09542 label or its metrics.

## 2. Recovery finding: F09542

Searches of the current Supabase research tables/catalog, repository code and commit search, and the connected knowledge-base search did not locate a matching F09542 definition. The four remembered values (0.68%, 79.98%, 18.57%, 76.86%) could not be tied to a uniquely identified formula and run.

This means **not recovered from the sources inspected**; it does not prove the formula never existed in an unsearched historical chat, branch, export or external workspace. The current catalog contains several incompatible definitions under the shorter label F0954. Using that nearby name as a substitute would fabricate provenance, so we will not do it.

### Why historical formula traceability failed

- Display names such as F0954 are not immutable identities; different artifacts reuse them with different weights.
- Current monthly return rows are keyed by `(formula_id, month_end)` and do not carry the run and dataset identifiers on every row. The source/config mapping must therefore be saved beside the series.
- At least one old tournament table was found with 1,000 rows, 1,000 distinct run IDs and a shared creation timestamp. That cannot be assumed to represent one reproducible 1,000-candidate tournament.
- A chat message alone does not create a database record, a versioned formula specification or a checksummed research artifact.

The durable fix is a formula registry with an immutable definition/hash, database catalog ID, run ID, dataset ID/fingerprint, full monthly returns and explicit status/limitations. The registry validator and CI job are now in the project branch; the formula research CI has passed these checks on the tested candidate revision, while later registry additions are subject to the latest CI runs.

## 3. How research ideas become equations

The current eight-candidate family is a small, theory-driven experiment, not an exhaustive search and not a claim of a winning formula. The ideas come from four types of reasoning:

### A. Financial hypotheses

- **Short-term reversal:** a stock that fell over a short window might temporarily underperform because of short-lived order flow, liquidity shocks or overreaction. This suggests a negative weight on recent momentum (buy relative losers). The hypothesis can fail if the fall reflects permanent adverse information.
- **Medium/longer-term momentum:** trends can persist as information is incorporated over time. This suggests positive weights on medium/long-horizon momentum. The hypothesis can fail in abrupt market reversals.
- **52-week-high proximity:** a stock near its 52-week high can be a trend-strength signal. This is a distinct hypothesis from short-horizon reversal, not automatically complementary in every regime.
- **Risk and investability:** lower realized volatility may reduce risk, and higher traded value may make a position easier to execute. These are not free alpha: liquidity and volatility filters can also remove future winners, while a constant-cost backtest can still underestimate actual spread and market impact.

### B. Behavioral interpretation — what is and is not measured

Reversal and momentum have behavioral explanations in the literature, but this dataset does **not** contain a direct measurement of investor psychology, news sentiment, analyst expectations or retail positioning. The behavior is a hypothesis used to motivate a test; it is not an observed input to these eight formulas. We should not claim that the current formulas “use psychology” as a measured indicator.

### C. Indicators used by this eight-candidate family

The family uses the existing Supabase columns:

- `mom1`, `mom3`, `mom6`, `mom12`: horizon-based price-momentum fields.
- `high52_ratio`: current adjusted price relative to a rolling 52-week trading high.
- `vol20`: a 20-observation realized-volatility field.
- `avg_amount20`: a 20-observation average traded-value field.

The family deliberately does **not** use fundamentals, RSI, MACD, social-media sentiment, news tone, analyst revisions or direct investor-positioning data. Those would be separate hypotheses and require their own point-in-time sources.

**Important lineage caveat:** the repository currently contains multiple factor-builder versions with different conventions for the labels mom1/mom3 (for example, one builder uses 21/63 trading-day returns, while another maps source fields MOM_20/MOM_60). The dataset row in Supabase does not preserve the builder version and code/input/output hashes needed to prove which version generated this exact panel. The factor labels should therefore be read as the stored dataset fields until that lineage is reconciled. This gap is a blocker to production-grade conclusions.

## 4. Mathematical definition of the scoring system

For symbol (i) in formation month (t), let (X_{i,t,j}) be factor (j). For each factor separately, calculate its **ascending cross-sectional percentile rank** using only non-null signal values available at formation:

[
PR_{i,t,j} = \frac{rank_{ascending}(X_{i,t,j}) - 1}{N_{t,j}-1}
]

Here (N_{t,j}) is the number of securities with that factor available in month (t). A low raw value receives a low ascending percentile rank; a high raw value receives a high percentile rank.

The formula score is a weighted sum:

[
S_{i,t} = \sum_j w_j PR_{i,t,j}
]

Choose the 20 highest-scoring securities and give each weight (1/20 = 5%). Ties are broken by symbol in ascending alphabetical order, making selection deterministic. Rebalance monthly.

The sign of a weight has a direct meaning:

- Negative weight on mom1/mom3 favours low recent returns (reversal).
- Positive weight on mom3/mom6/mom12 favours high recent returns (momentum).
- Positive weight on high52_ratio favours stocks nearer their rolling 52-week highs.
- Negative weight on vol20 favours lower measured volatility.
- Positive weight on avg_amount20 favours higher traded value as a liquidity proxy.

The percentages in the weights are design choices for an initial experiment, not statistically estimated optimal parameters. For example, the MR 70/30 formula gives 70% of its absolute weighting to one-month reversal and 30% to three-month reversal to test the claim that the shorter-horizon effect should dominate but receive some smoothing. It has not been proven that 70/30 is optimal.

## 5. Candidate hypotheses and results

Returns below are cumulative, net of the simplified 20-basis-point-per-turnover-unit cost model, and use the current survivor-oriented dataset. The Train and OOS windows can be compared only as retrospective diagnostics because the experiment was run after those historical dates. The post-hoc window is **not** a virgin holdout and must never be used to choose the winner.

| Candidate | Mathematical hypothesis | Train: cumulative / Sharpe / MaxDD | Retrospective OOS: cumulative / Sharpe / MaxDD | Post-hoc window: cumulative / Sharpe / MaxDD |
|---|---|---:|---:|---:|
| BASE_M1_REV | Buy recent one-month losers | -14.32% / 0.00 / -43.06% | +20.28% / 0.63 / -29.18% | +5.05% / 0.40 / -4.65% |
| MR_70_30 | 70% one-month reversal, 30% three-month reversal | +3.59% / 0.21 / -33.37% | +13.31% / 0.49 / -34.23% | +8.62% / 0.51 / -8.10% |
| MR_60_40 | Balanced one- and three-month reversal | +2.69% / 0.21 / -36.47% | +0.46% / 0.18 / -35.52% | +17.38% / 0.88 / -3.81% |
| MR_MIX_50_30_20 | Reversal plus 20% positive six-month momentum | -32.53% / -0.60 / -40.72% | -25.33% / -0.99 / -38.16% | +19.96% / 1.13 / -4.54% |
| MR_MIX_70_20_10 | Strong short reversal with small six-month trend term | -21.41% / -0.13 / -36.94% | +19.61% / 0.62 / -34.00% | +22.77% / 1.12 / -4.72% |
| REV_LOWVOL_LIQ | Reversal + lower volatility + higher traded-value proxy | -25.64% / -0.22 / -47.80% | -15.61% / -0.43 / -33.96% | -15.19% / -0.91 / -8.30% |
| TREND_MOM_4F | Positive mom3/mom6/mom12 and 52-week-high proximity | -12.67% / -0.39 / -23.17% | +2.04% / 0.19 / -21.37% | +32.99% / 1.76 / -1.65% |
| TREND_RISK_ADJ_4F | Positive medium/long momentum and high52_ratio, negative vol20 | -7.66% / -0.41 / -11.20% | -2.95% / -0.28 / -10.72% | +32.39% / 2.48 / -1.69% |

**Interpretation:** no candidate qualifies as a winner. MR_70_30 is positive in Train and retrospective OOS but has a roughly 34% drawdown, a Sharpe below 0.5 in OOS and high turnover. Its OOS sample contains only 12 monthly observations. Under the 20-bps cost model, its OOS mean-monthly-return confidence interval is approximately -5.77% to +9.07%, which includes zero. Cost stress at 30 and 40 bps reduces OOS cumulative return from +13.31% to +12.16% and +11.02%, while Sharpe falls from 0.489 to 0.464 and 0.438. These data do not establish a reliable positive expectancy.

The two trend variants look very strong only in the post-hoc window, while their Train/OOS diagnostics are negative or weak. That is a direct example of why a result that looks impressive after the fact is not enough to select a formula.

## 6. Exact return, turnover, risk and statistical calculations

For the 20 selected names with valid next-calendar-month adjusted prices:

**Gross return**

[
R^{gross}_{t+1} = \frac{1}{20}\sum_{i \in H_t}\left(\frac{P^{adj}_{i,t+1}}{P^{adj}_{i,t}}-1\right)
]

where (H_t) is the fixed portfolio selected using signals at formation month (t). It is not permissible to remove a selected stock merely because its next-month price is missing.

**Turnover proxy**

[
TO_t = 1 - \frac{|H_t \cap H_{t-1}|}{20}
]

The first portfolio has turnover set to 1.0. This is a simplified holdings-overlap proxy; it does not reproduce every implementation detail of actual order quantities, weight drift or market impact.

**Net return under the cost scenario**

[
R^{net}_t = R^{gross}_t - c\,TO_t
]

where (c) is 0.002, 0.003 or 0.004 for the 20/30/40 basis-point stress cases per full unit of turnover. This is a transparent assumption, not an authoritative estimate of all Thai-market commissions, spread, tax, slippage or price impact.

**Cumulative return**

[
R^{cum}_{1:T}=\prod_{t=1}^{T}(1+R^{net}_t)-1
]

**Annualized monthly Sharpe approximation**

[
Sharpe_{ann}=\sqrt{12}\frac{\overline{R^{net}}}{s(R^{net})}
]

The current diagnostics use zero as the monthly risk-free-rate approximation. This formula does not correct for autocorrelation, non-normal tails or the small sample size, so it must not be interpreted as a guarantee.

**Maximum drawdown**

[
DD_t=\frac{E_t}{\max_{u\le t}E_u}-1,\qquad MaxDD=\min_t DD_t
]

where (E_t) is the compounded net-return equity curve. Positive-month rate, average turnover and worst month are also reported; we will not choose formulas on cumulative return alone.

## 7. Data and look-ahead controls

The dataset currently has 1,047,656 daily price rows for 925 symbols, 2021-09-20 to 2026-09-18, and 52,485 monthly factor rows. The present universe is survivor-oriented: all 925 symbols have late-period observations, while known delisted securities are absent from the inspected price history. Point-in-time SET/mai membership and complete delisted/terminal-return histories are not verified.

The latest experiment also exposed a real missing-outcome case: F&D was selected by five candidates at formation month 2026-08 but had no valid September 2026 adjusted close in the panel. Correct handling is to mark those candidate-month outcomes missing and fail the candidate run as complete; it is not to filter F&D before ranking or silently insert rank 21. The corrected family run is marked FAILED as a complete family, with three candidate series complete over the observed evaluation horizon and five partial series.

The earlier replay under catalog ID 2000 was invalidated and its run marked FAILED after an audit found outcome-availability filtering before ranking. Its rows are retained as an audit trail only, not as validated performance evidence. Strict version 1.0.1 is catalog ID 2001, run ID `b1f44b4e-ba1b-4097-95ef-eedfa8ebd601`, with 56 valid prior months and the missing August 2026 outcome explicitly recorded. The eight-family run ID is `acd03a11-a233-47e0-9875-500b6ba45e01`; the full 427-row monthly return audit, with 20/30/40-bps net returns and incompleteness markers, is saved in [luna-theory-driven-8-candidate-family-20261012-monthly-series.json](./formula-lab/luna-theory-driven-8-candidate-family-20261012-monthly-series.json).

All metrics are exploratory until point-in-time membership, terminal prices, adjustment handling, factor-builder lineage and a clean future evaluation period are all independently verified.

## 8. What “winner” will mean from now on

A candidate cannot be promoted merely because its best historical window looks attractive. Promotion requires all of these gates:

1. **Provenance gate:** source-verified point-in-time SET/mai membership, delisted/terminal return history, data snapshot hash, factor-builder/version hash, and duplicate/gap checks.
2. **Signal-only gate:** portfolio formation uses only features available at the formation timestamp; return availability is checked afterwards. Missing selected returns fail the month—no substitutions.
3. **Reproducibility gate:** immutable formula definition/hash, exact run ID, dataset ID/fingerprint, source metadata, all monthly return rows and costs, selected holdings or a replayable deterministic rule, and CI checks.
4. **Research separation gate:** Train/DEV may be used to develop hypotheses; OOS is reported honestly; the final holdout is frozen and opened only once. Because this current OOS/history has already been inspected, a new prospective paper-only window is needed.
5. **Risk gate:** require positive net results under cost stress, acceptable drawdown and turnover, stability across regimes/windows, benchmark alignment, and uncertainty intervals—not a single strong Sharpe or CAGR.
6. **Paper-validation gate:** run the frozen signal in shadow/paper mode against contemporaneous data and record signals, fills, slippage assumptions, rejected trades and reconciliation before considering any real-money decision.

The eight formula weights were theory-motivated and hand-specified. They were not fit with regression or optimized to maximize the post-hoc period. We still need broader, pre-registered family testing and an untouched prospective period to make a credible statement about reliability. If a future candidate is selected by comparing many formulas, the selection procedure itself must be considered a source of backtest overfitting.

## 9. Next research queue

- Recover F09542 only from exact authoritative artifacts; keep searching historical exports/branches where available without using F0954 as a proxy.
- Bind the existing monthly price-factor dataset to the exact factor-builder version and its input/output checksums. The current dataset metadata does not yet prove this lineage.
- Reconstruct historical PIT membership and delisted-price coverage before ranking the whole SET/mai universe.
- Re-run the predeclared eight-candidate family after source/data repair, then expand with separate hypothesis families (short-term reversal, medium-term momentum, 52-week-high trend, low-volatility, investability/liquidity, and only later value/quality fundamentals or sentiment features if point-in-time sources exist).
- Save every candidate, including losing candidates, with the same artifacts and tests. Never report only the winner.
- Freeze the final candidate and wait for a prospective paper-only trial; do not tune on the trial period.

## 10. Research references informing hypotheses (not proof of LUNA performance)

- Jegadeesh (1990), *Evidence of Predictable Behavior of Security Returns*. The paper studies short-horizon return predictability and motivates testing reversal-type effects; it does not establish that this exact Thai-market formula will work. [Journal of Finance / Wiley](https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.1990.tb05110.x)
- Jegadeesh and Titman (1993), *Returns to Buying Winners and Selling Losers*. The study documents historical 3–12 month momentum effects in its data; that motivates a separate medium/long momentum family. [Journal of Finance / Wiley](https://doi.org/10.1111/j.1540-6261.1993.tb04702.x)
- George and Hwang (2004), *The 52-Week High and Momentum Investing*. It motivates testing proximity to the 52-week high separately from past returns. [Journal of Finance / Wiley](https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.2004.00695.x)
- Bekaert, Harvey and Lundblad (2005/2007), *Liquidity and Expected Returns: Lessons From Emerging Markets*. Their findings motivate testing liquidity in emerging markets, while also warning that liquidity measures are not interchangeable. [NBER Working Paper 11413](https://www.nber.org/papers/w11413) · [Review of Financial Studies](https://doi.org/10.1093/rfs/hhm030)
- Bailey, Borwein, López de Prado and Zhu (2015), *The Probability of Backtest Overfitting*. It explains why searching many strategies and then selecting the top observed result can lead to overfit conclusions; the whole selection process matters. [SSRN paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253)
- Novy-Marx and Velikov (2016), *A Taxonomy of Anomalies and Their Trading Costs*. It shows that transaction costs can erase apparent factor-strategy profitability, especially at high turnover. [Review of Financial Studies](https://doi.org/10.1093/rfs/hhv063)
- Li, Chow, Pickard and Garg (2019), *Transaction Costs of Factor-Investing Strategies*. It discusses market impact, turnover concentration and liquidity demands beyond a simple flat cost. [Financial Analysts Journal / CFA Institute](https://rpc.cfainstitute.org/research/financial-analysts-journal/2019/0015198x-2019-1567190)

These studies provide hypotheses and methodological warnings. They are not evidence that any candidate in this report has positive future expectancy.
