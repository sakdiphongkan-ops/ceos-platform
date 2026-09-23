#!/usr/bin/env python3
"""LUNA M1 orthogonal sizer v2 — canonical factor contract.

Base:
- exact locked M1 monthly basket (20 names)
- next-month return from the locked M1 holdings table

Auxiliary signal (computed only inside the exact M1 basket):
    0.40 * rank(MOM3)
  + 0.25 * rank(52W_HIGH_RATIO)
  + 0.20 * rank(LOW_VOL20)
  + 0.15 * rank(AVG_AMOUNT20)

The auxiliary signal is residualized against M1 selection_score separately
for each month. This prevents re-counting the same alpha already embedded in
M1's ranking score.

Frozen lambda:
    1.0, selected using validation only.

Weights:
    (1 + lambda*z_rank) / 20
where z_rank runs from -1 to +1. Therefore each M1 name is 0%..10% and the
portfolio weights sum exactly to 100%.

Cost convention:
    turnover = 0.5 * sum(abs(weight_t - weight_t-1))
    transaction cost = 2 * turnover * cost_bps_per_side / 10_000

The module is research-only and cannot arm live trading.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


TOP_K = 20
FROZEN_LAMBDA = 1.0
AUX_WEIGHTS = {
    "mom3_rank": 0.40,
    "high52_rank": 0.25,
    "low_vol20_rank": 0.20,
    "amount_rank": 0.15,
}


def geometric(x: pd.Series) -> float:
    s = pd.Series(x, dtype=float).dropna()
    if s.empty or (s <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(s).mean()))


def nw_tstat(x: pd.Series, max_lag: int = 3) -> float | None:
    s = pd.Series(x, dtype=float).dropna()
    n = len(s)
    if n < 3:
        return None
    a = s.to_numpy(dtype=float)
    mu = float(a.mean())
    c = a - mu
    long_var = float(np.dot(c, c) / n)
    for lag in range(1, min(max_lag, n - 1) + 1):
        gamma = float(np.dot(c[lag:], c[:-lag]) / n)
        long_var += 2.0 * (1.0 - lag / (max_lag + 1.0)) * gamma
    se = np.sqrt(max(long_var, 0.0) / n)
    return None if se == 0 else float(mu / se)


def summary(path: pd.DataFrame, initial_capital: float = 30000.0) -> dict:
    r = pd.to_numeric(path["net_return"], errors="coerce").dropna()
    if r.empty:
        return {"months": 0}

    equity = initial_capital * np.cumprod(1.0 + r.to_numpy())
    peak = np.maximum.accumulate(equity)
    dd = equity / peak - 1.0
    return {
        "months": int(len(r)),
        "geometric_monthly_return": geometric(r),
        "arithmetic_monthly_return": float(r.mean()),
        "positive_month_pct": float((r > 0).mean()),
        "worst_month": float(r.min()),
        "best_month": float(r.max()),
        "average_turnover": float(path["turnover"].mean()),
        "hac_t_stat": nw_tstat(r, 3),
        "max_drawdown_pct": float(dd.min()),
        "max_drawdown_baht": float((equity - peak).min()),
        "ending_baht": float(equity[-1]),
    }


def load_inputs(m1_path: str, factors_path: str) -> pd.DataFrame:
    m1 = pd.read_csv(m1_path)
    factors = pd.read_csv(factors_path)

    need_m1 = {"month_end", "symbol", "selection_score", "next_month_return"}
    need_f = {"month_end", "symbol", "mom3", "high52_ratio", "vol20", "avg_amount20"}

    miss_m1 = sorted(need_m1 - set(m1.columns))
    miss_f = sorted(need_f - set(factors.columns))
    if miss_m1:
        raise SystemExit(f"M1_REQUIRED_COLUMNS_MISSING:{miss_m1}")
    if miss_f:
        raise SystemExit(f"FACTOR_REQUIRED_COLUMNS_MISSING:{miss_f}")

    m1["month_end"] = pd.to_datetime(m1["month_end"])
    factors["month_end"] = pd.to_datetime(factors["month_end"])
    m1["symbol"] = m1["symbol"].astype(str).str.upper().str.strip()
    factors["symbol"] = factors["symbol"].astype(str).str.upper().str.strip()

    for col in ["selection_score", "next_month_return"]:
        m1[col] = pd.to_numeric(m1[col], errors="coerce")
    for col in ["mom3", "high52_ratio", "vol20", "avg_amount20"]:
        factors[col] = pd.to_numeric(factors[col], errors="coerce")

    m1 = (
        m1.sort_values(["month_end", "rank_no"] if "rank_no" in m1 else ["month_end", "symbol"])
        .drop_duplicates(["month_end", "symbol"])
        .copy()
    )
    factors = factors.drop_duplicates(["month_end", "symbol"]).copy()

    counts = m1.groupby("month_end")["symbol"].nunique()
    bad = counts[counts != TOP_K]
    if not bad.empty:
        raise SystemExit(f"M1_BASKET_MUST_BE_EXACTLY_20:{bad.to_dict()}")

    x = m1.merge(
        factors,
        on=["month_end", "symbol"],
        how="left",
        validate="one_to_one",
    )

    missing_mom3 = x["mom3"].isna()
    # IPO/new-history names may have no 63-day history. Neutralize only this
    # factor at the within-basket 50th percentile; do not drop the M1 holding.
    x["mom3_missing"] = missing_mom3
    x["mom3"] = x["mom3"].fillna(
        x.groupby("month_end")["mom3"].transform("median")
    )

    for col in ["high52_ratio", "vol20", "avg_amount20"]:
        if x[col].isna().any():
            raise SystemExit(f"FACTOR_COVERAGE_FAILURE:{col}")

    x["r_mom3"] = x.groupby("month_end")["mom3"].rank(pct=True, method="average")
    x["r_high52"] = x.groupby("month_end")["high52_ratio"].rank(
        pct=True, method="average"
    )
    x["r_vol20"] = x.groupby("month_end")["vol20"].rank(
        pct=True, method="average"
    )
    x["r_amount"] = x.groupby("month_end")["avg_amount20"].rank(
        pct=True, method="average"
    )

    x["aux_score"] = (
        AUX_WEIGHTS["mom3_rank"] * x["r_mom3"]
        + AUX_WEIGHTS["high52_rank"] * x["r_high52"]
        + AUX_WEIGHTS["low_vol20_rank"] * (1.0 - x["r_vol20"])
        + AUX_WEIGHTS["amount_rank"] * x["r_amount"]
    )

    # Monthly residualization against exact M1 score.
    frames = []
    for month, frame in x.groupby("month_end", sort=True):
        frame = frame.copy()
        score = frame["selection_score"].to_numpy(dtype=float)
        aux = frame["aux_score"].to_numpy(dtype=float)
        if np.ptp(score) == 0:
            frame["resid"] = aux - aux.mean()
        else:
            slope, intercept = np.polyfit(score, aux, 1)
            frame["resid"] = aux - (intercept + slope * score)
        frames.append(frame)
    x = pd.concat(frames, ignore_index=True)

    x["resid_rank"] = x.groupby("month_end")["resid"].rank(
        ascending=False, method="first"
    )
    x["weight"] = (
        1.0 + FROZEN_LAMBDA * ((x["resid_rank"] - 10.5) / 9.5)
    ) / TOP_K

    if not np.isclose(
        x.groupby("month_end")["weight"].sum().to_numpy(), 1.0, atol=1e-12
    ).all():
        raise SystemExit("WEIGHTS_DO_NOT_SUM_TO_ONE")

    if x["weight"].min() < -1e-12 or x["weight"].max() > 0.100000000001:
        raise SystemExit("WEIGHT_RANGE_FAILURE")

    return x.sort_values(["month_end", "symbol"]).reset_index(drop=True)


def monthly_path(
    x: pd.DataFrame,
    cost_bps_per_side: float,
    initial_capital: float,
) -> pd.DataFrame:
    rows = []
    previous: dict[str, float] = {}

    for month, frame in x.groupby("month_end", sort=True):
        current = dict(zip(frame["symbol"], frame["weight"]))
        names = set(current) | set(previous)
        turnover = (
            1.0
            if not previous
            else 0.5
            * sum(abs(current.get(name, 0.0) - previous.get(name, 0.0)) for name in names)
        )
        gross = float(np.sum(frame["weight"] * frame["next_month_return"]))
        cost = 2.0 * turnover * cost_bps_per_side / 10000.0
        net = gross - cost
        rows.append(
            {
                "month_end": month,
                "gross_return": gross,
                "turnover": turnover,
                "transaction_cost": cost,
                "net_return": net,
                "max_weight": float(frame["weight"].max()),
                "min_weight": float(frame["weight"].min()),
                "mom3_missing_count": int(frame["mom3_missing"].sum()),
            }
        )
        previous = current

    path = pd.DataFrame(rows)
    path["equity_baht"] = initial_capital * (1.0 + path["net_return"]).cumprod()
    peak = path["equity_baht"].cummax()
    path["drawdown_pct"] = path["equity_baht"] / peak - 1.0
    return path


def stress_table(
    x: pd.DataFrame,
    costs=(20, 40, 60, 100),
    initial_capital: float = 30000.0,
) -> list[dict]:
    rows = []
    for cost in costs:
        path = monthly_path(x, float(cost), initial_capital)
        rows.append({"cost_bps_per_side": int(cost), **summary(path, initial_capital)})
    return rows


def period_summary(path: pd.DataFrame) -> dict:
    out = {}
    for label, start, end in [
        ("PRE_VALIDATION", "2021-10-31", "2024-08-31"),
        ("VALIDATION", "2024-09-30", "2025-08-31"),
        ("HOLDOUT", "2025-09-30", "2026-08-31"),
    ]:
        s = path[(path.month_end >= start) & (path.month_end <= end)]
        out[label] = summary(s, 30000.0)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--m1-holdings", required=True)
    ap.add_argument("--canonical-factors", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--cost-bps-per-side", type=float, default=20.0)
    args = ap.parse_args()

    if abs(args.cost_bps_per_side - 20.0) > 10000:
        raise SystemExit("INVALID_COST")

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    x = load_inputs(args.m1_holdings, args.canonical_factors)
    path = monthly_path(x, args.cost_bps_per_side, 30000.0)

    result = {
        "status": "RESEARCH_ONLY",
        "engine": "luna-m1-orthogonal-sizer-v2",
        "strategy_version": "luna-m1-orthogonal-sizer-l2-v1",
        "lambda": FROZEN_LAMBDA,
        "base_strategy": "luna-m1s0k20rev-v1",
        "candidate_formula": AUX_WEIGHTS,
        "weight_rule": "0%..10% per stock, sum=100%",
        "cost_convention": "two-sided; turnover=0.5*L1(weight change); cost=2*turnover*bps_per_side",
        "periods": period_summary(path),
        "cost_stress": stress_table(x),
        "factor_missing_policy": "MOM3 missing -> neutral 50th percentile inside exact M1 basket; no name is dropped",
        "data_contract": "Auxiliary factors are canonical monthly factors, ranked only within exact M1 20-stock basket. No global 924/925 universe rank is used.",
        "promotion_gate": {
            "research": True,
            "paper": False,
            "customer": False,
            "live": False,
            "requirements": [
                "frozen candidate passes blind paper shadow replay",
                "official realtime data freshness verified",
                "broker reconciliation verified",
            ],
        },
    }

    x.to_csv(output / "canonical_weight_ledger.csv", index=False)
    path.to_csv(output / "canonical_portfolio_path.csv", index=False)
    (output / "summary.json").write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
