#!/usr/bin/env python3
"""LUNA M1 orthogonal sizing overlay (research-only).

Base portfolio:
    locked M1 S0 K20 REV monthly holdings.

Auxiliary signal:
    AUX = 0.50*rank(MOM3) + 0.30*rank(52W_HIGH_RATIO)
          - 0.20*rank(VOL20)

To avoid double-counting M1's existing alpha, AUX is residualized against
M1 selection_score separately within each month. The residual rank is used
only to tilt position weights inside the exact M1 20-stock basket.

Frozen production-research candidate:
    lambda = 1.0
    weight_i = (1 + lambda*z_rank_i) / 20
where z_rank spans [-1,+1]. With lambda=1, weights are 0%..10%, sum=100%.

This module is research-only and must not be used to arm live trading.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


AUX_WEIGHTS = {
    "r_mom3": 0.50,
    "r_high52_ratio": 0.30,
    "r_vol20": -0.20,
}
FROZEN_LAMBDA = 1.0
TOP_K = 20


def geo(x: pd.Series | np.ndarray) -> float:
    s = pd.Series(x, dtype=float).dropna()
    if s.empty or (s <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(s).mean()))


def nw_mean_tstat(x: pd.Series | np.ndarray, max_lag: int = 3) -> float | None:
    s = pd.Series(x, dtype=float).dropna()
    n = len(s)
    if n < 3:
        return None
    a = s.to_numpy()
    mu = a.mean()
    c = a - mu
    lag = min(max_lag, n - 1)
    lrv = float(np.dot(c, c) / n)
    for k in range(1, lag + 1):
        g = float(np.dot(c[k:], c[:-k]) / n)
        lrv += 2.0 * (1.0 - k / (lag + 1.0)) * g
    se = np.sqrt(max(lrv, 0.0) / n)
    return None if se == 0 else float(mu / se)


def drawdown(returns: pd.Series, initial_capital: float = 30000.0) -> dict:
    r = pd.Series(returns, dtype=float).dropna()
    if r.empty:
        return {
            "max_drawdown_pct": None,
            "max_drawdown_baht": None,
            "ending_baht": initial_capital,
        }
    equity = initial_capital * np.cumprod(1.0 + r.to_numpy())
    peak = np.maximum.accumulate(equity)
    dd = equity / peak - 1.0
    i = int(np.argmin(dd))
    return {
        "max_drawdown_pct": float(dd[i]),
        "max_drawdown_baht": float(equity[i] - peak[i]),
        "ending_baht": float(equity[-1]),
    }


def prepare(
    holdings: pd.DataFrame,
    ranked: pd.DataFrame,
    lambda_value: float = FROZEN_LAMBDA,
) -> pd.DataFrame:
    req_h = {"month_end", "symbol", "selection_score", "next_month_return"}
    req_r = {"month_end", "symbol", "r_mom3", "r_high52_ratio", "r_vol20"}
    miss_h = sorted(req_h - set(holdings.columns))
    miss_r = sorted(req_r - set(ranked.columns))
    if miss_h:
        raise SystemExit(f"M1_REQUIRED_COLUMNS_MISSING:{miss_h}")
    if miss_r:
        raise SystemExit(f"AUX_REQUIRED_COLUMNS_MISSING:{miss_r}")

    h = holdings.copy()
    r = ranked.copy()
    h["month_end"] = pd.to_datetime(h["month_end"])
    r["month_end"] = pd.to_datetime(r["month_end"])
    for col in ["selection_score", "next_month_return"]:
        h[col] = pd.to_numeric(h[col], errors="coerce")
    for col in ["r_mom3", "r_high52_ratio", "r_vol20"]:
        r[col] = pd.to_numeric(r[col], errors="coerce")

    x = h.merge(
        r[["month_end", "symbol", "r_mom3", "r_high52_ratio", "r_vol20"]],
        on=["month_end", "symbol"],
        how="left",
        validate="one_to_one",
    )
    if x[["r_mom3", "r_high52_ratio", "r_vol20"]].isna().any().any():
        raise SystemExit("AUX_FACTOR_COVERAGE_FAILURE")

    x["aux"] = (
        AUX_WEIGHTS["r_mom3"] * x["r_mom3"]
        + AUX_WEIGHTS["r_high52_ratio"] * x["r_high52_ratio"]
        + AUX_WEIGHTS["r_vol20"] * x["r_vol20"]
    )
    # Cross-sectional residualization within the exact M1 basket.
    residuals = []
    for month, frame in x.groupby("month_end", sort=True):
        frame = frame.copy()
        score = frame["selection_score"].to_numpy(dtype=float)
        aux = frame["aux"].to_numpy(dtype=float)
        if np.ptp(score) == 0:
            resid = aux - aux.mean()
        else:
            slope, intercept = np.polyfit(score, aux, 1)
            resid = aux - (intercept + slope * score)
        frame["resid"] = resid
        residuals.append(frame)
    x = pd.concat(residuals, ignore_index=True)

    x["resid_rank"] = (
        x.groupby("month_end")["resid"]
        .rank(ascending=False, method="first")
    )
    z_rank = (x["resid_rank"] - (TOP_K + 1) / 2.0) / ((TOP_K - 1) / 2.0)
    x["target_weight"] = (1.0 + lambda_value * z_rank) / TOP_K
    if (x["target_weight"] < -1e-12).any():
        raise SystemExit("NEGATIVE_WEIGHT")
    if not np.allclose(
        x.groupby("month_end")["target_weight"].sum().to_numpy(),
        1.0,
        atol=1e-10,
    ):
        raise SystemExit("WEIGHT_SUM_NOT_ONE")
    return x.sort_values(["month_end", "symbol"]).reset_index(drop=True)


def build_monthly_path(
    prepared: pd.DataFrame,
    cost_bps: float,
    initial_capital: float = 30000.0,
) -> pd.DataFrame:
    months = sorted(prepared["month_end"].unique())
    rows = []
    previous: dict[str, float] = {}
    for month in months:
        frame = prepared[prepared["month_end"] == month]
        current = dict(zip(frame["symbol"], frame["target_weight"]))
        symbols = set(current) | set(previous)
        turnover = 1.0 if not previous else 0.5 * sum(
            abs(current.get(sym, 0.0) - previous.get(sym, 0.0))
            for sym in symbols
        )
        gross = float(np.sum(frame["target_weight"] * frame["next_month_return"]))
        net = gross - turnover * cost_bps / 10000.0
        rows.append(
            {
                "month_end": month,
                "gross_return": gross,
                "turnover": turnover,
                "transaction_cost": turnover * cost_bps / 10000.0,
                "net_return": net,
                "max_weight": float(frame["target_weight"].max()),
                "min_weight": float(frame["target_weight"].min()),
                "ending_weight_sum": float(frame["target_weight"].sum()),
            }
        )
        previous = current

    out = pd.DataFrame(rows)
    if not np.allclose(
        out["gross_return"] - out["transaction_cost"] - out["net_return"],
        0.0,
        atol=1e-12,
    ):
        raise SystemExit("RETURN_COST_RECONCILIATION_FAILED")
    out["equity_baht"] = initial_capital * (1.0 + out["net_return"]).cumprod()
    out["drawdown_pct"] = out["equity_baht"] / out["equity_baht"].cummax() - 1.0
    return out


def summarize(path: pd.DataFrame, initial_capital: float = 30000.0) -> dict:
    if path.empty:
        return {"months": 0}
    r = path["net_return"]
    result = {
        "months": int(len(r)),
        "geometric_monthly_return": geo(r),
        "arithmetic_monthly_return": float(r.mean()),
        "annualized_geometric_return": float((1.0 + geo(r)) ** 12 - 1.0),
        "positive_month_pct": float((r > 0).mean()),
        "hac_t_stat_mean_gt_zero": nw_mean_tstat(r, 3),
        "average_turnover": float(path["turnover"].mean()),
        "average_max_weight": float(path["max_weight"].mean()),
        "max_weight": float(path["max_weight"].max()),
        "min_weight": float(path["min_weight"].min()),
        "worst_month": float(r.min()),
        "best_month": float(r.max()),
    }
    result.update(drawdown(r, initial_capital))
    return result


def cost_stress(path: pd.DataFrame, bps=(20, 40, 60, 100)) -> list[dict]:
    rows = []
    for cost in bps:
        x = path.copy()
        x["net_return"] = x["gross_return"] - x["turnover"] * float(cost) / 10000.0
        rows.append({"cost_bps": int(cost), **summarize(x)})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--m1-holdings", required=True)
    ap.add_argument("--ranked-v2", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lambda-value", type=float, default=FROZEN_LAMBDA)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--initial-capital", type=float, default=30000.0)
    args = ap.parse_args()

    if abs(args.lambda_value - FROZEN_LAMBDA) > 1e-12:
        # This engine is frozen by protocol; alternative lambdas belong in a
        # separate research run and must not silently replace the candidate.
        raise SystemExit("FROZEN_LAMBDA_REQUIRED: use 1.0")

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    prepared = prepare(
        pd.read_csv(args.m1_holdings),
        pd.read_csv(args.ranked_v2),
        lambda_value=args.lambda_value,
    )
    path = build_monthly_path(
        prepared,
        cost_bps=args.cost_bps,
        initial_capital=args.initial_capital,
    )
    result = {
        "status": "RESEARCH_ONLY",
        "engine": "luna-m1-orthogonal-sizer-v1",
        "lambda": args.lambda_value,
        "selection_base": "locked luna-m1s0k20rev-v1",
        "aux_formula": AUX_WEIGHTS,
        "weight_formula": "rank residual within exact M1 basket; lambda=1.0 => 0%..10% long-only weights",
        "initial_capital_baht": args.initial_capital,
        "summary": summarize(path, args.initial_capital),
        "cost_stress": cost_stress(path),
        "data_contract_warning": "The auxiliary rank data currently comes from luna_research_ranked_v2 (924-symbol PIT dataset) while the locked M1 selection pipeline has a distinct score/data contract. Do not promote to paper/live until the auxiliary factors are reproduced from the exact M1 source contract.",
        "promotion_gate": {
            "research": True,
            "paper": False,
            "customer": False,
            "live": False,
        },
    }
    prepared.to_csv(out / "orthogonal_weight_ledger.csv", index=False)
    path.to_csv(out / "orthogonal_portfolio_path.csv", index=False)
    (out / "summary.json").write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
