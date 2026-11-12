#!/usr/bin/env python3
"""Export daily SET OHLCV research prices from Supabase."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import pandas as pd
import requests

COLUMNS = [
    "dataset_id","date","symbol","market","open","high","low","close","adj_close",
    "volume","amount","available_at","source_available_at","source","source_seq",
    "ohlc_valid","bar_eligible","close_return_eligible","availability_policy"
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.getenv("SUPABASE_URL", ""))
    ap.add_argument("--table", default="luna_research_prices_pit_v1")
    ap.add_argument("--dataset-id", default=os.getenv("LUNA_RESEARCH_DATASET_ID", "1af83c59-a56f-461f-b03e-f3d04e67e384"))
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", default="2021-09-01")
    ap.add_argument("--end", default="2026-08-31")
    ap.add_argument("--page-size", type=int, default=5000)
    args = ap.parse_args()

    key = os.getenv("SUPABASE_API_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not args.url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_API_KEY/SUPABASE_SERVICE_ROLE_KEY are required")

    url = args.url.rstrip("/") + "/rest/v1/" + args.table
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "Prefer": "count=exact",
    }
    rows = []
    offset = 0
    while True:
        params = [
            ("select", ",".join(COLUMNS)),
            ("dataset_id", f"eq.{args.dataset_id}"),
            ("date", f"gte.{args.start}"),
            ("date", f"lte.{args.end}"),
            ("order", "date.asc,symbol.asc"),
            ("limit", args.page_size),
            ("offset", offset),
        ]
        r = requests.get(url, headers=headers, params=params, timeout=120)
        r.raise_for_status()
        page = r.json()
        rows.extend(page)
        print(f"downloaded={len(rows)}", flush=True)
        if len(page) < args.page_size:
            break
        offset += args.page_size

    df = pd.DataFrame(rows, columns=COLUMNS)
    df["date"] = pd.to_datetime(df["date"])
    for c in [x for x in COLUMNS if x not in {"date","symbol","market","available_at"}]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["available_at"] = pd.to_datetime(df["available_at"], utc=True, errors="coerce")
    df = df.sort_values(["symbol","date"]).drop_duplicates(["symbol","date"])

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    print({
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "start": str(df["date"].min().date()),
        "end": str(df["date"].max().date()),
        "output": str(out),
    })


if __name__ == "__main__":
    main()
