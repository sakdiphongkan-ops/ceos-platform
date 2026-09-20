#!/usr/bin/env python3
"""Pull the public TradingView Thailand screener snapshot for LUNA.

This uses the public scanner endpoint used by the TradingView web screener.
It is a live cross-sectional snapshot, not historical backtest data.
LUNA never treats TradingView's current rows as historical labels.
"""

from __future__ import annotations
import argparse
import json
from pathlib import Path
import requests
import pandas as pd

BASE = "https://scanner.tradingview.com/thailand/scan"

INDICATORS = [
    "Recommend.Other","Recommend.All","Recommend.MA",
    "RSI","RSI[1]","Stoch.K","Stoch.D","Stoch.K[1]","Stoch.D[1]",
    "CCI20","CCI20[1]","ADX","ADX+DI","ADX-DI","ADX+DI[1]","ADX-DI[1]",
    "AO","AO[1]","AO[2]","Mom","Mom[1]","MACD.macd","MACD.signal",
    "Rec.Stoch.RSI","Stoch.RSI.K","Rec.WR","W.R","Rec.BBPower","BBPower",
    "Rec.UO","UO","close","EMA10","SMA10","EMA20","SMA20","EMA30","SMA30",
    "EMA50","SMA50","EMA100","SMA100","EMA200","SMA200","Rec.Ichimoku",
    "Ichimoku.BLine","Rec.VWMA","VWMA","Rec.HullMA9","HullMA9",
    "Pivot.M.Classic.S3","Pivot.M.Classic.S2","Pivot.M.Classic.S1",
    "Pivot.M.Classic.Middle","Pivot.M.Classic.R1","Pivot.M.Classic.R2","Pivot.M.Classic.R3",
    "Pivot.M.Fibonacci.S3","Pivot.M.Fibonacci.S2","Pivot.M.Fibonacci.S1",
    "Pivot.M.Fibonacci.Middle","Pivot.M.Fibonacci.R1","Pivot.M.Fibonacci.R2","Pivot.M.Fibonacci.R3",
    "BB.lower","BB.upper","P.SAR","open","high","low","volume","change",
    "Perf.1D","Perf.W","Perf.1M","Perf.3M","Perf.6M","Perf.YTD","Perf.Y"
]

def fetch(interval_suffix: str, start: int, end: int) -> dict:
    cols = [x + interval_suffix for x in INDICATORS]
    # name/description/exchange are stable screener fields and help map rows.
    cols = ["name","description","exchange"] + cols
    payload = {
        "symbols": {"query": {"types": []}},
        "columns": cols,
        "range": [start, end],
        "sort": {"sortBy": "name", "sortOrder": "asc", "nullsFirst": False},
        "options": {"lang": "en"},
        "preset": "all_stocks"
    }
    r = requests.post(
        BASE,
        json=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Referer": "https://th.tradingview.com/",
            "User-Agent": "Mozilla/5.0"
        },
        timeout=60
    )
    r.raise_for_status()
    return r.json()

def normalize(payload: dict, interval: str) -> pd.DataFrame:
    cols = ["name","description","exchange"] + [x + interval for x in INDICATORS]
    rows = []
    for item in payload.get("data", []):
        d = item.get("d", [])
        rows.append({"symbol": item.get("s"), **dict(zip(cols, d))})
    return pd.DataFrame(rows)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=2000)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    combined = []
    raw = {}
    for label, suffix in [("1D",""),("1W","|1W"),("1M","|1M")]:
        data = fetch(suffix, args.start, args.end)
        raw[label] = data
        df = normalize(data, suffix)
        df["tv_interval"] = label
        combined.append(df)

    all_df = pd.concat(combined, ignore_index=True)
    all_df.to_csv(out / "tradingview_thailand_screener_snapshot.csv", index=False)
    (out / "tradingview_thailand_screener_raw.json").write_text(
        json.dumps(raw, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    by_i = all_df.groupby("tv_interval").size().to_dict()
    meta = {
        "status": "COMPLETED",
        "endpoint": BASE,
        "rows_by_interval": by_i,
        "intervals": ["1D","1W","1M"],
        "indicator_count": len(INDICATORS),
        "source_note": "Public TradingView screener snapshot; current/live, not a historical backtest series."
    }
    (out / "summary.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

if __name__ == "__main__":
    main()
