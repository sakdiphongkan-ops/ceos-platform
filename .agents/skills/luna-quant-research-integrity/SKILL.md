---
name: luna-quant-research-integrity
description: Apply leakage-resistant validation, point-in-time data alignment, realistic costs and overfit controls to LUNA research.
---

# LUNA quantitative research integrity

## Core requirements
- Preserve chronological train/validation/test separation. Never shuffle time-series observations across the time boundary.
- Calculate rolling features and labels from information available at the decision time; exclude current/future observations where appropriate.
- Join fundamentals and disclosures by published/accepted/availability timestamp, not fiscal period-end. Preserve later revisions as later-known data.
- Record all configurations tried. A strong score selected from many variants is not independent validation.
- Include fees, spread, slippage and market impact; report sensitivity to reasonable cost increases.
- Keep OOS separate from HOLDOUT. Use HOLDOUT only for the final confirmation and do not tune on it after inspecting results.
- Report benchmark-relative performance, trade counts, drawdown and stability across periods, not just gross CAGR or accuracy.
- Keep data manifests, sample windows, universe membership rules and source timestamps with each research artifact.

## Recommended upstream references
- Lookahead bias: https://github.com/MorrisonAnalytical/ML4T_skills/tree/main/concepts/lookahead-bias
- Point-in-time correctness: https://github.com/MorrisonAnalytical/ML4T_skills/tree/main/concepts/point-in-time
- Transaction-cost feasibility: https://github.com/MorrisonAnalytical/ML4T_skills/tree/main/concepts/transaction-costs
- Backtest overfitting: https://github.com/MorrisonAnalytical/ML4T_skills/tree/main/concepts/backtest-overfitting

These links are references, not copied upstream content. Review each upstream license before importing code or redistributing more than a link.

## Before accepting a strategy result
- Confirm the data has no lookahead or survivorship leakage.
- Confirm the strategy and benchmark use the same dates and compatible cost assumptions.
- Confirm OOS/HOLDOUT haven't been used for iterative tuning.
- State missing evidence and known limitations explicitly.
