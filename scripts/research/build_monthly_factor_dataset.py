#!/usr/bin/env python3
"""Build the monthly factor panel used by LUNA Adaptive Tournament v2.

The snapshot for each symbol/month is the last available trading day.
All inputs are point-in-time daily factors. The downstream tournament computes
the one-month forward return only when the next calendar month exists.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
from apply_pit_universe import filter_dataframe_by_date

FACTORS = [
    "mom1", "mom2", "mom3", "mom4", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]

SOURCE_MAP = {
    "mom1": "MOM_20",
    "mom2": "MOM_40",
    "mom3": "MOM_60",
    "mom4": "MOM_80",
    "mom6": "MOM_120",
    "mom12": "MOM_252",
    "vol20": "VOL_20",
    "maxdd60": "MAXDD_60",
    "avg_amount20": "AMOUNT",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--membership", default=os.getenv("LUNA_PIT_UNIVERSE_MEMBERSHIP"))
    args = ap.parse_args()
    if not args.membership:
        raise SystemExit("PIT_UNIVERSE_MEMBERSHIP_REQUIRED")

    df = pd.read_csv(args.input)
    required = {"date", "symbol", "adj_close", "DIST_HIGH_252", *SOURCE_MAP.values()}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["date"] = pd.to_datetime(df["date"], errors="raise")
    df, pit_excluded_rows, pit_active_symbols = filter_dataframe_by_date(
        df, args.membership, "date"
    )
    df["symbol"] = df["symbol"].astype(str).str.strip().str.upper()
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    for c in SOURCE_MAP.values():
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["DIST_HIGH_252"] = pd.to_numeric(df["DIST_HIGH_252"], errors="coerce")

    df["month_end"] = df["date"].dt.to_period("M").dt.to_timestamp("M")
    df = df.dropna(subset=["symbol", "adj_close"])
    idx = df.groupby(["symbol", "month_end"])["date"].idxmax()
    m = df.loc[idx].copy().sort_values(["month_end", "symbol"]).reset_index(drop=True)

    out = pd.DataFrame({
        "symbol": m["symbol"],
        "snapshot_date": m["date"],
        "month_end": m["month_end"],
        "adj_close": m["adj_close"],
    })
    for dst, src in SOURCE_MAP.items():
        out[dst] = m[src]
    out["high52_ratio"] = 1.0 + m["DIST_HIGH_252"]

    out["_next_month"] = out.groupby("symbol")["month_end"].shift(-1)
    out["_next_adj_close"] = out.groupby("symbol")["adj_close"].shift(-1)
    expected = out["month_end"] + pd.offsets.MonthEnd(1)
    out["fwd1"] = np.where(
        out["_next_month"].eq(expected),
        out["_next_adj_close"] / out["adj_close"] - 1.0,
        np.nan,
    )
    out = out.drop(columns=["_next_month", "_next_adj_close"])

    out = (
        out.replace([np.inf, -np.inf], np.nan)
        .sort_values(["month_end", "symbol"])
        .reset_index(drop=True)
    )

    # Keep rows usable by every candidate formula so formula comparisons share
    # exactly the same cross-sectional universe each month.
    out = out.dropna(subset=FACTORS).reset_index(drop=True)

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)

    manifest = {
        "engine": "monthly-snapshot-builder-v2",
        "input_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(Path(args.output).read_bytes()).hexdigest(),
        "rows": int(len(out)),
        "pit_membership": args.membership,
        "pit_excluded_rows": int(pit_excluded_rows),
        "pit_active_symbols": int(pit_active_symbols),
        "symbols": int(out["symbol"].nunique()),
        "months": int(out["month_end"].nunique()),
        "min_month": str(out["month_end"].min()) if len(out) else None,
        "max_month": str(out["month_end"].max()) if len(out) else None,
        "factor_mapping": {
            "mom1": "MOM_20",
            "mom2": "MOM_40",
            "mom3": "MOM_60",
            "mom4": "MOM_80",
            "mom6": "MOM_120",
            "mom12": "MOM_252",
            "high52_ratio": "1 + DIST_HIGH_252",
            "vol20": "VOL_20",
            "maxdd60": "MAXDD_60",
            "avg_amount20": "AMOUNT",
        },
        "month_snapshot_rule": "last available trading day per symbol and calendar month",
        "pit_date_column": "snapshot_date",
        "forward_return_rule": "computed downstream from adjacent calendar-month snapshots only",
    }
    Path(str(args.output) + ".manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
