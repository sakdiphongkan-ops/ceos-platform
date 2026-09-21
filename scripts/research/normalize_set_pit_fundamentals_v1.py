#!/usr/bin/env python3
"""Normalize raw SET SMART Marketplace fundamentals into LUNA PIT rows.

The normalizer deliberately requires an explicit --available-at. It never
infers availability from as-of dates, fiscal periods, or the local retrieval time.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd


def find_records(obj):
    if isinstance(obj, list) and all(isinstance(x, dict) for x in obj):
        return obj
    if isinstance(obj, dict):
        # Prefer common API envelope names first.
        for key in ["data", "result", "items", "content", "records"]:
            if key in obj:
                found = find_records(obj[key])
                if found:
                    return found
        for value in obj.values():
            found = find_records(value)
            if found:
                return found
    return []


def col(row, *names):
    lookup = {str(k).lower(): v for k, v in row.items()}
    for name in names:
        key = str(name).lower()
        if key in lookup:
            return lookup[key]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--available-at", required=True,
                    help="Explicit source availability timestamp; never inferred from asOfDate.")
    ap.add_argument("--source-endpoint", required=True)
    ap.add_argument("--source-record-id-field", default="")
    args = ap.parse_args()

    src = Path(args.input)
    payload = json.loads(src.read_text(encoding="utf-8"))
    rows = find_records(payload)
    if not rows:
        raise SystemExit("no list-of-records found in SET JSON payload")

    available_at = pd.Timestamp(args.available_at, tz="UTC")
    out = []

    for i, row in enumerate(rows):
        symbol = col(row, "symbol", "securitySymbol")
        if not symbol:
            continue

        r = {
            "symbol": str(symbol).strip().upper(),
            "available_at": available_at.isoformat(),
            "as_of_date": col(row, "asOfDate", "dateAsof", "asOfDate"),
            "fiscal_year": col(row, "fiscalYear", "year"),
            "quarter": col(row, "quarter"),
            "statement_type": col(row, "statementType", "financialStatementType"),
            "adjustment_status": col(row, "adjustmentStatus"),
            "pe": col(row, "pe"),
            "pbv": col(row, "pbv"),
            "div_yield": col(row, "dividendYield"),
            "roe": col(row, "roe"),
            "roa": col(row, "roa"),
            "de": col(row, "de"),
            "turnover": col(row, "volumeTurnover", "totalAssetTurnover"),
            "eps_g": col(row, "epsGrowth"),
            "rev_g": col(row, "revenueGrowth"),
            "ni_g": col(row, "netProfitGrowth"),
            "fcf_yield": col(row, "fcfYield"),
            "earnings_yield": col(row, "earningsYield"),
            "roic": col(row, "roic"),
            "gpm": col(row, "grossProfitMargin"),
            "npm": col(row, "netProfitMarginAccum", "netProfitMarginQuarter"),
            "cfo_margin": col(row, "cfoMargin"),
            "asset_g": col(row, "assetGrowth"),
            "capex_g": col(row, "capexGrowth"),
            "investment_rate": col(row, "investmentRate"),
            "div_g": col(row, "dividendGrowth"),
            "payout": col(row, "payout"),
            "buyback": col(row, "buyback"),
            "net_debt_ebitda": col(row, "netDebtEbitda"),
            "interest_cover": col(row, "interestCover"),
            "current_ratio": col(row, "currentRatio"),
            "source": "SET SMART Marketplace",
            "source_record_id": (
                col(row, args.source_record_id_field)
                if args.source_record_id_field else f"{src.name}:{i}"
            ),
            "source_endpoint": args.source_endpoint,
        }
        out.append(r)

    df = pd.DataFrame(out)
    if df.empty:
        raise SystemExit("no usable SET records after symbol filtering")

    numeric = [
        c for c in df.columns if c in {
            "pe","pbv","div_yield","roe","roa","de","turnover","eps_g","rev_g","ni_g",
            "fcf_yield","earnings_yield","roic","gpm","npm","cfo_margin","asset_g",
            "capex_g","investment_rate","div_g","payout","buyback","net_debt_ebitda",
            "interest_cover","current_ratio"
        }
    ]
    for c in numeric:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df["as_of_date"] = pd.to_datetime(df["as_of_date"], errors="coerce").dt.date.astype("string")
    df["fiscal_year"] = pd.to_numeric(df["fiscal_year"], errors="coerce").astype("Int64")
    df["quarter"] = pd.to_numeric(df["quarter"], errors="coerce").astype("Int64")
    df = df.sort_values(["symbol","available_at","as_of_date"]).reset_index(drop=True)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out_path, index=False)

    manifest = {
        "status": "COMPLETED",
        "engine": "luna-set-fundamentals-normalizer-v1",
        "input_sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(out_path.read_bytes()).hexdigest(),
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "available_at": available_at.isoformat(),
        "source_endpoint": args.source_endpoint,
        "pit_guard": (
            "available_at is supplied explicitly by the caller. as_of_date/fiscal "
            "period is never substituted for availability."
        ),
    }
    out_path.with_suffix(out_path.suffix + ".manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
