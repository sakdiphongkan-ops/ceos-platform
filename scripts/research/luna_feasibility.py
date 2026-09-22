#!/usr/bin/env python3
"""Auditable LUNA feasibility layer for realized monthly research returns."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def geometric_monthly_return(x) -> float:
    s = pd.Series(x, dtype=float).replace([np.inf, -np.inf], np.nan).dropna()
    if s.empty or (s <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(s).mean()))


def max_drawdown_stats(returns, initial_capital: float = 30000.0) -> dict:
    s = pd.Series(returns, dtype=float).replace([np.inf, -np.inf], np.nan).dropna()
    if s.empty:
        return {
            "max_drawdown_pct": None, "max_drawdown_baht": None,
            "peak_baht": None, "trough_baht": None,
            "ending_baht": initial_capital,
        }
    equity = initial_capital * np.cumprod(1 + s.to_numpy())
    peak = np.maximum.accumulate(equity)
    dd = equity / peak - 1
    i = int(np.argmin(dd))
    return {
        "max_drawdown_pct": float(dd[i]),
        "max_drawdown_baht": float(equity[i] - peak[i]),
        "peak_baht": float(peak[i]),
        "trough_baht": float(equity[i]),
        "ending_baht": float(equity[-1]),
    }


def newey_west_mean_tstat(returns, max_lag: int = 3):
    s = pd.Series(returns, dtype=float).replace([np.inf, -np.inf], np.nan).dropna()
    n = len(s)
    if n < 3:
        return None
    x = s.to_numpy()
    c = x - x.mean()
    lag = min(max_lag, n - 1)
    lrv = float(np.dot(c, c) / n)
    for k in range(1, lag + 1):
        gamma = float(np.dot(c[k:], c[:-k]) / n)
        lrv += 2 * (1 - k / (lag + 1.0)) * gamma
    se = np.sqrt(max(lrv, 0) / n)
    return None if se == 0 else float(x.mean() / se)


def summarize(returns, initial_capital: float, target: float, nw_lag: int = 3) -> dict:
    s = pd.Series(returns, dtype=float).replace([np.inf, -np.inf], np.nan).dropna()
    n = len(s)
    if not n:
        return {"months": 0, "geometric_monthly_return": -1.0, "target_hit_pct": 0.0, **max_drawdown_stats(s, initial_capital)}
    mean = float(s.mean())
    std = float(s.std(ddof=1)) if n > 1 else None
    geo = geometric_monthly_return(s)
    annual_vol = float(std * np.sqrt(12)) if std is not None else None
    sharpe = float(mean / std * np.sqrt(12)) if std and std > 0 else None
    worst_3m = None
    if n >= 3:
        worst_3m = float(((1 + s).rolling(3).apply(np.prod, raw=True) - 1).min())
    return {
        "months": int(n),
        "arithmetic_monthly_return": mean,
        "geometric_monthly_return": geo,
        "annualized_geometric_return": float((1 + geo) ** 12 - 1) if geo > -1 else -1.0,
        "annualized_volatility": annual_vol,
        "sharpe_annualized_zero_rf": sharpe,
        "hac_t_stat_mean_gt_zero": newey_west_mean_tstat(s, nw_lag),
        "positive_month_pct": float((s > 0).mean()),
        "target_hit_pct": float((s >= target).mean()),
        "months_ge_target": int((s >= target).sum()),
        "min_monthly_return": float(s.min()),
        "max_monthly_return": float(s.max()),
        "skewness": float(s.skew()) if n >= 3 else None,
        "excess_kurtosis": float(s.kurt()) if n >= 4 else None,
        "worst_3m_compound": worst_3m,
        **max_drawdown_stats(s, initial_capital),
    }


def validate_ledger(df: pd.DataFrame) -> None:
    req = {"month_end", "gross_return", "turnover", "transaction_cost", "realized_return"}
    missing = sorted(req - set(df.columns))
    if missing:
        raise SystemExit(f"FEASIBILITY_REQUIRED_COLUMNS_MISSING:{missing}")
    if df["month_end"].duplicated().any():
        raise SystemExit("FEASIBILITY_DUPLICATE_MONTH")
    for c in ["gross_return", "turnover", "transaction_cost", "realized_return"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    if df[["gross_return", "turnover", "transaction_cost", "realized_return"]].isna().any().any():
        raise SystemExit("FEASIBILITY_NUMERIC_NA")
    if (df["turnover"] < 0).any():
        raise SystemExit("FEASIBILITY_NEGATIVE_TURNOVER")
    if not np.allclose(
        (df["gross_return"] - df["transaction_cost"] - df["realized_return"]).to_numpy(),
        0.0, atol=1e-12,
    ):
        raise SystemExit("FEASIBILITY_RETURN_COST_RECONCILIATION_FAILED")


def cost_stress(ledger: pd.DataFrame, stress_bps, initial_capital: float, target: float, nw_lag: int) -> list[dict]:
    rows = []
    for bps in stress_bps:
        net = ledger["gross_return"] - ledger["turnover"] * float(bps) / 10000.0
        rows.append({"cost_bps": float(bps), **summarize(net, initial_capital, target, nw_lag)})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--initial-capital", type=float, default=30000.0)
    ap.add_argument("--target-monthly-return", type=float, default=0.07)
    ap.add_argument("--baseline-cost-bps", type=float, default=20.0)
    ap.add_argument("--stress-bps", default="20,30,50,75,100")
    ap.add_argument("--nw-lag", type=int, default=3)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    ledger = pd.read_csv(args.ledger)
    ledger["month_end"] = pd.to_datetime(ledger["month_end"], errors="coerce")
    if ledger["month_end"].isna().any():
        raise SystemExit("FEASIBILITY_INVALID_MONTH")
    validate_ledger(ledger)
    ledger = ledger.sort_values("month_end").reset_index(drop=True)

    baseline = ledger["gross_return"] - ledger["turnover"] * args.baseline_cost_bps / 10000.0
    if not np.allclose(baseline.to_numpy(), ledger["realized_return"].to_numpy(), atol=1e-12):
        raise SystemExit("FEASIBILITY_BASELINE_COST_MISMATCH")

    base = summarize(baseline, args.initial_capital, args.target_monthly_return, args.nw_lag)
    stress_bps = tuple(float(x.strip()) for x in args.stress_bps.split(",") if x.strip())
    stress = cost_stress(ledger, stress_bps, args.initial_capital, args.target_monthly_return, args.nw_lag)
    result = {
        "status": "COMPLETED",
        "engine": "luna-feasibility-v1",
        "initial_capital_baht": args.initial_capital,
        "baseline_cost_bps": args.baseline_cost_bps,
        "target_monthly_return": args.target_monthly_return,
        "baseline": base,
        "average_turnover": float(ledger["turnover"].mean()),
        "median_turnover": float(ledger["turnover"].median()),
        "total_transaction_cost_return_units": float(ledger["transaction_cost"].sum()),
        "cost_stress": stress,
        "hurdle": {
            "geometric_monthly_return_meets_target": bool(base["geometric_monthly_return"] >= args.target_monthly_return),
            "hac_t_stat_gt_1_645": None if base["hac_t_stat_mean_gt_zero"] is None else bool(base["hac_t_stat_mean_gt_zero"] > 1.645),
            "stress_cases_meeting_target": int(sum(x["geometric_monthly_return"] >= args.target_monthly_return for x in stress)),
            "stress_case_count": len(stress),
        },
        "methodology": {
            "return_path": "realized monthly portfolio returns supplied by upstream walk-forward research",
            "cost_model": "gross_return - turnover * cost_bps / 10000",
            "drawdown_basis": f"{args.initial_capital:.2f} THB initial capital",
            "hac_t_stat": f"Newey-West HAC mean t-stat, max_lag={args.nw_lag}",
            "hurdle_rule": "7% monthly is a hurdle/gate, not a training target",
        },
        "disclaimer": "This layer does not prove future performance and does not remove model-selection, regime, liquidity, or market-impact risk.",
    }
    (out / "feasibility_summary.json").write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    pd.DataFrame(stress).to_csv(out / "feasibility_cost_stress.csv", index=False)
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
