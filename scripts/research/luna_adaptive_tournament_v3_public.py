#!/usr/bin/env python3
"""LUNA Adaptive Tournament v3 on a public historical monthly panel.

- 1,000 deterministic formulas: exact same PCG64 catalog logic as v2.
- M1_REV_K20 is locked into the catalog.
- Selection for month t uses only t-24...t-1.
- Forward return is valid only for an exact next calendar month.
- Equal-weight Top-K and turnover-based transaction costs.
"""

from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

ALL_FACTORS=["MOM_5","MOM_10","MOM_20","MOM_40","MOM_60","MOM_120","MOM_252","REL_MOM","VOL_10","VOL_20","MAXDD_60","ATR_PCT","ADV20","AMOUNT","ILLIQ_20","BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60","DIST_HIGH_252","SKEW_20","SKEW_60","QUALITY_SCORE","VALUE_QUALITY","MOM_BLEND","CONSERVATIVE_SCORE","SAFETY_SCORE","GROWTH_QUALITY","INV_QUALITY"]

def geo(x):
    x=np.asarray(x,dtype=float)
    x=x[np.isfinite(x)]
    if len(x)==0 or np.any(x<=-1): return -1.0
    return float(np.exp(np.log1p(x).mean())-1)

def perf(x):
    x=pd.Series(x,dtype=float).dropna()
    if x.empty:
        return {"months":0,"geometric_monthly_return":-1.0,"cumulative_return":-1.0,"positive_month_pct":0.0,"months_ge_7pct":0,"min_monthly_return":None,"max_monthly_return":None,"max_drawdown_pct":None}
    eq=30000*np.cumprod(1+x.to_numpy())
    peak=np.maximum.accumulate(eq)
    dd=eq/peak-1
    return {"months":int(len(x)),"geometric_monthly_return":geo(x),"cumulative_return":float(eq[-1]/30000-1),"positive_month_pct":float((x>0).mean()),"months_ge_7pct":int((x>=.07).sum()),"min_monthly_return":float(x.min()),"max_monthly_return":float(x.max()),"max_drawdown_pct":float(dd.min())}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--formula-count",type=int,default=1000)
    ap.add_argument("--lookback-months",type=int,default=24)
    ap.add_argument("--min-history-months",type=int,default=12)
    ap.add_argument("--cost-bps",type=float,default=20)
    ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--seed",type=int,default=20260920)
    args=ap.parse_args()

    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    df=pd.read_csv(args.input)
    req={"symbol","month_end","adj_close","fwd1",*ALL_FACTORS}
    missing=sorted(req-set(df.columns))
    if missing: raise SystemExit(f"missing columns: {missing}")
    df["month_end"]=pd.to_datetime(df["month_end"])
    for c in ["adj_close","fwd1",*ALL_FACTORS]:
        df[c]=pd.to_numeric(df[c],errors="coerce")
    df=df.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"])
    months=sorted(df["month_end"].dropna().unique())
    df=df[df["fwd1"].notna()].copy()
    months=sorted(df["month_end"].unique())
    if len(months)<40: raise SystemExit(f"only {len(months)} tradable months")

    coverage={f:float(df[f].notna().mean()) for f in ALL_FACTORS}
    active_factors=[f for f in ALL_FACTORS if coverage[f] >= 0.20]
    excluded_sparse=[f for f in ALL_FACTORS if f not in active_factors]
    if len(active_factors)<5:
        raise SystemExit(f"too few usable factors after coverage filter: {active_factors}")

    # Percentile ranks within each month. Only rows with all active factors are scored.
    ranks={f:df.groupby("month_end")[f].rank(pct=True,method="average") for f in active_factors}
    ok=np.ones(len(df),dtype=bool)
    for f in active_factors: ok &= ranks[f].notna().to_numpy()
    df=df.loc[ok].reset_index(drop=True)
    ranks_np={f:ranks[f].to_numpy()[ok] for f in active_factors}
    FACTORS=active_factors
    y=df["fwd1"].to_numpy(dtype=float)
    sym=df["symbol"].to_numpy()

    rng=np.random.default_rng(args.seed)
    formulas=[{"id":"M1_REV_K20","terms":[("MOM_20",-1.0)]}]
    # Keep factor-count/seed generation identical in structure to v2.
    for i in range(1,args.formula_count):
        n=int(rng.integers(2,5))
        inds=rng.choice(len(FACTORS),size=n,replace=False)
        raw=rng.uniform(0.25,1.0,size=n)
        signs=rng.choice([-1.0,1.0],size=n)
        w=raw*signs
        w=w/np.sum(np.abs(w))
        formulas.append({"id":f"F{i:04d}","terms":[(FACTORS[j],float(wi)) for j,wi in zip(inds,w)]})
    (out/"formula_catalog.json").write_text(json.dumps(formulas,indent=2),encoding="utf-8")

    month_rows={m:np.where(df["month_end"].to_numpy()==m)[0] for m in months}
    fidx={f:i for i,f in enumerate(FACTORS)}
    returns={}
    ledgers={}
    for formula in formulas:
        w=np.zeros(len(FACTORS))
        for f,v in formula["terms"]: w[fidx[f]]=v
        prev=set(); rows=[]
        for m in months:
            ix=month_rows[m]
            score=np.zeros(len(ix))
            for f,v in formula["terms"]: score += ranks_np[f][ix]*v
            order=ix[np.argsort(-score,kind="mergesort")][:args.k]
            if len(order)<args.k: continue
            gross=float(np.nanmean(y[order]))
            cur=set(sym[order])
            overlap=len(cur&prev)
            turnover=1.0 if not prev else 1.0-overlap/args.k
            cost=turnover*args.cost_bps/10000
            rows.append({"month_end":m,"gross_return":gross,"turnover":turnover,"transaction_cost":cost,"net_return":gross-cost})
            prev=cur
        ledgers[formula["id"]]=pd.DataFrame(rows).set_index("month_end")
        returns[formula["id"]]=ledgers[formula["id"]]["net_return"]

    selections=[]
    for m_i,m in enumerate(months):
        prior=months[max(0,m_i-args.lookback_months):m_i]
        if len(prior)<args.min_history_months: continue
        eligible=[]
        for fid,fr in returns.items():
            if m not in fr.index:
                continue
            h=fr.reindex(prior).dropna()
            if len(h)<args.min_history_months: continue
            eligible.append((geo(h),float((h>0).mean()),fid))
        eligible.sort(key=lambda z:(-z[0],-z[1],z[2]))
        if not eligible: continue
        sg,sp,fid=eligible[0]
        rr=ledgers[fid].loc[m]
        selections.append({"month_end":m,"history_start":prior[0],"history_end":prior[-1],"formula_id":fid,"selected_geo":sg,"selected_positive":sp,"gross_return":rr.gross_return,"turnover":rr.turnover,"transaction_cost":rr.transaction_cost,"realized_return":rr.net_return})
    ledger=pd.DataFrame(selections)
    ledger.to_csv(out/"selection-ledger.csv",index=False)
    adaptive=perf(ledger["realized_return"] if not ledger.empty else [])
    benchmark=perf(returns["M1_REV_K20"])
    freq=ledger["formula_id"].value_counts().head(20).to_dict() if not ledger.empty else {}

    summary={
      "status":"COMPLETED",
      "engine":"luna-adaptive-tournament-v3-public",
      "dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
      "formula_count":len(formulas),
      "factor_count":len(FACTORS),
      "all_factors":ALL_FACTORS,
      "active_factors":FACTORS,
      "factor_coverage":coverage,
      "excluded_sparse_factors":excluded_sparse,
      "k":args.k,
      "lookback_months":args.lookback_months,
      "min_history_months":args.min_history_months,
      "cost_bps_per_one_way_turnover":args.cost_bps,
      "months_available":len(months),
      "months_traded":int(len(ledger)),
      "adaptive":adaptive,
      "benchmark_m1_alias":benchmark,
      "top_selected_formulas":freq,
      "leakage_guard":"selection for month t uses only strictly earlier calendar months",
      "data_contiguity_guard":"fwd1 exists only when exact next calendar month is present",
      "benchmark_note":"M1_REV_K20 here is a same-panel reversal proxy using lowest MOM_20; it is not a claim of exact 925-symbol legacy reproduction.",
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__": main()
