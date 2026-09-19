#!/usr/bin/env python3
"""Extract and normalize the public Mendeley SET daily price dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

import pandas as pd

REQUIRED = {"Date", "Open", "High", "Low", "Close", "Vol", "Aclose", "id"}

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()

    zpath = Path(args.zip)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zpath) as zf:
        names = zf.namelist()
        candidates = [n for n in names if Path(n).name.lower() == "data1_tha.csv"]
        if not candidates:
            candidates = [n for n in names if n.lower().endswith(".csv")]
        if not candidates:
            raise SystemExit("No CSV file found in Mendeley archive")
        chosen = candidates[0]
        zf.extract(chosen, out / "raw")
        raw_path = out / "raw" / chosen

    df = pd.read_csv(raw_path)
    missing = REQUIRED - set(df.columns)
    if missing:
        raise SystemExit(f"Unexpected dataset schema; missing {sorted(missing)}")

    df = df.rename(columns={
        "Date":"date",
        "Open":"open",
        "High":"high",
        "Low":"low",
        "Close":"close",
        "Vol":"volume",
        "Aclose":"adj_close",
        "id":"symbol",
    })
    df["date"] = pd.to_datetime(df["date"], errors="raise").dt.date
    df["symbol"] = (
        df["symbol"].astype("string")
        .str.strip().str.upper().str.replace(r"\.BK$", "", regex=True)
    )

    for c in ["open","high","low","close","adj_close","volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df["amount"] = df["close"] * df["volume"]
    df["market"] = "SET"

    bad = (
        df["symbol"].isna()
        | df["date"].isna()
        | (df[["open","high","low","close"]] <= 0).any(axis=1)
        | (df["high"] < df[["open","low","close"]].max(axis=1))
        | (df["low"] > df[["open","high","close"]].min(axis=1))
    )
    if bad.any():
        raise SystemExit(f"Invalid rows detected: {int(bad.sum())}")

    dup = df.duplicated(["date","symbol"], keep=False)
    if dup.any():
        raise SystemExit(f"Duplicate date+symbol rows: {int(dup.sum())}")

    keep = ["date","symbol","market","open","high","low","close","adj_close","volume","amount"]
    df = df[keep].sort_values(["date","symbol"]).reset_index(drop=True)

    prices = out / "prices.csv"
    df.to_csv(prices, index=False)

    manifest = {
        "schema_version": "luna-research-v1",
        "source": "Mendeley Data",
        "dataset_doi": "10.17632/gybmm9t3mr.1",
        "license": "CC BY 4.0",
        "source_file": chosen,
        "source_zip_sha256": sha256(zpath),
        "prices_sha256": sha256(prices),
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "start": str(df["date"].min()),
        "end": str(df["date"].max()),
        "adjusted_close_present": bool(df["adj_close"].notna().any()),
        "survivorship_note": "Dataset is historical SET coverage from the cited research dataset; symbol membership should be treated as observed-history, not current-universe-only.",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))

if __name__ == "__main__":
    main()
