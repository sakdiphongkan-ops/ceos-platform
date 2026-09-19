#!/usr/bin/env python3
"""Leakage-safe monthly walk-forward adaptive selector for LUNA.

This module is intentionally a research scaffold: it consumes a prepared monthly
factor CSV and re-selects a candidate using only observations strictly before the
month being traded. It writes an auditable selection ledger and return series.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

FACTORS = ["mom1", "mom3", "mom6", "mom12", "high52_ratio", "vol20", "maxdd60", "avg_amount20"]


def geo(x: pd.Series) -> float:
    x = pd.to_numeric(x, errors="coerce").dropna()
    if len(x) == 0 or (x <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(x).mean()))


def score(df: pd.DataFrame, factor: str, direction: str) -> pd.Series:
    r = df.groupby("month_end")[factor].rank(pct=True, method="average")
    return r if direction == "HIGH" else 1.0 - r


def candidate_return(df: pd.DataFrame, factor: str, direction: str, k: int, cost: float) -> pd.Series:
    x = df[["symbol", "month_end", "fwd1", factor]].copy()
    x["score"] = score(x, factor, direction)
    x = x.dropna(subset=["score", "fwd1"])
    x = x.sort_values(["month_end", "score", "symbol"], ascending=[True, False, True])
    return x.groupby("month_end", sort=True).head(k).groupby("month_end")["fwd1"].mean() - cost


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lookback-months", type=int, default=24)
    ap.add_argument("--min-history-months", type=int, default=12)
    ap.add_argument("--cost-bps", type=float, default=40.0)
    ap.add_argument("--k-values", default="5,10,20")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    raw = pd.read_csv(args.input)
    required = {"symbol", "month_end", "adj_close", *FACTORS}
    missing = sorted(required - set(raw.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")
    df = raw.copy()
    df["month_end"] = pd.to_datetime(df["month_end"]).dt.to_period("M").dt.to_timestamp("M")
    df = df.sort_values(["symbol", "month_end"]).drop_duplicates(["symbol", "month_end"])
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    df["fwd1"] = df.groupby("symbol")["adj_close"].shift(-1) / df["adj_close"] - 1.0
    for f in FACTORS:
        df[f] = pd.to_numeric(df[f], errors="coerce")

    configs = [(f, d, int(k)) for f in FACTORS for d in ("HIGH", "LOW") for k in args.k_values.split(",")]
    returns = {(f, d, k): candidate_return(df, f, d, k, args.cost_bps / 10000.0) for f, d, k in configs}
    months = sorted(set().union(*(s.index for s in returns.values())))
    rows = []
    for i, month in enumerate(months):
        prior = [m for m in months if m < month][-args.lookback_months:]
        if len(prior) < args.min_history_months:
            continue
        eligible = []
        for cfg, series in returns.items():
            hist = series.reindex(prior).dropna()
            if len(hist) < args.min_history_months:
                continue
            eligible.append((geo(hist), float((hist > 0).mean()), cfg))
        if not eligible:
            continue
        eligible.sort(key=lambda z: (-z[0], -z[1], str(z[2])))
        chosen = eligible[0]
        realized = returns[chosen[2]].get(month, np.nan)
        rows.append({
            "month_end": month,
            "history_start": prior[0],
            "history_end": prior[-1],
            "selected_geo": chosen[0],
            "selected_positive": chosen[1],
            "factor": chosen[2][0],
            "direction": chosen[2][1],
            "k": chosen[2][2],
            "realized_return": realized,
        })

    ledger = pd.DataFrame(rows)
    ledger.to_csv(out / "adaptive_selection_ledger.csv", index=False)
    result = ledger["realized_return"].dropna() if not ledger.empty else pd.Series(dtype=float)
    summary = {
        "status": "COMPLETED",
        "engine": "luna-monthly-walk-forward-adaptive-v1",
        "dataset_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "months_traded": int(len(result)),
        "geometric_monthly_return": geo(result),
        "cumulative_return": float((1.0 + result).prod() - 1.0) if len(result) else -1.0,
        "lookback_months": args.lookback_months,
        "min_history_months": args.min_history_months,
        "cost_bps": args.cost_bps,
        "selection_rule": "select by trailing geometric return, then positive-month ratio, using strictly prior months only",
        "leakage_guard": "candidate return for traded month is never included in its selection history",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
