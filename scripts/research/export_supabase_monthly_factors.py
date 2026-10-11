#!/usr/bin/env python3
"""Export LUNA monthly research factors from Supabase REST API.

Authentication is provided by SUPABASE_SERVICE_ROLE_KEY at runtime; the key
must never be committed to the repository or printed to logs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

COLUMNS = [
    "dataset_id", "symbol", "month_end", "adj_close", "mom1", "mom3", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.getenv("SUPABASE_URL", ""))
    ap.add_argument("--table", default="luna_research_monthly_price_factors")
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", default="2021-09-01")
    ap.add_argument("--end", default="2026-08-01")
    ap.add_argument("--dataset-id", default=None, help="Exact dataset UUID to export; required when the table contains multiple dataset IDs")
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
    # Use the PostgREST logical AND to bound the query on both sides.
    # Fetching only rows inside the declared time window keeps export output deterministic.
    params_base: list[tuple[str, str | int]] = [
        ("select", ",".join(COLUMNS)),
        ("and", f"(month_end.gte.{args.start},month_end.lte.{args.end})"),
        ("order", "month_end.asc,symbol.asc"),
        ("limit", args.page_size),
    ]
    if args.dataset_id:
        params_base.append(("dataset_id", f"eq.{args.dataset_id}"))

    while True:
        params = [*params_base, ("offset", offset)]
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
    dataset_ids = sorted(df["dataset_id"].dropna().astype(str).unique().tolist())
    if not dataset_ids:
        raise SystemExit("NO_DATASET_ID_ROWS: verify the table and date window")
    if args.dataset_id and dataset_ids != [str(args.dataset_id)]:
        raise SystemExit(f"DATASET_ID_MISMATCH: requested={args.dataset_id!r} returned={dataset_ids!r}")
    if not args.dataset_id and len(dataset_ids) > 1:
        raise SystemExit(f"MULTIPLE_DATASET_IDS: {dataset_ids!r}; pass --dataset-id to avoid mixing snapshots")
    for c in COLUMNS:
        if c not in {"dataset_id", "symbol", "month_end"}:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df["month_end"] = pd.to_datetime(df["month_end"])
    # snapshot_date is the date at which the month-end signal was formed.
    # It is not a substitute for PIT membership evidence; it only supplies
    # the correct observation timestamp to the separate lifecycle filter.
    df["snapshot_date"] = df["month_end"]
    df = df.sort_values(["month_end", "symbol"]).drop_duplicates(
        ["month_end", "symbol"]
    )
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)

    # Byte-level manifest: the formula lab validates this exact CSV before replay.
    # This is file provenance, not a substitute for PIT-universe or upstream-source validation.
    export_manifest = {
        "schema_version": "1.0",
        "record_type": "supabase_monthly_factor_export_manifest",
        "exported_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_table": f"public.{args.table}",
        "dataset_ids": sorted(df["dataset_id"].dropna().astype(str).unique().tolist()),
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "min_month": str(df["month_end"].min().date()),
        "max_month": str(df["month_end"].max().date()),
        "columns": list(df.columns),
        "output_file": out.name,
        "output_byte_count": int(out.stat().st_size),
        "output_sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
        "source_lineage_verified": False,
        "pit_membership_verified": False,
    }
    manifest_path = out.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(export_manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print({
        "rows": int(len(df)),
        "symbols": int(df["symbol"].nunique()),
        "min_month": str(df["month_end"].min().date()),
        "max_month": str(df["month_end"].max().date()),
        "output": str(out),
        "output_sha256": export_manifest["output_sha256"],
        "manifest": str(manifest_path),
    })


if __name__ == "__main__":
    main()
