#!/usr/bin/env python3
"""Build a point-in-time monthly factor table from daily OHLCV data.

Designed as a research fallback when the Supabase service-role secret is not
available. It computes all technical factors using only data available on or
before each month-end, then keeps the last trading observation per symbol/month.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import numpy as np
import pandas as pd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    p = pd.read_csv(args.input)
    required = {"date", "symbol", "close", "volume"}
    if not required.issubset(p.columns):
        raise SystemExit(f"prices missing: {sorted(required - set(p.columns))}")

    p["date"] = pd.to_datetime(p["date"], errors="raise")
    p["symbol"] = p["symbol"].astype(str).str.strip().str.upper()
    for c in ["open", "high", "low", "close", "volume", "adj_close", "amount"]:
        if c in p.columns:
            p[c] = pd.to_numeric(p[c], errors="coerce")

    px = "adj_close" if "adj_close" in p.columns and p["adj_close"].notna().any() else "close"
    p[px] = p[px].where(p[px] > 0)
    input_rows = len(p)
    missing_price_rows = int(p[px].isna().sum())
    # Do not forward-fill no-observation rows: they are not trading bars and
    # must not create artificial zero returns or shift month-end selection.
    p = p[p[px].notna()].copy()
    if "amount" not in p.columns:
        p["amount"] = p["close"] * p["volume"]

    p = p.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = p.groupby("symbol", group_keys=False)
    ret = g[px].pct_change(fill_method=None)

    p["mom1"] = g[px].pct_change(21, fill_method=None)
    p["mom3"] = g[px].pct_change(63, fill_method=None)
    p["mom6"] = g[px].pct_change(126, fill_method=None)
    p["mom12"] = g[px].pct_change(252, fill_method=None)
    p["high52_ratio"] = p[px] / g[px].rolling(252, min_periods=252).max().reset_index(level=0, drop=True)
    p["vol20"] = ret.groupby(p["symbol"]).rolling(20, min_periods=20).std().reset_index(level=0, drop=True)
    p["maxdd60"] = p[px] / g[px].rolling(60, min_periods=60).max().reset_index(level=0, drop=True) - 1.0
    p["avg_amount20"] = g["amount"].rolling(20, min_periods=20).mean().reset_index(level=0, drop=True)

    p["month_end"] = p["date"].dt.to_period("M").dt.to_timestamp("M")
    month_end = (
        p.sort_values(["symbol", "date"])
         .groupby(["symbol", "month_end"], as_index=False)
         .tail(1)
    )

    cols = [
        "symbol", "month_end", px, "mom1", "mom3", "mom6", "mom12",
        "high52_ratio", "vol20", "maxdd60", "avg_amount20",
    ]
    out = month_end[cols].rename(columns={px: "adj_close"})
    out = out.replace([np.inf, -np.inf], np.nan).sort_values(["month_end", "symbol"])
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)

    manifest = {
        "rows": int(len(out)),
        "symbols": int(out["symbol"].nunique()),
        "start": str(out["month_end"].min().date()),
        "end": str(out["month_end"].max().date()),
        "input_rows": int(input_rows),
        "excluded_missing_or_nonpositive_price_rows": int(missing_price_rows),
        "ohlc_valid_rows": int(p["ohlc_valid"].fillna(False).sum()) if "ohlc_valid" in p.columns else None,
        "source": sorted(p["source"].dropna().astype(str).unique().tolist()) if "source" in p.columns else None,
        "availability_policy": "consume available_at from luna_research_prices_pit_v1; daily bars available after 17:05 Asia/Bangkok",
        "output": str(args.output),
        "factor_definition": "21/63/126/252 valid trading-observation momentum, 252D high, 20D vol, 60D drawdown proxy, 20D avg amount",
        "missing_policy": "No forward fill; exclude rows without positive adjusted close before factor calculation and month-end selection",
    }
    Path(args.output).with_suffix(".manifest.json").write_text(
        __import__("json").dumps(manifest, indent=2),
        encoding="utf-8",
    )
    print(manifest)


if __name__ == "__main__":
    main()
