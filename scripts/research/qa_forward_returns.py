#!/usr/bin/env python3
"""Audit forward-return quality before allowing research results to be trusted."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Factor CSV with fwd_return columns")
    ap.add_argument("--output", required=True, help="JSON summary path")
    ap.add_argument("--extremes-output", required=True, help="CSV with extreme rows")
    ap.add_argument("--warn-abs-return", type=float, default=0.20)
    ap.add_argument("--hard-invalid", action="store_true")
    args = ap.parse_args()

    df = pd.read_csv(args.input, usecols=["date", "symbol", "fwd_return", "fwd_return_1d"])
    for c in ["fwd_return", "fwd_return_1d"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date", "symbol"])

    r = df["fwd_return_1d"].dropna()
    abs_r = r.abs()
    thresholds = [args.warn_abs_return, 0.50, 1.00, 2.00, 5.00]
    counts = {f"abs_gt_{int(t*100)}pct": int((abs_r > t).sum()) for t in thresholds}

    # Include all returns whose magnitude is above the warning threshold.
    mask = df["fwd_return_1d"].abs() > args.warn_abs_return
    extremes = df.loc[mask].copy()
    extremes["abs_return"] = extremes["fwd_return_1d"].abs()
    extremes = extremes.sort_values("abs_return", ascending=False).head(200)
    Path(args.extremes_output).parent.mkdir(parents=True, exist_ok=True)
    extremes.to_csv(args.extremes_output, index=False)

    summary = {
        "rows": int(len(df)),
        "non_null_fwd_return_1d": int(r.size),
        "mean_fwd_return_1d": float(r.mean()) if len(r) else None,
        "median_fwd_return_1d": float(r.median()) if len(r) else None,
        "p01_fwd_return_1d": float(r.quantile(0.01)) if len(r) else None,
        "p99_fwd_return_1d": float(r.quantile(0.99)) if len(r) else None,
        "min_fwd_return_1d": float(r.min()) if len(r) else None,
        "max_fwd_return_1d": float(r.max()) if len(r) else None,
        "thresholds": counts,
        "extreme_rows_written": int(len(extremes)),
        "invalid_below_minus_100pct": int((r < -1).sum()),
        "warn_abs_return": args.warn_abs_return,
        "hard_invalid": args.hard_invalid,
        "note": "Extreme adjusted-close jumps are reported for review; they are not silently clipped or winsorized.",
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(json.dumps(summary, indent=2))

    if args.hard_invalid and summary["invalid_below_minus_100pct"] > 0:
        raise SystemExit("Found impossible forward returns below -100%.")


if __name__ == "__main__":
    main()
