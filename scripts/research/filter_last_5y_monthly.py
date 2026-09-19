#!/usr/bin/env python3
"""Filter a monthly factor dataset to the strict trailing five calendar years."""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd
from dateutil.relativedelta import relativedelta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    if "month_end" not in df.columns:
        raise SystemExit("input must contain month_end")

    df["month_end"] = pd.to_datetime(df["month_end"], errors="raise")
    end = df["month_end"].max()
    start = end - relativedelta(years=5)
    out = df[df["month_end"] >= start].sort_values(["month_end", "symbol"]).reset_index(drop=True)

    if out.empty:
        raise SystemExit("empty trailing-5-year dataset")

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)
    print({
        "rows": int(len(out)),
        "symbols": int(out["symbol"].nunique()),
        "start": str(out["month_end"].min().date()),
        "end": str(out["month_end"].max().date()),
        "window": "trailing-5-calendar-years-monthly-v1",
    })


if __name__ == "__main__":
    main()
