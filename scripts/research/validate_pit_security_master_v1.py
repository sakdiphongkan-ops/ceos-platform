#!/usr/bin/env python3
"""Validate LUNA point-in-time security master v1.

The validator is deliberately strict about time semantics:
- available_at must exist for every usable record
- effective_from/effective_to define classification intervals
- no overlapping intervals for the same symbol
- listed/delist dates are checked when present
- missing input can be reported as UNAVAILABLE with --allow-missing
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

REQUIRED = {"symbol", "effective_from", "available_at"}
OPTIONAL = {
    "isin", "security_name", "market", "sector", "sector_code",
    "industry", "industry_code", "listed_date", "delist_date",
    "effective_to", "source", "source_record_id",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--allow-missing", action="store_true")
    args = ap.parse_args()

    src = Path(args.input)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        if not args.allow_missing:
            raise SystemExit(f"PIT security master not found: {src}")
        result = {
            "status": "UNAVAILABLE",
            "engine": "luna-pit-security-master-validator-v1",
            "reason": f"Input not present: {src}",
            "contract": "data/contracts/luna_pit_security_master_v1.schema.json",
        }
        (out / "pit-security-master-validation.json").write_text(
            json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    d = pd.read_csv(src)
    missing = sorted(REQUIRED - set(d.columns))
    unknown = sorted(set(d.columns) - REQUIRED - OPTIONAL)
    if missing:
        raise SystemExit(f"missing required PIT columns: {missing}")
    if unknown:
        raise SystemExit(f"unexpected PIT columns; update the contract explicitly: {unknown}")

    for c in ["effective_from", "effective_to", "available_at", "listed_date", "delist_date"]:
        if c in d.columns:
            d[c] = pd.to_datetime(d[c], errors="coerce", utc=True)

    d["symbol"] = d["symbol"].astype("string").str.strip().str.upper()

    issues = []

    if d["symbol"].isna().any() or (d["symbol"].eq("")).any():
        issues.append({"check": "symbol_nonempty", "bad_rows": int(d["symbol"].isna().sum() + d["symbol"].eq("").sum())})

    for c in ["effective_from", "available_at"]:
        bad = int(d[c].isna().sum())
        if bad:
            issues.append({"check": f"{c}_present", "bad_rows": bad})

    if "effective_to" in d.columns:
        bad = int((d["effective_to"].notna() & d["effective_from"].notna() &
                   (d["effective_to"] <= d["effective_from"])).sum())
        if bad:
            issues.append({"check": "effective_interval_order", "bad_rows": bad})

    if "delist_date" in d.columns:
        bad = int((d["delist_date"].notna() & d["listed_date"].notna() &
                   (d["delist_date"] < d["listed_date"])).sum())
        if bad:
            issues.append({"check": "listed_before_delisted", "bad_rows": bad})

    # Availability can never precede? It may legitimately be earlier than effective_from
    # in some feeds, but it must exist. The decision-time join enforces availability <= decision_ts.
    # Here we only reject obviously malformed far-future dates relative to effective interval.
    bad_future = int((
        d["available_at"].notna()
        & d["effective_from"].notna()
        & (d["available_at"] > d["effective_from"] + pd.Timedelta(days=3650))
    ).sum())
    if bad_future:
        issues.append({"check": "availability_reasonableness", "bad_rows": bad_future})

    # Detect overlapping effective intervals per symbol.
    intervals = d[["symbol", "effective_from", "effective_to"]].copy()
    intervals["effective_to_filled"] = intervals["effective_to"].fillna(
        pd.Timestamp.max.tz_localize("UTC")
    )
    overlaps = 0
    for _, g in intervals.sort_values(["symbol", "effective_from"]).groupby("symbol"):
        prev_end = None
        for row in g.itertuples(index=False):
            start = row.effective_from
            end = row.effective_to_filled
            if pd.notna(prev_end) and pd.notna(start) and start < prev_end:
                overlaps += 1
            if prev_end is None or (pd.notna(end) and end > prev_end):
                prev_end = end
    if overlaps:
        issues.append({"check": "non_overlapping_effective_intervals", "bad_rows": int(overlaps)})

    result = {
        "status": "COMPLETED" if not issues else "FAILED",
        "engine": "luna-pit-security-master-validator-v1",
        "input": str(src),
        "rows": int(len(d)),
        "symbols": int(d["symbol"].nunique(dropna=True)),
        "columns": list(d.columns),
        "checks_failed": issues,
        "contract": "data/contracts/luna_pit_security_master_v1.schema.json",
        "time_rule": "available_at <= decision_ts; effective_from determines the historical classification interval.",
    }
    (out / "pit-security-master-validation.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False, default=str), encoding="utf-8"
    )
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    if issues:
        raise SystemExit("PIT security master validation failed")


if __name__ == "__main__":
    main()
