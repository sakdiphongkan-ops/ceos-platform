#!/usr/bin/env python3
"""Export LUNA monthly research factors from Supabase REST API.

Authentication is provided by SUPABASE_SERVICE_ROLE_KEY at runtime; the key
must never be committed to the repository or printed to logs.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pandas as pd
import requests

COLUMNS = [
    "symbol", "month_end", "adj_close", "mom1", "mom3", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.getenv("SUPABASE_URL", ""))
    ap.add_argument("--table", default="luna_research_monthly_price_factors")
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", default="2021-09-01")
    ap.add_argument("--end", default="2026-08-01")
    ap.add_argument("--page-size", type=int, default=1000)
    args = ap.parse_args()

    key = os.getenv("SUPABASE_API_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not args.url or not key:
        raise SystemExit("SUPABASE_URL and SUPABASE_API_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required")

    url = args.url.rstrip("/") + "/rest/v1/" + args.table
    rows = []
    offset = 0
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    params_base = {
        "select": ",".join(COLUMNS),
        "month_end": f"gte.{args.start}",
        "order": "month_end.asc,symbol.asc",
        "limit": args.page_size,
    }

    while True:
        params = {**params_base, "offset": offset}
        resp = requests.get(url, headers=headers, params=params, timeout=60)
        resp.raise_for_status()
        page = resp.json()
        rows.extend(page)
        print(f"downloaded={len(rows)}", flush=True)
        if len(page) < args.page_size:
            break
        offset += args.page_size

    df = pd.DataFrame(rows, columns=COLUMNS)
    df = df[df["month_end"] <= args.end].copy()
    for c in COLUMNS:
        if c not in {"symbol", "month_end"}:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df["month_end"] = pd.to_datetime(df["month_end"])
    df = df.sort_values(["month_end", "symbol"]).drop_duplicates(
        ["month_end", "symbol"]
    )
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    print({
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "min_month": str(df["month_end"].min().date()),
        "max_month": str(df["month_end"].max().date()),
        "output": str(out),
    })


if __name__ == "__main__":
    main()
