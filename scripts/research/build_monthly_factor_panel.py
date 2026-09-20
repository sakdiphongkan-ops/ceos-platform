#!/usr/bin/env python3
"""Convert daily LUNA factors + prices into a point-in-time monthly factor panel."""

from __future__ import annotations
import argparse, json
from pathlib import Path
import pandas as pd

FACTORS = [
    "MOM_5","MOM_10","MOM_20","MOM_40","MOM_60","MOM_120","MOM_252","REL_MOM",
    "VOL_10","VOL_20","MAXDD_60","ATR_PCT","ADV20","AMOUNT","ILLIQ_20",
    "BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60","DIST_HIGH_252",
    "SKEW_20","SKEW_60","QUALITY_SCORE","VALUE_QUALITY","MOM_BLEND",
    "CONSERVATIVE_SCORE","SAFETY_SCORE","GROWTH_QUALITY","INV_QUALITY",
]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--factors",required=True)
    ap.add_argument("--prices",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()

    f=pd.read_csv(args.factors)
    p=pd.read_csv(args.prices)
    for df in (f,p):
        df["date"]=pd.to_datetime(df["date"],errors="raise")
        df["symbol"]=df["symbol"].astype(str).str.strip().str.upper()
    price_col="adj_close" if "adj_close" in p.columns and p["adj_close"].notna().any() else "close"
    p[price_col]=pd.to_numeric(p[price_col],errors="coerce")
    p=p[["date","symbol",price_col]].dropna(subset=[price_col])

    f["month_end"]=f["date"].dt.to_period("M").dt.to_timestamp("M")
    # Last decision-day observation in each month: point-in-time only.
    f=f.sort_values(["symbol","date"]).groupby(["symbol","month_end"],as_index=False).tail(1)
    p["month_end"]=p["date"].dt.to_period("M").dt.to_timestamp("M")
    p=p.sort_values(["symbol","date"]).groupby(["symbol","month_end"],as_index=False).tail(1)
    p=p[["symbol","month_end",price_col]].rename(columns={price_col:"adj_close"})

    keep=["symbol","month_end"]+[c for c in FACTORS if c in f.columns]
    m=f[keep].merge(p,on=["symbol","month_end"],how="inner")
    m=m.sort_values(["symbol","month_end"]).drop_duplicates(["symbol","month_end"])

    # Strict one-calendar-month forward return.
    m["_next_month"]=m.groupby("symbol")["month_end"].shift(-1)
    m["_next_adj_close"]=m.groupby("symbol")["adj_close"].shift(-1)
    expected=m["month_end"]+pd.offsets.MonthEnd(1)
    m["fwd1"]=((m["_next_adj_close"]/m["adj_close"])-1).where(
        m["_next_month"].eq(expected)
    )
    m=m.drop(columns=["_next_month","_next_adj_close"])
    out=Path(args.output); out.parent.mkdir(parents=True,exist_ok=True)
    m.to_csv(out,index=False)
    manifest={
        "rows":int(len(m)),
        "symbols":int(m["symbol"].nunique()),
        "min_month":str(m["month_end"].min().date()),
        "max_month":str(m["month_end"].max().date()),
        "price_source":price_col,
        "forward_return":"next calendar month-end only",
        "point_in_time":"last daily decision observation within month",
    }
    out.with_suffix(".manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    print(json.dumps(manifest,indent=2))

if __name__=="__main__":
    main()
