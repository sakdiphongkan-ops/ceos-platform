#!/usr/bin/env python3
"""LUNA-HYBRID-R1: 50/50 reversal + regime-aware ranking research engine.

Research candidate only. It is intentionally deterministic and leakage-safe:
- current-month cross-sectional ranks only;
- regime z-score uses the previous 12 completed months only;
- forward return is valid only when the next observation is the next calendar month;
- no holdout month is used for parameter selection.

The intended primary configuration is K=20 and 20 bps one-way turnover cost.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

FACTORS = ["mom1", "mom6", "high52_ratio", "vol20"]


def geo(x: pd.Series) -> float:
    x = pd.to_numeric(x, errors="coerce").dropna().to_numpy(dtype=float)
    if len(x) == 0 or np.any(x <= -1):
        return -1.0
    return float(np.exp(np.log1p(x).mean()) - 1.0)


def stats(x: pd.Series) -> dict:
    x = pd.to_numeric(x, errors="coerce").dropna().astype(float)
    if x.empty:
        return {
            "months": 0,
            "geometric_monthly_return": -1.0,
            "cumulative_return": -1.0,
            "positive_month_pct": 0.0,
            "worst_month": None,
            "best_month": None,
            "max_drawdown": None,
        }
    eq = 30000.0 * np.cumprod(1.0 + x.to_numpy())
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1.0
    return {
        "months": int(len(x)),
        "geometric_monthly_return": geo(x),
        "cumulative_return": float(eq[-1] / 30000.0 - 1.0),
        "positive_month_pct": float((x > 0).mean()),
        "worst_month": float(x.min()),
        "best_month": float(x.max()),
        "max_drawdown": float(dd.min()),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.input)
    required = {"symbol", "month_end", "adj_close", *FACTORS}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["month_end"] = pd.to_datetime(df["month_end"]).dt.to_period("M").dt.to_timestamp("M")
    df = df.sort_values(["symbol", "month_end"]).drop_duplicates(["symbol", "month_end"]).reset_index(drop=True)
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    for f in FACTORS:
        df[f] = pd.to_numeric(df[f], errors="coerce")

    df["next_month"] = df.groupby("symbol")["month_end"].shift(-1)
    df["next_close"] = df.groupby("symbol")["adj_close"].shift(-1)
    expected = df["month_end"] + pd.offsets.MonthEnd(1)
    df["fwd1"] = np.where(
        df["next_month"].eq(expected),
        df["next_close"] / df["adj_close"] - 1.0,
        np.nan,
    )
    df = df.drop(columns=["next_month", "next_close"])

    # Current-month cross-sectional ranks.
    df["r_mom1"] = df.groupby("month_end")["mom1"].rank(pct=True, method="average")
    df["r_mom6"] = df.groupby("month_end")["mom6"].rank(pct=True, method="average")
    df["r_high52"] = df.groupby("month_end")["high52_ratio"].rank(pct=True, method="average")
    df["r_vol20"] = df.groupby("month_end")["vol20"].rank(pct=True, method="average")

    # Market breadth and regime: only prior 12 completed months enter the z-score.
    breadth = (
        df.groupby("month_end")
        .agg(
            breadth1=("mom1", lambda s: float((s > 0).mean())),
            breadth6=("mom6", lambda s: float((s > 0).mean())),
        )
        .sort_index()
    )
    breadth["b1_mean"] = breadth["breadth1"].shift(1).rolling(12, min_periods=12).mean()
    breadth["b1_std"] = breadth["breadth1"].shift(1).rolling(12, min_periods=12).std()
    breadth["b6_mean"] = breadth["breadth6"].shift(1).rolling(12, min_periods=12).mean()
    breadth["b6_std"] = breadth["breadth6"].shift(1).rolling(12, min_periods=12).std()
    breadth["regime_z"] = (
        0.5 * (breadth["breadth1"] - breadth["b1_mean"]) / breadth["b1_std"]
        + 0.5 * (breadth["breadth6"] - breadth["b6_mean"]) / breadth["b6_std"]
    )
    breadth["regime"] = np.select(
        [breadth["regime_z"] >= 0.5, breadth["regime_z"] <= -0.5],
        ["ON", "OFF"],
        default="NEUTRAL",
    )

    df = df.merge(breadth[["regime_z", "regime"]], left_on="month_end", right_index=True, how="left")

    trend_score = 0.55 * df["r_high52"] + 0.30 * df["r_mom6"] + 0.15 * (1.0 - df["r_vol20"])
    neutral_score = (
        0.50 * (1.0 - df["r_mom1"])
        + 0.30 * df["r_high52"]
        + 0.20 * (1.0 - df["r_vol20"])
    )
    reversal_score = 1.0 - df["r_mom1"]

    regime_score = np.select(
        [df["regime"].eq("ON"), df["regime"].eq("OFF")],
        [trend_score, reversal_score],
        default=neutral_score,
    )

    # Fixed 50/50 structural blend. This is not fitted to the holdout.
    df["score"] = 0.50 * reversal_score + 0.50 * regime_score

    # Only rows with usable score and forward return are tradable.
    df = df.dropna(subset=["score", "fwd1"]).copy()

    selected = (
        df.sort_values(["month_end", "score", "symbol"], ascending=[True, False, True])
        .groupby("month_end", sort=True)
        .head(args.k)
        .copy()
    )

    monthly = (
        selected.groupby("month_end", sort=True)
        .agg(
            gross_return=("fwd1", "mean"),
            holdings=("symbol", lambda s: tuple(sorted(s))),
        )
        .reset_index()
    )

    monthly["prev_holdings"] = monthly["holdings"].shift(1)
    monthly["turnover"] = np.where(
        monthly["prev_holdings"].isna(),
        1.0,
        monthly.apply(
            lambda r: 1.0 - len(set(r["holdings"]) & set(r["prev_holdings"])) / float(args.k),
            axis=1,
        ),
    )
    monthly["transaction_cost"] = monthly["turnover"] * args.cost_bps / 10000.0
    monthly["net_return"] = monthly["gross_return"] - monthly["transaction_cost"]

    # Frozen evaluation windows. 2026 is confirmation only.
    monthly["period"] = np.select(
        [
            monthly["month_end"].between("2021-10-01", "2024-12-31"),
            monthly["month_end"].between("2025-01-01", "2025-12-31"),
            monthly["month_end"].between("2026-01-01", "2026-07-31"),
        ],
        ["TRAIN", "DEV", "HOLDOUT"],
        default="OTHER",
    )

    summary = {
        "status": "COMPLETED",
        "engine": "luna-hybrid-regime-blend-v1",
        "candidate": "0.50*M1_REV1 + 0.50*REGIME_A",
        "k": args.k,
        "cost_bps": args.cost_bps,
        "regime_definition": "0.5*z(breadth1)+0.5*z(breadth6), each z against prior 12 completed months only; threshold +/-0.5",
        "formula": {
            "reversal": "1-rank(mom1)",
            "ON": "0.55*rank(high52_ratio)+0.30*rank(mom6)+0.15*(1-rank(vol20))",
            "OFF": "1-rank(mom1)",
            "NEUTRAL": "0.50*(1-rank(mom1))+0.30*rank(high52_ratio)+0.20*(1-rank(vol20))",
            "final": "0.50*reversal+0.50*regime_score",
        },
        "no_lookahead": True,
        "data_contiguity_guard": True,
        "windows": {
            name: stats(monthly.loc[monthly["period"].eq(name), "net_return"])
            for name in ["TRAIN", "DEV", "HOLDOUT"]
        },
    }

    monthly.to_csv(out / "monthly_ledger.csv", index=False)
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
