#!/usr/bin/env python3
"""Filter a LUNA factor dataset to a strict trailing-5-year research window.

Keeps all observations whose date is on/after (max_date - 5 calendar years).
No factor recomputation is performed, so the underlying factor definitions stay
identical to the canonical dataset pipeline.
"""
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
    if "date" not in df.columns:
        raise SystemExit("input must contain date")
    df["date"] = pd.to_datetime(df["date"], errors="raise").dt.date
    end = max(df["date"])
    start = end - relativedelta(years=5)
    out = df[df["date"] >= start].sort_values(["date", "symbol"]).reset_index(drop=True)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)
    print({
        "rows": len(out),
        "symbols": int(out["symbol"].nunique()),
        "start": str(min(out["date"])),
        "end": str(max(out["date"])),
        "window": "trailing-5-calendar-years-v1"
    })

if __name__ == "__main__":
    main()
