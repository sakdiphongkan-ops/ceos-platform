#!/usr/bin/env python3
"""Validate and normalize raw SET/mai research files.

The script is intentionally fail-closed:
- date+symbol duplicates are rejected;
- impossible prices are rejected;
- fundamental rows require publication/availability timestamps;
- no historical value is silently forward-filled across a missing publication time.

It produces canonical CSVs that the factor builder consumes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd

PRICE_REQUIRED = {"date", "symbol", "open", "high", "low", "close", "volume"}
FUND_REQUIRED = {"asof_date", "symbol", "available_at"}
CA_REQUIRED = {"symbol", "action_date", "action_type"}

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def clean_symbols(s: pd.Series) -> pd.Series:
    return s.astype("string").str.strip().str.upper()

def normalize_prices(path: Path, out: Path, decision_hour: int) -> dict:
    df = pd.read_csv(path)
    missing = PRICE_REQUIRED - set(df.columns)
    if missing:
        raise SystemExit(f"{path}: missing price columns {sorted(missing)}")
    df["date"] = pd.to_datetime(df["date"], errors="raise").dt.date
    df["symbol"] = clean_symbols(df["symbol"])
    numeric = ["open", "high", "low", "close", "volume", "adj_close", "amount"]
    for c in numeric:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    if df["symbol"].isna().any() or (df["symbol"].str.len() == 0).any():
        raise SystemExit(f"{path}: blank symbol found")
    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        raise SystemExit(f"{path}: non-positive OHLC value found")
    if (df[["high", "low"]].diff(axis=1)["low"] < 0).any():
        pass
    if (df["high"] < df[["open", "low", "close"]].max(axis=1)).any():
        raise SystemExit(f"{path}: high is below OHLC")
    if (df["low"] > df[["open", "high", "close"]].min(axis=1)).any():
        raise SystemExit(f"{path}: low is above OHLC")
    dup = df.duplicated(["date", "symbol"], keep=False)
    if dup.any():
        raise SystemExit(f"{path}: duplicate date+symbol rows: {int(dup.sum())}")
    if "available_at" not in df.columns:
        df["available_at"] = (
            pd.to_datetime(df["date"]).dt.tz_localize("Asia/Bangkok")
            + pd.Timedelta(hours=decision_hour)
        ).dt.tz_convert("UTC").dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    df = df.sort_values(["date", "symbol"]).reset_index(drop=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    return {
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "start": str(df["date"].min()),
        "end": str(df["date"].max()),
        "sha256": sha256(out),
    }

def normalize_fundamentals(path: Path, out: Path) -> dict:
    df = pd.read_csv(path)
    missing = FUND_REQUIRED - set(df.columns)
    if missing:
        raise SystemExit(f"{path}: missing fundamental columns {sorted(missing)}")
    df["asof_date"] = pd.to_datetime(df["asof_date"], errors="raise").dt.date
    df["available_at"] = pd.to_datetime(df["available_at"], errors="raise", utc=True)
    df["symbol"] = clean_symbols(df["symbol"])
    if df["available_at"].isna().any():
        raise SystemExit(f"{path}: null available_at")
    dup = df.duplicated(["symbol","available_at"], keep=False)
    if dup.any():
        raise SystemExit(f"{path}: duplicate symbol+available_at fundamentals: {int(dup.sum())}")
    nums = [c for c in df.columns if c not in {"asof_date", "symbol", "available_at", "raw"}]
    for c in nums:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    out.parent.mkdir(parents=True, exist_ok=True)
    df.sort_values(["symbol", "available_at"]).to_csv(out, index=False)
    return {
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "start": str(df["asof_date"].min()),
        "end": str(df["asof_date"].max()),
        "sha256": sha256(out),
    }

def normalize_ca(path: Path, out: Path) -> dict:
    df = pd.read_csv(path)
    missing = CA_REQUIRED - set(df.columns)
    if missing:
        raise SystemExit(f"{path}: missing corporate-action columns {sorted(missing)}")
    df["action_date"] = pd.to_datetime(df["action_date"], errors="raise").dt.date
    if "effective_date" in df.columns:
        df["effective_date"] = pd.to_datetime(df["effective_date"], errors="coerce").dt.date
    if "available_at" in df.columns:
        df["available_at"] = pd.to_datetime(df["available_at"], errors="raise", utc=True)
    df["symbol"] = clean_symbols(df["symbol"])
    df["action_type"] = df["action_type"].astype("string").str.strip().str.upper()
    dup = df.duplicated(["symbol", "action_date", "action_type", "effective_date"], keep=False)
    if dup.any():
        raise SystemExit(f"{path}: duplicate corporate-action keys: {int(dup.sum())}")
    out.parent.mkdir(parents=True, exist_ok=True)
    df.sort_values(["symbol", "action_date"]).to_csv(out, index=False)
    return {"rows": int(len(df)), "symbols": int(df["symbol"].nunique()), "sha256": sha256(out)}

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True)
    ap.add_argument("--fundamentals")
    ap.add_argument("--corporate-actions")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--decision-hour", type=int, default=17)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": "luna-research-v1",
        "prices": normalize_prices(Path(args.prices), out / "prices.normalized.csv", args.decision_hour),
    }
    if args.fundamentals:
        manifest["fundamentals"] = normalize_fundamentals(
            Path(args.fundamentals), out / "fundamentals.normalized.csv"
        )
    if args.corporate_actions:
        manifest["corporate_actions"] = normalize_ca(
            Path(args.corporate_actions), out / "corporate_actions.normalized.csv"
        )
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))

if __name__ == "__main__":
    main()
