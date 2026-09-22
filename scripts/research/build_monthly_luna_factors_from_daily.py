#!/usr/bin/env python3
"""Build a monthly LUNA factor dataset from the canonical daily SET factor matrix.

Design:
- Use only end-of-month observations for portfolio formation.
- Momentum factors are computed from adjusted close before the month-end row:
  21, 63, 126 and 252 trading-day lookbacks.
- high52_ratio uses the trailing 252-trading-day high.
- vol20/maxdd60/avg_amount20 use the already point-in-time daily fields
  computed by build_factor_dataset.py.
- The final window is the trailing 5 calendar years of available monthly data.
- No forward return is used to build any factor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from apply_pit_universe import filter_dataframe_by_date


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lookback-years", type=int, default=5)
    ap.add_argument("--membership", default=None)
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    pit_excluded_rows=0
    pit_active_symbols=0
    required = {"date", "symbol", "adj_close", "MOM_20", "VOL_20", "MAXDD_60", "AMOUNT"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["date"] = pd.to_datetime(df["date"], errors="raise")
    df["symbol"] = df["symbol"].astype(str).str.strip().str.upper()
    for c in ["adj_close", "MOM_20", "VOL_20", "MAXDD_60", "AMOUNT"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values(["symbol", "date"]).drop_duplicates(["symbol", "date"])

    g = df.groupby("symbol", group_keys=False)
    px = df["adj_close"]

    # Exact 21-trading-day reversal anchor for the M1 benchmark.
    df["mom1"] = g["adj_close"].pct_change(21)
    df["mom3"] = g["adj_close"].pct_change(63)
    df["mom6"] = g["adj_close"].pct_change(126)
    df["mom12"] = g["adj_close"].pct_change(252)
    df["high52_ratio"] = (
        df["adj_close"]
        / g["adj_close"].rolling(252, min_periods=252).max().reset_index(level=0, drop=True)
    )
    df["vol20"] = df["VOL_20"]
    df["maxdd60"] = df["MAXDD_60"]
    df["avg_amount20"] = df["AMOUNT"]

    df["month"] = df["date"].dt.to_period("M")
    eom = (
        df.sort_values(["symbol", "date"])
        .groupby(["symbol", "month"], as_index=False)
        .tail(1)
        .copy()
    )
    eom["month_end"] = eom["date"].dt.to_period("M").dt.to_timestamp("M")

    cols = [
        "symbol", "month_end", "adj_close",
        "mom1", "mom3", "mom6", "mom12",
        "high52_ratio", "vol20", "maxdd60", "avg_amount20",
    ]
    out = eom[cols].sort_values(["month_end", "symbol"]).reset_index(drop=True)

    if args.membership:
        out["snapshot_date"] = pd.to_datetime(out["month_end"], errors="raise")
        out, pit_excluded_rows, pit_active_symbols = filter_dataframe_by_date(out,args.membership,"snapshot_date")
        out = out.drop(columns=["snapshot_date"])

    max_month = out["month_end"].max()
    min_allowed = max_month - pd.DateOffset(years=args.lookback_years)
    out = out[out["month_end"] >= min_allowed].copy()

    # Contiguity QA is about the formation dataset itself; the tournament
    # applies the forward-return guard separately.
    month_counts = out.groupby("month_end")["symbol"].nunique()
    if month_counts.empty or month_counts.max() < 20:
        raise SystemExit("insufficient monthly universe coverage")

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(out_path, index=False)

    manifest = {
        "status": "COMPLETED",
        "source_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(out_path.read_bytes()).hexdigest(),
        "rows": int(len(out)),
        "symbols": int(out["symbol"].nunique()),
        "min_month": str(out["month_end"].min().date()),
        "max_month": str(out["month_end"].max().date()),
        "lookback_years": args.lookback_years,
        "m1_anchor": "21 trading-day adjusted-close reversal at month-end",
        "monthly_factor_definitions": {
            "mom1": "21 trading-day adjusted-close return",
            "mom3": "63 trading-day adjusted-close return",
            "mom6": "126 trading-day adjusted-close return",
            "mom12": "252 trading-day adjusted-close return",
            "high52_ratio": "adjusted close / trailing 252-trading-day high",
            "vol20": "daily VOL_20 at month-end",
            "maxdd60": "daily MAXDD_60 at month-end",
            "avg_amount20": "daily AMOUNT (20-day average traded value) at month-end",
        },
        "no_forward_data_in_factors": True,
        "pit_membership": args.membership,
        "pit_excluded_rows": int(pit_excluded_rows),
        "pit_active_symbols": int(pit_active_symbols),
    }
    out_path.with_suffix(".manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
