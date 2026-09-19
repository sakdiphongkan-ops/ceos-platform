#!/usr/bin/env python3
"""Reconcile raw-close and adjusted-close forward returns.

The purpose is diagnostic only: extreme adjusted jumps are not clipped or
silently removed. The report shows whether the jump is also present in raw
close or is driven primarily by the adjustment series.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--extremes-output", required=True)
    ap.add_argument("--threshold", type=float, default=0.20)
    args = ap.parse_args()

    cols = ["date", "symbol", "close", "adj_close"]
    df = pd.read_csv(args.input, usecols=cols)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    df = df.dropna(subset=["date", "symbol", "close", "adj_close"])
    df = df[(df["close"] > 0) & (df["adj_close"] > 0)]
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)

    g = df.groupby("symbol", group_keys=False)
    df["raw_fwd_1d"] = g["close"].shift(-1) / df["close"] - 1.0
    df["adj_fwd_1d"] = g["adj_close"].shift(-1) / df["adj_close"] - 1.0
    df["adj_factor"] = df["adj_close"] / df["close"]
    df["next_adj_factor"] = g["adj_factor"].shift(-1)
    df["adj_factor_change"] = df["next_adj_factor"] / df["adj_factor"] - 1.0

    extreme = df[df["adj_fwd_1d"].abs() > args.threshold].copy()
    extreme["abs_adj_return"] = extreme["adj_fwd_1d"].abs()
    extreme["abs_raw_return"] = extreme["raw_fwd_1d"].abs()
    extreme["adjustment_driven"] = extreme["abs_raw_return"] <= args.threshold
    extreme = extreme.sort_values("abs_adj_return", ascending=False).head(500)

    Path(args.extremes_output).parent.mkdir(parents=True, exist_ok=True)
    extreme.to_csv(args.extremes_output, index=False)

    valid = df["adj_fwd_1d"].notna()
    adj = df.loc[valid, "adj_fwd_1d"]
    raw = df.loc[valid, "raw_fwd_1d"]
    factor_change = df["adj_factor_change"].dropna()

    out = {
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "adjusted_forward_rows": int(adj.size),
        "raw_forward_rows": int(raw.size),
        "threshold": args.threshold,
        "adjusted_abs_gt_threshold": int((adj.abs() > args.threshold).sum()),
        "raw_abs_gt_threshold": int((raw.abs() > args.threshold).sum()),
        "adjusted_extremes_where_raw_is_not_extreme": int(
            ((adj.abs() > args.threshold) & (raw.abs() <= args.threshold)).sum()
        ),
        "adjusted_abs_gt_50pct": int((adj.abs() > 0.50).sum()),
        "adjusted_abs_gt_100pct": int((adj.abs() > 1.00).sum()),
        "adjustment_factor_change_abs_gt_10pct": int((factor_change.abs() > 0.10).sum()),
        "adjustment_factor_change_abs_gt_50pct": int((factor_change.abs() > 0.50).sum()),
        "max_adjusted_return": float(adj.max()) if len(adj) else None,
        "min_adjusted_return": float(adj.min()) if len(adj) else None,
        "max_raw_return": float(raw.max()) if len(raw) else None,
        "min_raw_return": float(raw.min()) if len(raw) else None,
        "extreme_rows_written": int(len(extreme)),
        "note": "Adjustment-driven extremes require corporate-action reconciliation before being trusted in a backtest.",
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
