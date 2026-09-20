#!/usr/bin/env python3
"""Build enriched point-in-time monthly LUNA panel for structured interaction search."""
from __future__ import annotations
import argparse, json
from pathlib import Path
import numpy as np
import pandas as pd

BASE = [
    "MOM_5","MOM_10","MOM_20","MOM_60","MOM_120",
    "VOL_10","VOL_20","MAXDD_60","ADV20","AMOUNT",
    "BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60",
    "SKEW_20","SKEW_60"
]
DERIVED = ["REV21","MOM_252","HIGH52_RATIO","LOW52_RATIO","AVG_AMOUNT20"]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--factors",required=True)
    ap.add_argument("--prices",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()

    f=pd.read_csv(args.factors)
    p=pd.read_csv(args.prices)
    for d in (f,p):
        d["date"]=pd.to_datetime(d["date"],errors="raise")
        d["symbol"]=d["symbol"].astype(str).str.strip().str.upper()
    px="adj_close" if "adj_close" in p.columns and p["adj_close"].notna().any() else "close"
    for c in ["open","high","low","close","volume","amount",px]:
        if c in p.columns: p[c]=pd.to_numeric(p[c],errors="coerce")
    if "amount" not in p.columns: p["amount"]=p["close"]*p["volume"]

    # Compute longer-horizon price/liquidity factors from the full daily history
    # before taking the monthly last-observation snapshot.
    p=p.sort_values(["symbol","date"]).reset_index(drop=True)
    g=p.groupby("symbol",group_keys=False)
    p["REV21"]=-g[px].pct_change(20)
    p["MOM_252"]=g[px].pct_change(252)
    p["HIGH52_RATIO"]=p[px]/g[px].rolling(252,min_periods=126).max().reset_index(level=0,drop=True)
    p["LOW52_RATIO"]=p[px]/g[px].rolling(252,min_periods=126).min().reset_index(level=0,drop=True)
    p["AVG_AMOUNT20"]=g["amount"].rolling(20,min_periods=20).mean().reset_index(level=0,drop=True)

    f["month_end"]=f["date"].dt.to_period("M").dt.to_timestamp("M")
    f=f.sort_values(["symbol","date"]).groupby(["symbol","month_end"],as_index=False).tail(1)
    p["month_end"]=p["date"].dt.to_period("M").dt.to_timestamp("M")
    p=p.sort_values(["symbol","date"]).groupby(["symbol","month_end"],as_index=False).tail(1)
    p=p[["symbol","month_end",px]+DERIVED].rename(columns={px:"adj_close"})

    keep=["symbol","month_end"]+[c for c in BASE if c in f.columns]
    m=f[keep].merge(p,on=["symbol","month_end"],how="inner")
    m=m.sort_values(["symbol","month_end"]).drop_duplicates(["symbol","month_end"])

    # Strict next-calendar-month return.
    m["_next_month"]=m.groupby("symbol")["month_end"].shift(-1)
    m["_next_adj_close"]=m.groupby("symbol")["adj_close"].shift(-1)
    expected=m["month_end"]+pd.offsets.MonthEnd(1)
    m["fwd1"]=((m["_next_adj_close"]/m["adj_close"])-1).where(m["_next_month"].eq(expected))
    m=m.drop(columns=["_next_month","_next_adj_close"])

    out=Path(args.output); out.parent.mkdir(parents=True,exist_ok=True)
    m.to_csv(out,index=False)
    manifest={
        "rows":int(len(m)),
        "symbols":int(m.symbol.nunique()),
        "min_month":str(m.month_end.min().date()),
        "max_month":str(m.month_end.max().date()),
        "price_source":px,
        "forward_return":"next calendar month-end only",
        "derived_factors":DERIVED,
        "lookback_policy":"derived daily factors are calculated from full daily history before monthly snapshot"
    }
    out.with_suffix(".manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    print(json.dumps(manifest,indent=2))

if __name__=="__main__": main()
