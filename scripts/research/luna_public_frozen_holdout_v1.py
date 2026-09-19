#!/usr/bin/env python3
"""Frozen holdout audit for LUNA public monthly tournament results.

Top formulas are selected using TRAIN months only. The final HOLDOUT months are
never used for ranking or parameter selection. M1_REV_K20 is always evaluated.
"""

from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

FACTORS=["MOM_5","MOM_10","MOM_20","MOM_60","MOM_120","VOL_10","VOL_20","MAXDD_60","ADV20","AMOUNT","BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60","SKEW_20","SKEW_60","QUALITY_SCORE","VALUE_QUALITY","MOM_BLEND","CONSERVATIVE_SCORE","SAFETY_SCORE","GROWTH_QUALITY","INV_QUALITY"]

def geo(x):
    x=np.asarray(x,dtype=float); x=x[np.isfinite(x)]
    if len(x)==0 or np.any(x<=-1): return -1.0
    return float(np.exp(np.log1p(x).mean())-1)

def formulas(count,seed):
    rng=np.random.default_rng(seed)
    out=[{"id":"M1_REV_K20","terms":[("MOM_20",-1.0)]}]
    for i in range(1,count):
        n=int(rng.integers(2,5))
        inds=rng.choice(len(FACTORS),size=n,replace=False)
        raw=rng.uniform(0.25,1.0,size=n)
        signs=rng.choice([-1.0,1.0],size=n)
        w=raw*signs; w=w/np.sum(np.abs(w))
        out.append({"id":f"F{i:04d}","terms":[(FACTORS[j],float(v)) for j,v in zip(inds,w)]})
    return out

def stats(x,capital=30000.0):
    x=np.asarray(x,dtype=float); x=x[np.isfinite(x)]
    if len(x)==0:return {"months":0,"geometric_monthly_return":-1,"cumulative_return":-1,"positive_month_pct":0,"max_drawdown_pct":None}
    eq=capital*np.cumprod(1+x); peak=np.maximum.accumulate(eq)
    return {"months":int(len(x)),"geometric_monthly_return":geo(x),"cumulative_return":float(eq[-1]/capital-1),"positive_month_pct":float((x>0).mean()),"months_ge_7pct":int((x>=.07).sum()),"max_drawdown_pct":float(np.min(eq/peak-1))}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True); ap.add_argument("--output",required=True)
    ap.add_argument("--formula-count",type=int,default=1000); ap.add_argument("--seed",type=int,default=20260920)
    ap.add_argument("--holdout-months",type=int,default=12); ap.add_argument("--train-months",type=int,default=36)
    ap.add_argument("--top-n",type=int,default=25); ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--cost-bps",default="0,20,40,60")
    args=ap.parse_args()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    df=pd.read_csv(args.input)
    req={"symbol","month_end","fwd1",*FACTORS}
    miss=sorted(req-set(df.columns))
    if miss:raise SystemExit(f"missing columns: {miss}")
    df["month_end"]=pd.to_datetime(df["month_end"]); df=df.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"])
    for f in FACTORS:df[f]=pd.to_numeric(df[f],errors="coerce")
    df["fwd1"]=pd.to_numeric(df["fwd1"],errors="coerce")
    df=df.dropna(subset=FACTORS+["fwd1"]).copy()
    months=sorted(df.month_end.unique())
    if len(months)<=args.holdout_months+args.train_months:raise SystemExit("not enough months")
    hold=months[-args.holdout_months:]; train=months[-args.holdout_months-args.train_months:-args.holdout_months]
    formulas_list=formulas(args.formula_count,args.seed)

    ranks={f:df.groupby("month_end")[f].rank(pct=True,method="average").to_numpy() for f in FACTORS}
    df["_row"]=np.arange(len(df)); idx_by_month={m:np.where(df.month_end.to_numpy()==m)[0] for m in months}
    sym=df.symbol.to_numpy(); y=df.fwd1.to_numpy()
    cat={f["id"]:f for f in formulas_list}

    def formula_returns(formula_id,cost_bps,months_subset):
        formula=cat[formula_id]; prev=set(); rows=[]
        weights={f:v for f,v in formula["terms"]}
        for m in months_subset:
            ix=idx_by_month[m]
            score=np.zeros(len(ix))
            for f,v in weights.items(): score += ranks[f][ix]*v
            order=ix[np.argsort(-score,kind="mergesort")][:args.k]
            if len(order)<args.k: continue
            cur=set(sym[order]); overlap=len(cur&prev)
            turnover=1.0 if not prev else 1.0-overlap/args.k
            gross=float(np.nanmean(y[order])); cost=turnover*cost_bps/10000
            rows.append((m,gross-turnover*cost_bps/10000))
            prev=cur
        return pd.Series(dict(rows)).reindex(months_subset)

    train_scores=[]
    for f in formulas_list:
        s=formula_returns(f["id"],20,train).dropna()
        train_scores.append((geo(s),float((s>0).mean()),f["id"]))
    train_scores.sort(key=lambda z:(-z[0],-z[1],z[2]))
    frozen=[x[2] for x in train_scores[:args.top_n]]

    rows=[]
    for cost_s in args.cost_bps.split(","):
        cb=float(cost_s)
        for rank,fid in enumerate(frozen,1):
            h=formula_returns(fid,cb,hold).dropna()
            tr=formula_returns(fid,cb,train).dropna()
            s=stats(h)
            rows.append({"cost_bps":cb,"train_rank":rank,"formula_id":fid,"train_geo":geo(tr),"holdout_geo":s["geometric_monthly_return"],"holdout_cumulative":s["cumulative_return"],"holdout_positive_month_pct":s["positive_month_pct"],"holdout_months_ge_7pct":s["months_ge_7pct"],"holdout_max_drawdown_pct":s["max_drawdown_pct"]})
        # M1 benchmark is independent of frozen selection.
        h=formula_returns("M1_REV_K20",cb,hold).dropna()
        s=stats(h)
        rows.append({"cost_bps":cb,"train_rank":None,"formula_id":"M1_REV_K20","train_geo":geo(formula_returns("M1_REV_K20",cb,train).dropna()),"holdout_geo":s["geometric_monthly_return"],"holdout_cumulative":s["cumulative_return"],"holdout_positive_month_pct":s["positive_month_pct"],"holdout_months_ge_7pct":s["months_ge_7pct"],"holdout_max_drawdown_pct":s["max_drawdown_pct"]})
    result=pd.DataFrame(rows); result.to_csv(out/"holdout-ranked.csv",index=False)
    summary={"status":"COMPLETED","engine":"luna-public-frozen-holdout-v1","dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),"formula_count":len(formulas_list),"train_period":[str(train[0]),str(train[-1])],"holdout_period":[str(hold[0]),str(hold[-1])],"train_months":len(train),"holdout_months":len(hold),"top_n_frozen":args.top_n,"cost_bps_tested":[float(x) for x in args.cost_bps.split(",")],"selection_rule":"rank on train geometric monthly return only; holdout excluded from selection","frozen_top25":frozen,"m1_included":True}
    (out/"summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")
    print(json.dumps(summary,indent=2))

if __name__=="__main__":main()
