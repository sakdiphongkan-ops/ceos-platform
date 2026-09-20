#!/usr/bin/env python3
"""LUNA benchmark pack: locked M1 + documented prior leaders under one standardized test.

Standard panel:
- monthly rebalance
- equal-weight Top-20
- next-calendar-month forward return only
- turnover cost applied as turnover * cost_bps
- dynamic available universe from the input dataset
- 0/20/50 bps stress
- candidates are reconstructed from documented historical formula descriptions
  when the original coefficient table is unavailable.

This is deliberately separate from the legacy M1 production series.
"""
from __future__ import annotations
import argparse, json, math
from pathlib import Path
import numpy as np
import pandas as pd

BASE_FACTORS=["mom1","mom3","mom6","mom12","high52_ratio","vol20","avg_amount20"]

CANDIDATES=[
  {"id":"M1_REV_K20","type":"single","factor":"mom1","sign":-1.0,
   "provenance":"Locked M1 family: 1-month cross-sectional reversal; exact legacy production benchmark is reported separately."},
  {"id":"M2_REV_K20","type":"backward_return","months":2,"sign":-1.0,
   "provenance":"Previous M2 2-month reversal production candidate."},
  {"id":"S13_HIGHAMT_K20","type":"single","factor":"avg_amount20","sign":1.0,
   "provenance":"Historical S13_HIGHAMT_K5_H3 leader; standardized here to K20/1M."},
  {"id":"S14_LOWAMT_K20","type":"single","factor":"avg_amount20","sign":-1.0,
   "provenance":"Historical S14_LOWAMT_K5_H6 screen leader; standardized here to K20/1M."},
  {"id":"S46_MOM6_HIGH52_LOWVOL_K20","type":"blend3","provenance":"Historical S46_MOM6_HIGH52_LOWVOL_K10_H6 leader; reconstructed as equal percentile-rank blend and standardized to K20/1M."},
  {"id":"S48_MOM12_HIGH52_LOWVOL_K20","type":"blend3","provenance":"Historical S48_MOM12_HIGH52_LOWVOL_K10_H6 leader; reconstructed as equal percentile-rank blend and standardized to K20/1M."},
  {"id":"HIGH52_K20","type":"single","factor":"high52_ratio","sign":1.0,
   "provenance":"Historical HIGH52 family; standardized here to K20/1M."},
]

def geo(x):
    x=pd.Series(x,dtype=float).dropna()
    return float(np.expm1(np.log1p(x).mean())) if len(x) and (x>-1).all() else -1.0

def stats(x):
    x=pd.Series(x,dtype=float).dropna()
    if not len(x):
        return {"months":0,"geometric_monthly_return":-1.0,"cumulative_return":-1.0}
    eq=30000.0*(1+x).cumprod()
    peak=eq.cummax()
    dd=eq/peak-1.0
    return {
      "months":int(len(x)),
      "geometric_monthly_return":geo(x),
      "cumulative_return":float(eq.iloc[-1]/30000.0-1.0),
      "positive_month_pct":float((x>0).mean()),
      "months_ge_7pct":int((x>=0.07).sum()),
      "min_monthly_return":float(x.min()),
      "max_monthly_return":float(x.max()),
      "max_drawdown_pct":float(dd.min()),
      "final_baht":float(eq.iloc[-1]),
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--cost-bps",default="0,20,50")
    args=ap.parse_args()

    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    df=pd.read_csv(args.input)
    required={"symbol","month_end","adj_close",*BASE_FACTORS}
    missing=sorted(required-set(df.columns))
    if missing:
        # maxdd60 is intentionally NOT required: persisted Supabase table currently has 0 non-null values for it.
        hard=sorted(set(missing)-{"maxdd60"})
        if hard: raise SystemExit(f"missing columns: {hard}")

    df["month_end"]=pd.to_datetime(df["month_end"]).dt.to_period("M").dt.to_timestamp("MS")
    df=df.sort_values(["symbol","month_end"]).drop_duplicates(["symbol","month_end"]).reset_index(drop=True)
    df["adj_close"]=pd.to_numeric(df["adj_close"],errors="coerce")
    for f in BASE_FACTORS: df[f]=pd.to_numeric(df[f],errors="coerce")

    # Strict next-calendar-month return.
    next_m=df.groupby("symbol")["month_end"].shift(-1)
    next_px=df.groupby("symbol")["adj_close"].shift(-1)
    expected=df["month_end"]+pd.offsets.MonthBegin(1)
    df["fwd1"]=np.where(next_m.eq(expected),next_px/df["adj_close"]-1.0,np.nan)
    # Two-month backward return for M2.
    prev2=df.groupby("symbol")["adj_close"].shift(2)
    df["mom2"]=df["adj_close"]/prev2-1.0

    months=sorted(df.loc[df["fwd1"].notna(),"month_end"].unique())
    records=[]

    for c in CANDIDATES:
        monthly=[]
        prev_symbols=set()
        for m in months:
            g=df[(df["month_end"]==m)&df["fwd1"].notna()].copy()
            if c["type"]=="single":
                factor=c["factor"]
                g=g[g[factor].notna()]
                if not len(g): continue
                g["score"]=c["sign"]*g[factor]
            elif c["type"]=="backward_return":
                g=g[g["mom2"].notna()]
                if not len(g): continue
                g["score"]=c["sign"]*g["mom2"]
            else:
                fs=("mom6","high52_ratio","vol20") if c["id"].startswith("S46") else ("mom12","high52_ratio","vol20")
                g=g.dropna(subset=list(fs))
                if not len(g): continue
                ranks=[g[f].rank(pct=True,method="average") for f in fs]
                g["score"]=(ranks[0]+ranks[1]+(1.0-ranks[2]))/3.0

            g=g.sort_values(["score","symbol"],ascending=[False,True]).head(args.k)
            cur=set(g["symbol"])
            overlap=len(cur&prev_symbols)
            turnover=1.0 if not prev_symbols else 1.0-overlap/float(args.k)
            gross=float(g["fwd1"].mean())
            records.append((c["id"],m,gross,turnover))
            prev_symbols=cur

    r=pd.DataFrame(records,columns=["candidate_id","month_end","gross_return","turnover"])
    r["month_end"]=pd.to_datetime(r["month_end"])
    rows=[]
    for c in CANDIDATES:
        base=r[r.candidate_id==c["id"]].copy()
        for cost_bps in map(float,args.cost_bps.split(",")):
            z=base.copy()
            z["transaction_cost"]=z["turnover"]*cost_bps/10000.0
            z["net_return"]=z["gross_return"]-z["transaction_cost"]
            s=stats(z["net_return"])
            rows.append({
              "candidate_id":c["id"],"cost_bps":cost_bps,
              **s,
              "average_turnover":float(z["turnover"].mean()),
              "total_transaction_cost":float(z["transaction_cost"].sum()),
              "months_start":str(z["month_end"].min().date()),
              "months_end":str(z["month_end"].max().date()),
            })
    summary={
      "status":"COMPLETED",
      "engine":"luna-benchmark-pack-v1",
      "methodology":{
        "rebalance":"monthly",
        "portfolio":"equal-weight Top-K",
        "k":args.k,
        "forward_return_guard":"next observation must be exactly the next calendar month",
        "cost_model":"turnover * cost_bps / 10000",
        "stress_cost_bps":[float(x) for x in args.cost_bps.split(",")],
        "note":"Historical leaders are standardized to one common K20/1M panel. Their native historical K/H results are retained as provenance, not mixed into the standardized score."
      },
      "candidates":CANDIDATES,
      "results":rows,
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    r.to_csv(out/"candidate-monthly.csv",index=False)
    pd.DataFrame(rows).to_csv(out/"candidate-results.csv",index=False)

if __name__=="__main__":
    main()
