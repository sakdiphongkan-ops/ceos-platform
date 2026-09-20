#!/usr/bin/env python3
"""LUNA-HYBRID-R2: continuous-regime 50/50 reversal blend.

Research candidate only. The regime weight is a sigmoid of a breadth z-score,
which removes the hard ON/OFF discontinuity used in R1.

Primary candidate:
  K=20, cost=20 bps, regime_scale=0.5

The scale is selected from TRAIN/DEV candidates only; HOLDOUT is untouched.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def geo(x: pd.Series) -> float:
    x = pd.to_numeric(x, errors="coerce").dropna().to_numpy(dtype=float)
    if len(x) == 0 or np.any(x <= -1):
        return -1.0
    return float(np.exp(np.log1p(x).mean()) - 1.0)


def metrics(x: pd.Series) -> dict:
    x = pd.to_numeric(x, errors="coerce").dropna().astype(float)
    if x.empty:
        return {"months": 0, "geo_monthly": -1.0, "cumulative": -1.0,
                "positive_month_pct": 0.0, "worst_month": None,
                "best_month": None, "max_drawdown": None}
    eq = 30000.0 * np.cumprod(1.0 + x.to_numpy())
    peak = np.maximum.accumulate(eq)
    return {
        "months": int(len(x)),
        "geo_monthly": geo(x),
        "cumulative": float(eq[-1] / 30000.0 - 1.0),
        "positive_month_pct": float((x > 0).mean()),
        "worst_month": float(x.min()),
        "best_month": float(x.max()),
        "max_drawdown": float(np.min(eq / peak - 1.0)),
    }


def score_frame(df: pd.DataFrame, scale: float) -> pd.DataFrame:
    d = df.copy()
    d["r1"] = d.groupby("month_end")["mom1"].rank(pct=True, method="average")
    d["r6"] = d.groupby("month_end")["mom6"].rank(pct=True, method="average")
    d["rh"] = d.groupby("month_end")["high52_ratio"].rank(pct=True, method="average")
    d["rv"] = d.groupby("month_end")["vol20"].rank(pct=True, method="average")
    breadth = (
        d.groupby("month_end")
        .agg(b1=("mom1", lambda s: float((s > 0).mean())),
             b6=("mom6", lambda s: float((s > 0).mean())))
        .sort_index()
    )
    for col in ("b1", "b6"):
        breadth[f"{col}_m"] = breadth[col].shift(1).rolling(12, min_periods=12).mean()
        breadth[f"{col}_s"] = breadth[col].shift(1).rolling(12, min_periods=12).std()
    breadth["z"] = (
        0.5 * (breadth["b1"] - breadth["b1_m"]) / breadth["b1_s"]
        + 0.5 * (breadth["b6"] - breadth["b6_m"]) / breadth["b6_s"]
    )
    d = d.join(breadth["z"].rename("regime_z"), on="month_end")
    alpha = 1.0 / (1.0 + np.exp(-d["regime_z"].fillna(0.0) / float(scale)))
    reversal = 1.0 - d["r1"]
    trend = 0.55 * d["rh"] + 0.30 * d["r6"] + 0.15 * (1.0 - d["rv"])
    d["score"] = 0.50 * reversal + 0.50 * (alpha * trend + (1.0 - alpha) * reversal)
    return d


def run(df: pd.DataFrame, scale: float, k: int, cost_bps: float) -> pd.DataFrame:
    d = score_frame(df, scale)
    d = d.dropna(subset=["fwd1", "score"])
    selected = (
        d.sort_values(["month_end", "score", "symbol"], ascending=[True, False, True])
        .groupby("month_end", sort=True)
        .head(k)
    )
    m = selected.groupby("month_end").agg(
        gross_return=("fwd1", "mean"),
        holdings=("symbol", lambda s: tuple(sorted(s))),
    ).reset_index()
    m["prev_holdings"] = m["holdings"].shift(1)
    m["turnover"] = np.where(
        m["prev_holdings"].isna(),
        1.0,
        m.apply(
            lambda r: 1.0 - len(set(r["holdings"]) & set(r["prev_holdings"])) / float(k),
            axis=1,
        ),
    )
    m["net_return"] = m["gross_return"] - m["turnover"] * cost_bps / 10000.0
    m["period"] = np.select(
        [
            m["month_end"].between("2021-10-01", "2024-12-31"),
            m["month_end"].between("2025-01-01", "2025-12-31"),
            m["month_end"].between("2026-01-01", "2026-07-31"),
        ],
        ["TRAIN", "DEV", "HOLDOUT"],
        default="OTHER",
    )
    return m


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--scales", default="0.5,0.75,1.0,1.5,2.0")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(args.input)
    required = {"symbol", "month_end", "adj_close", "mom1", "mom6", "high52_ratio", "vol20"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["month_end"] = pd.to_datetime(df["month_end"]).dt.to_period("M").dt.to_timestamp("M")
    df = df.sort_values(["symbol", "month_end"]).drop_duplicates(["symbol", "month_end"]).reset_index(drop=True)
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    for f in ["mom1", "mom6", "high52_ratio", "vol20"]:
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

    scales = [float(x) for x in args.scales.split(",") if x.strip()]
    rows = []
    ledgers = {}
    for scale in scales:
        ledger = run(df, scale, args.k, args.cost_bps)
        ledgers[str(scale)] = ledger
        for period in ("TRAIN", "DEV", "HOLDOUT"):
            row = {"scale": scale, "period": period, **metrics(ledger.loc[ledger.period.eq(period), "net_return"])}
            rows.append(row)

    results = pd.DataFrame(rows)
    dev = results[results.period.eq("DEV")].sort_values(
        ["geo_monthly", "positive_month_pct"], ascending=[False, False]
    )
    selected_scale = float(dev.iloc[0]["scale"])
    hold = results[(results.period.eq("HOLDOUT")) & (results.scale.eq(selected_scale))].iloc[0].to_dict()

    summary = {
        "status": "COMPLETED",
        "engine": "luna-hybrid-regime-blend-v2",
        "selection_rule": "select regime scale on DEV geometric monthly return only; HOLDOUT excluded",
        "selected_scale": selected_scale,
        "primary_k": args.k,
        "cost_bps": args.cost_bps,
        "selected_dev": dev.iloc[0].to_dict(),
        "selected_holdout": hold,
    }
    results.to_csv(out / "scale_results.csv", index=False)
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
