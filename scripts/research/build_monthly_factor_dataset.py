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
from pathlib import Path

import numpy as np
import pandas as pd

FACTORS = [
    "mom1", "mom3", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]

SOURCE_MAP = {
    "mom1": "MOM_20",
    "mom3": "MOM_60",
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
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    required = {"date", "symbol", "adj_close", "DIST_HIGH_252", *SOURCE_MAP.values()}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["date"] = pd.to_datetime(df["date"], errors="raise")
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
        "month_end": m["month_end"],
        "adj_close": m["adj_close"],
    })
    for dst, src in SOURCE_MAP.items():
        out[dst] = m[src]
    out["high52_ratio"] = 1.0 + m["DIST_HIGH_252"]

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
        "symbols": int(out["symbol"].nunique()),
        "months": int(out["month_end"].nunique()),
        "min_month": str(out["month_end"].min()) if len(out) else None,
        "max_month": str(out["month_end"].max()) if len(out) else None,
        "factor_mapping": {
            "mom1": "MOM_20",
            "mom3": "MOM_60",
            "mom6": "MOM_120",
            "mom12": "MOM_252",
            "high52_ratio": "1 + DIST_HIGH_252",
            "vol20": "VOL_20",
            "maxdd60": "MAXDD_60",
            "avg_amount20": "AMOUNT",
        },
        "month_snapshot_rule": "last available trading day per symbol and calendar month",
        "forward_return_rule": "computed downstream from adjacent calendar-month snapshots only",
    }
    Path(str(args.output) + ".manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
