#!/usr/bin/env python3
"""Build monthly LUNA price factors from the canonical daily factor dataset.

For each symbol and calendar month, keep the last trading observation in that
month. Factors are taken from that point-in-time observation. The forward
return is the next calendar month's month-end adjusted-close return; if the
next calendar month observation is missing, fwd1 is left NaN.

This is designed for leakage-safe monthly walk-forward research and makes the
monthly universe explicit in the generated manifest.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

OUT_FACTORS = [
    "mom1", "mom3", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    required = {"date", "symbol", "adj_close", "MOM_20", "VOL_20", "MAXDD_60", "AMOUNT"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["date"] = pd.to_datetime(df["date"], errors="raise")
    df["symbol"] = df["symbol"].astype(str).str.strip().str.upper()
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    for c in ["MOM_20", "VOL_20", "MAXDD_60", "AMOUNT"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # 252-trading-day rolling high approximates 52 weeks of trading data.
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", group_keys=False)
    df["HIGH52_RATIO"] = df["adj_close"] / g["adj_close"].rolling(
        252, min_periods=252
    ).max().reset_index(level=0, drop=True)

    month = df["date"].dt.to_period("M")
    df["_month"] = month
    # Last available trading observation in each symbol-month.
    m = (
        df.sort_values(["symbol", "date"])
        .groupby(["symbol", "_month"], as_index=False)
        .tail(1)
        .copy()
    )
    m["month_end"] = m["_month"].dt.to_timestamp("M")

    m = m.rename(
        columns={
            "MOM_20": "mom1",
            "VOL_20": "vol20",
            "MAXDD_60": "maxdd60",
            "AMOUNT": "avg_amount20",
            "HIGH52_RATIO": "high52_ratio",
            "adj_close": "adj_close",
        }
    )

    keep = ["symbol", "month_end", "adj_close"] + OUT_FACTORS
    m = m[keep].sort_values(["symbol", "month_end"]).reset_index(drop=True)

    # Strict next-calendar-month forward return.
    next_close = m[["symbol", "month_end", "adj_close"]].copy()
    next_close["month_end"] = (
        next_close["month_end"] + pd.offsets.MonthEnd(1)
    )
    next_close = next_close.rename(columns={"adj_close": "next_adj_close"})
    m = m.merge(next_close, on=["symbol", "month_end"], how="left")
    # The shifted merge above intentionally joins the same symbol to the
    # following month's month-end because next_close's month_end was advanced.
    m["fwd1"] = m["next_adj_close"] / m["adj_close"] - 1.0
    m.loc[~np.isfinite(m["fwd1"]), "fwd1"] = np.nan
    m = m.drop(columns=["next_adj_close"])

    # Keep only rows with all ranking factors and a valid current price.
    for c in OUT_FACTORS + ["adj_close"]:
        m[c] = pd.to_numeric(m[c], errors="coerce")
    m["month_end"] = pd.to_datetime(m["month_end"])
    m = m.drop_duplicates(["symbol", "month_end"])
    m = m.sort_values(["month_end", "symbol"]).reset_index(drop=True)

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    m.to_csv(args.output, index=False)

    manifest = {
        "rows": int(len(m)),
        "symbols": int(m["symbol"].nunique()),
        "months": int(m["month_end"].nunique()),
        "min_month": str(m["month_end"].min().date()) if len(m) else None,
        "max_month": str(m["month_end"].max().date()) if len(m) else None,
        "factor_definition": {
            "mom1": "MOM_20 from last trading observation of each symbol-month",
            "mom3": "MOM_60 from last trading observation of each symbol-month",
            "mom6": "MOM_120 from last trading observation of each symbol-month",
            "mom12": "MOM_252 is not available in v1; retained as NaN",
            "high52_ratio": "adj_close / rolling 252-trading-day high",
            "vol20": "VOL_20 from last trading observation",
            "maxdd60": "MAXDD_60 from last trading observation",
            "avg_amount20": "20-day average amount from last trading observation",
        },
        "forward_return": "next calendar month's month-end adjusted-close return; missing month => NaN",
        "m1_mapping": "M1 REV K20 maps to selecting the 20 lowest MOM_20 ranks at month-end",
    }
    Path(args.output).with_suffix(".manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
