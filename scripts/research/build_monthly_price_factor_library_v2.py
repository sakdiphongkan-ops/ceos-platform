#!/usr/bin/env python3
"""Build an expanded monthly price-factor library for LUNA v4."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

FACTORS=[
    "REV21","MOM_5","MOM_10","MOM_20","MOM_60","MOM_120","MOM_252",
    "VOL_10","VOL_20","MAXDD_60","ADV20","AVG_AMOUNT20","HIGH52_RATIO",
    "BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60","SKEW_20","SKEW_60"
]

def rsi(s,n=14):
    d=s.diff()
    up=d.clip(lower=0)
    dn=-d.clip(upper=0)
    au=up.ewm(alpha=1/n,adjust=False,min_periods=n).mean()
    ad=dn.ewm(alpha=1/n,adjust=False,min_periods=n).mean()
    rs=au/ad.replace(0,np.nan)
    return (100-100/(1+rs)).where(ad.ne(0),100.0)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--prices",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()

    p=pd.read_csv(args.prices)
    req={"date","symbol","adj_close","close","volume"}
    miss=sorted(req-set(p.columns))
    if miss: raise SystemExit(f"missing columns: {miss}")
    p["date"]=pd.to_datetime(p["date"],errors="raise")
    p["symbol"]=p["symbol"].astype(str).str.strip().str.upper()
    for c in ["adj_close","close","volume"]:
        p[c]=pd.to_numeric(p[c],errors="coerce")
    p=p.dropna(subset=["date","symbol","adj_close"]).sort_values(["symbol","date"])
    p=p.drop_duplicates(["symbol","date"],keep="last").reset_index(drop=True)
    g=p.groupby("symbol",group_keys=False)
    p["amount"]=p["close"]*p["volume"]
    r=g["adj_close"].pct_change()

    for n,name in [(21,"REV21"),(5,"MOM_5"),(10,"MOM_10"),(20,"MOM_20"),
                   (60,"MOM_60"),(120,"MOM_120"),(252,"MOM_252")]:
        p[name]=g["adj_close"].pct_change(n)
    p["VOL_10"]=r.groupby(p["symbol"]).rolling(10,min_periods=10).std().reset_index(level=0,drop=True)
    p["VOL_20"]=r.groupby(p["symbol"]).rolling(20,min_periods=20).std().reset_index(level=0,drop=True)
    p["HIGH52_RATIO"]=p["adj_close"]/g["adj_close"].rolling(252,min_periods=252).max().reset_index(level=0,drop=True)
    p["MAXDD_60"]=p["adj_close"]/g["adj_close"].rolling(60,min_periods=60).max().reset_index(level=0,drop=True)-1.0
    p["AVG_AMOUNT20"]=g["amount"].rolling(20,min_periods=20).mean().reset_index(level=0,drop=True)
    p["ADV20"]=p["AVG_AMOUNT20"]
    p["DIST_MA20"]=p["adj_close"]/g["adj_close"].rolling(20,min_periods=20).mean().reset_index(level=0,drop=True)-1.0
    p["DIST_MA60"]=p["adj_close"]/g["adj_close"].rolling(60,min_periods=60).mean().reset_index(level=0,drop=True)-1.0
    p["BREAKOUT20"]=p["adj_close"]/g["adj_close"].shift(1).rolling(20,min_periods=20).max().reset_index(level=0,drop=True)-1.0
    p["BREAKOUT55"]=p["adj_close"]/g["adj_close"].shift(1).rolling(55,min_periods=55).max().reset_index(level=0,drop=True)-1.0
    p["RSI14"]=g["adj_close"].apply(rsi).reset_index(level=0,drop=True)
    p["SKEW_20"]=r.groupby(p["symbol"]).rolling(20,min_periods=20).skew().reset_index(level=0,drop=True)
    p["SKEW_60"]=r.groupby(p["symbol"]).rolling(60,min_periods=60).skew().reset_index(level=0,drop=True)

    p["month_end"]=p["date"].dt.to_period("M").dt.to_timestamp("M")
    m=p.sort_values(["symbol","month_end","date"]).groupby(["symbol","month_end"],as_index=False).tail(1).copy()
    m=m.sort_values(["symbol","month_end"]).reset_index(drop=True)
    m["_next_month"]=m.groupby("symbol")["month_end"].shift(-1)
    m["_next_adj_close"]=m.groupby("symbol")["adj_close"].shift(-1)
    expected=m["month_end"]+pd.offsets.MonthEnd(1)
    m["fwd1"]=np.where(m["_next_month"].eq(expected),m["_next_adj_close"]/m["adj_close"]-1.0,np.nan)
    m.drop(columns=["_next_month","_next_adj_close"],inplace=True)
    keep=["symbol","month_end","date","adj_close"]+FACTORS+["fwd1"]
    for f in FACTORS:m[f]=pd.to_numeric(m[f],errors="coerce")
    out=m[keep].rename(columns={"date":"snapshot_date"}).sort_values(["month_end","symbol"]).reset_index(drop=True)
    o=Path(args.output);o.parent.mkdir(parents=True,exist_ok=True);out.to_csv(o,index=False)
    manifest={
      "engine":"luna-monthly-price-factor-library-v2",
      "input_sha256":hashlib.sha256(Path(args.prices).read_bytes()).hexdigest(),
      "output_sha256":hashlib.sha256(o.read_bytes()).hexdigest(),
      "rows":int(len(out)),"symbols":int(out.symbol.nunique()),"months":int(out.month_end.nunique()),
      "min_month":str(out.month_end.min().date()),"max_month":str(out.month_end.max().date()),
      "factors":FACTORS,
      "forward_return":"next calendar month-end only"
    }
    o.with_suffix(".manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    print(json.dumps(manifest,indent=2))

if __name__=="__main__":main()
