#!/usr/bin/env python3
"""LUNA M1 x TradingView live research overlay.

This is a research dashboard only. It does not change the locked M1 strategy.
It joins the latest locked M1 basket with the current TradingView Thailand
screener snapshot and computes transparent candidate overlay features.
"""

from __future__ import annotations
import argparse
import os
from pathlib import Path
import pandas as pd
import requests

SUPA="https://wigzicwgcsrhdummrbjx.supabase.co"

def get_m1() -> pd.DataFrame:
    key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")
    if not key:
        raise SystemExit("SUPABASE_SERVICE_ROLE_KEY is required")
    url=SUPA + "/rest/v1/luna_strategy_monthly_holdings"
    params={
        "select":"month_end,symbol,rank_no,selection_score",
        "strategy_version":"eq.luna-m1s0k20rev-v1",
        "order":"month_end.desc,rank_no.asc",
        "limit":"20"
    }
    r=requests.get(url,params=params,headers={"apikey":key,"Authorization":"Bearer "+key},timeout=30)
    r.raise_for_status()
    x=pd.DataFrame(r.json())
    if x.empty:
        raise SystemExit("No locked M1 holdings returned")
    return x

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--snapshot",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)

    tv=pd.read_csv(args.snapshot)
    m1=get_m1()
    latest=pd.to_datetime(m1["month_end"]).max()
    m1=m1[pd.to_datetime(m1["month_end"]).eq(latest)].copy()

    # Normalize the key TradingView columns by interval.
    d=tv[tv["tv_interval"]=="1D"].copy()
    w=tv[tv["tv_interval"]=="1W"].copy()
    m=tv[tv["tv_interval"]=="1M"].copy()

    def pick(df,prefix):
        cols=[
            "symbol",
            "Recommend.Other"+prefix,
            "Recommend.All"+prefix,
            "Recommend.MA"+prefix,
            "RSI"+prefix,
            "MACD.macd"+prefix,
            "MACD.signal"+prefix,
            "ADX"+prefix,
            "Mom"+prefix
        ]
        keep=[c for c in cols if c in df.columns]
        return df[keep].drop_duplicates("symbol")

    d=pick(d,""); w=pick(w,"|1W"); m=pick(m,"|1M")
    x=m1[["symbol","rank_no","selection_score"]].merge(d,on="symbol",how="left")
    x=x.merge(w,on="symbol",how="left",suffixes=("","_W"))
    x=x.merge(m,on="symbol",how="left",suffixes=("","_M"))

    for c in x.columns:
        if c not in {"symbol"}:
            x[c]=pd.to_numeric(x[c],errors="ignore")

    # Transparent research features; no production decision is made here.
    x["tv_reversal_score"]=x["Recommend.Other"]-x["Recommend.MA"]
    x["tv_confirm_score"]=(
        0.40*x["Recommend.All"].fillna(0)
        +0.30*x.get("Recommend.All|1W",pd.Series(0,index=x.index)).fillna(0)
        +0.30*x.get("Recommend.All|1M",pd.Series(0,index=x.index)).fillna(0)
    )
    x["tv_oscillator_lead"]=(
        x["Recommend.Other"]>0.10
    ) & (x["Recommend.MA"]<0.10)
    x["tv_mtf_buy"]=(
        (x["Recommend.All"]>0.10)
        & (x.get("Recommend.All|1W",pd.Series(float("nan"),index=x.index))>0.10)
        & (x.get("Recommend.All|1M",pd.Series(float("nan"),index=x.index))>0.10)
    )

    # Stable sorting for audit; this is not a recommendation score.
    x=x.sort_values(["tv_confirm_score","tv_reversal_score","rank_no"],ascending=[False,False,True])
    x.insert(0,"m1_latest_month",latest.date().isoformat())
    x.to_csv(out/"m1_tradingview_overlay.csv",index=False)

    summary={
        "latest_m1_month":latest.date().isoformat(),
        "m1_names":int(len(x)),
        "matched_tradingview_1d":int(x["Recommend.All"].notna().sum()),
        "matched_tradingview_1w":int(x.get("Recommend.All|1W",pd.Series()).notna().sum()),
        "matched_tradingview_1m":int(x.get("Recommend.All|1M",pd.Series()).notna().sum()),
        "research_only":True,
        "production_changed":False,
    }
    pd.Series(summary).to_json(out/"summary.json",indent=2)

if __name__=="__main__":
    main()
