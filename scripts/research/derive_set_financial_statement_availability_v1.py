#!/usr/bin/env python3
"""Derive PIT availability for SET Financial Statement rows.

SET documents that current financial-statement data is available through the API
at 04:00 BKK each day and provides a Last Update Date endpoint. This helper
uses the matching year/quarter last-update date plus that documented 04:00
schedule. It never uses asOfDate as availability.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import pandas as pd


def records(obj):
    if isinstance(obj, list) and all(isinstance(x, dict) for x in obj):
        return obj
    if isinstance(obj, dict):
        for key in ["data", "result", "items", "content", "records"]:
            if key in obj:
                found = records(obj[key])
                if found:
                    return found
        for value in obj.values():
            found = records(value)
            if found:
                return found
    return []


def pick(row, *names):
    lower={str(k).lower():v for k,v in row.items()}
    for n in names:
        if str(n).lower() in lower:
            return lower[str(n).lower()]
    return None


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--financial-statement",required=True)
    ap.add_argument("--last-update",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()

    fs_path=Path(args.financial_statement)
    lu_path=Path(args.last_update)
    fs=records(json.loads(fs_path.read_text(encoding="utf-8")))
    lu=records(json.loads(lu_path.read_text(encoding="utf-8")))
    if not fs:
        raise SystemExit("no financial-statement records found")
    if not lu:
        raise SystemExit("no last-update records found")

    update_map={}
    for row in lu:
        year=pick(row,"asOfYear","year","fiscalYear")
        quarter=pick(row,"asOfQuarter","quarter")
        date=pick(row,"lastUpdateDate")
        if year is None or quarter is None or not date:
            continue
        update_map[(str(year),str(quarter))]=str(date)

    out=[]
    missing=[]
    for row in fs:
        y=pick(row,"fiscalYear","year","asOfYear")
        q=pick(row,"quarter","asOfQuarter")
        key=(str(y),str(q))
        upd=update_map.get(key)
        if not upd:
            missing.append(key)
            continue

        avail=(pd.Timestamp(upd).tz_localize("Asia/Bangkok")+pd.Timedelta(hours=4)).tz_convert("UTC")
        item=dict(row)
        item["available_at"]=avail.isoformat()
        item["availability_basis"]="SET financial-statement Last Update Date + documented 04:00 BKK availability"
        out.append(item)

    if missing:
        raise SystemExit(f"missing Last Update Date for statement periods: {sorted(set(missing))}")

    p=Path(args.output); p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(out,indent=2,ensure_ascii=False,default=str),encoding="utf-8")
    print(json.dumps({
        "status":"COMPLETED",
        "engine":"luna-set-financial-statement-availability-v1",
        "rows":len(out),
        "periods":sorted(update_map),
        "availability_rule":"lastUpdateDate at 04:00 Asia/Bangkok",
        "guard":"asOfDate/fiscal period is never used as availability"
    },indent=2))


if __name__=="__main__":
    main()
