#!/usr/bin/env python3
"""Build LUNA monthly price-factor dataset from daily SET/mai prices.

The month-end row is the last available trading observation for each symbol.
Forward one-month return is taken from the next calendar month's month-end
observation only; missing months are treated as missing, not as multi-month
returns.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from apply_pit_universe import filter_dataframe_by_date


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", default=None)
    ap.add_argument("--end", default=None)
    ap.add_argument("--membership", default=None)
    args = ap.parse_args()

    p = pd.read_csv(args.prices)
    pit_excluded_rows=0
    pit_active_symbols=0
    required = {"date", "symbol", "close", "volume"}
    missing = sorted(required - set(p.columns))
    if missing:
        raise SystemExit(f"prices missing {missing}")

    p["date"] = pd.to_datetime(p["date"], errors="raise")
    p["symbol"] = p["symbol"].astype(str).str.strip().str.upper()
    for c in ["open", "high", "low", "close", "volume", "adj_close", "amount"]:
        if c in p.columns:
            p[c] = pd.to_numeric(p[c], errors="coerce")

    px = "adj_close" if "adj_close" in p.columns and p["adj_close"].notna().any() else "close"
    p[px] = p[px].where(p[px].gt(0))
    if "amount" not in p.columns:
        p["amount"] = p["close"] * p["volume"]

    p = p.sort_values(["symbol", "date"]).drop_duplicates(["symbol", "date"])
    if args.start:
        p = p[p["date"] >= pd.Timestamp(args.start)]
    if args.end:
        p = p[p["date"] <= pd.Timestamp(args.end)]

    g = p.groupby("symbol", group_keys=False)
    p["mom1"] = g[px].pct_change(21)
    p["mom3"] = g[px].pct_change(63)
    p["mom6"] = g[px].pct_change(126)
    p["mom12"] = g[px].pct_change(252)

    rolling_high_252 = g[px].rolling(252, min_periods=252).max().reset_index(level=0, drop=True)
    p["high52_ratio"] = p[px] / rolling_high_252

    daily_ret = g[px].pct_change()
    p["vol20"] = (
        daily_ret.groupby(p["symbol"])
        .rolling(20, min_periods=20)
        .std()
        .reset_index(level=0, drop=True)
    )

    rolling_high_60 = g[px].rolling(60, min_periods=60).max().reset_index(level=0, drop=True)
    p["maxdd60"] = p[px] / rolling_high_60 - 1.0
    p["avg_amount20"] = (
        p.groupby("symbol")["amount"]
        .rolling(20, min_periods=20)
        .mean()
        .reset_index(level=0, drop=True)
    )

    p["month"] = p["date"].dt.to_period("M")
    month_end = (
        p.sort_values(["symbol", "date"])
        .groupby(["symbol", "month"], as_index=False)
        .tail(1)
        .copy()
    )
    month_end["month_end"] = month_end["date"].dt.to_period("M").dt.to_timestamp("M")

    cols = [
        "symbol", "month_end", px, "mom1", "mom3", "mom6", "mom12",
        "high52_ratio", "vol20", "maxdd60", "avg_amount20",
    ]
    out = month_end[cols].rename(columns={px: "adj_close"}).copy()

    if args.membership:
        out["snapshot_date"] = out["month_end"]
        out, pit_excluded_rows, pit_active_symbols = filter_dataframe_by_date(out,args.membership,"snapshot_date")
        out = out.drop(columns=["snapshot_date"])

    # Strictly require a complete next calendar month.
    next_month = out[["symbol", "month_end", "adj_close"]].copy()
    next_month["month_end"] = (
        next_month["month_end"] - pd.offsets.MonthEnd(1)
    )
    next_month = next_month.rename(columns={"adj_close": "next_adj_close"})
    out = out.merge(next_month, on=["symbol", "month_end"], how="left")
    out["fwd1"] = out["next_adj_close"] / out["adj_close"] - 1.0
    out = out.drop(columns=["next_adj_close"])

    out = out.replace([np.inf, -np.inf], np.nan)
    out = out.sort_values(["month_end", "symbol"]).reset_index(drop=True)

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)

    manifest = {
        "rows": int(len(out)),
        "symbols": int(out["symbol"].nunique()),
        "start": str(out["month_end"].min().date()),
        "end": str(out["month_end"].max().date()),
        "source_price_column": px,
        "month_end_definition": "last available trading observation per symbol per calendar month",
        "forward_return_definition": "next calendar month-end only; missing month => NaN",
        "pit_membership": args.membership,
        "pit_excluded_rows": int(pit_excluded_rows),
        "pit_active_symbols": int(pit_active_symbols),
    }
    Path(args.output).with_suffix(".manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
