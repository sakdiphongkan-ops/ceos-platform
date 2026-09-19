#!/usr/bin/env python3
"""LUNA holdout audit for frozen formulas.

Selects top-N formulas using TRAINING months only, freezes the ranking,
then evaluates the same formulas on the final HOLDOUT months. M1 is
always included. No holdout return is used for selection.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
import numpy as np
import pandas as pd

FACTORS=["mom1","mom3","mom6","mom12","high52_ratio","vol20","maxdd60","avg_amount20"]

def geo(x):
    x=np.asarray(x,dtype=float)
    x=x[np.isfinite(x)]
    if len(x)==0 or np.any(x<=-1): return -1.0
    return float(np.exp(np.log1p(x).mean())-1)

def evaluate(df, formula, months, k, cost_bps):
    factor_pos={f:i for i,f in enumerate(FACTORS)}
    w=np.zeros(len(FACTORS))
    for f,v in formula["terms"]:
        w[factor_pos[f]]=float(v)
    R=np.stack([df.groupby("month_end")[f].rank(pct=True,method="average").to_numpy() for f in FACTORS],axis=1)
    valid=np.all(np.isfinite(R),axis=1) & np.isfinite(df.fwd1.to_numpy())
    df=df.loc[valid].reset_index(drop=True); R=R[valid]
    out=[]; prev=set()
    for m in months:
        ix=np.where(df.month_end.to_numpy()==m)[0]
        if len(ix)==0: continue
        score=R[ix]@w
        order=ix[np.argsort(-score,kind="mergesort")]
        chosen=order[:k]
        if len(chosen)==0: continue
        gross=float(np.nanmean(df.fwd1.iloc[chosen]))
        cur=set(df.symbol.iloc[chosen])
        turnover=1.0 if not prev else 1.0-len(cur&prev)/k
        cost=turnover*cost_bps/10000
        out.append((m,gross-turnover*cost_bps/10000,gross,turnover,cost))
        prev=cur
    return pd.DataFrame(out,columns=["month_end","net_return","gross_return","turnover","cost"]).set_index("month_end")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--catalog",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--holdout-months",type=int,default=12)
    ap.add_argument("--top-n",type=int,default=25)
    ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--cost-bps",type=float,default=20)
    args=ap.parse_args()
    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    df=pd.read_csv(args.input)
    req={"symbol","month_end","adj_close",*FACTORS}
    miss=sorted(req-set(df.columns))
    if miss: raise SystemExit(f"missing columns: {miss}")
    df["month_end"]=pd.to_datetime(df.month_end).dt.to_period("M").dt.to_timestamp("M")
    df=df.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"])
    df["adj_close"]=pd.to_numeric(df.adj_close,errors="coerce")
    df["_next_month"]=df.groupby("symbol").month_end.shift(-1)
    df["_next_adj_close"]=df.groupby("symbol").adj_close.shift(-1)
    expected=df.month_end+pd.offsets.MonthEnd(1)
    df["fwd1"]=np.where(df["_next_month"].eq(expected),
                        df["_next_adj_close"]/df.adj_close-1,np.nan)
    df.drop(columns=["_next_month","_next_adj_close"],inplace=True)
    for f in FACTORS: df[f]=pd.to_numeric(df[f],errors="coerce")
    months=sorted(df.month_end.dropna().unique())
    if len(months)<=args.holdout_months: raise SystemExit("not enough months")
    train_months=months[:-args.holdout_months]
    holdout_months=months[-args.holdout_months:]
    formulas=json.loads(Path(args.catalog).read_text(encoding="utf-8"))

    # Rank formulas on training only.
    train_scores=[]
    for formula in formulas:
        fr=evaluate(df,formula,train_months,args.k,args.cost_bps)
        r=fr.net_return.dropna()
        train_scores.append((geo(r),float((r>0).mean()),formula["id"]))
    train_scores.sort(key=lambda z:(-z[0],-z[1],z[2]))
    selected_ids={x[2] for x in train_scores[:args.top_n]}
    selected=[f for f in formulas if f["id"] in selected_ids]

    rows=[]
    for rank,(trgeo,trpos,fid) in enumerate(train_scores[:args.top_n],1):
        formula=next(f for f in selected if f["id"]==fid)
        h=evaluate(df,formula,holdout_months,args.k,args.cost_bps)
        r=h.net_return.dropna()
        rows.append({
            "training_rank":rank,"formula_id":fid,
            "training_geometric_monthly":trgeo,
            "training_positive_pct":trpos,
            "holdout_geometric_monthly":geo(r),
            "holdout_cumulative":float(np.prod(1+r)-1) if len(r) else -1,
            "holdout_positive_pct":float((r>0).mean()) if len(r) else 0,
            "holdout_max_drawdown_pct":float((np.cumprod(1+r)/np.maximum.accumulate(np.cumprod(1+r))-1).min()) if len(r) else None,
            "holdout_avg_turnover":float(h.turnover.mean()) if len(h) else 0
        })
    result=pd.DataFrame(rows).sort_values(["holdout_geometric_monthly","training_rank"],ascending=[False,True])
    result.to_csv(out/"holdout_ranked.csv",index=False)

    m1=next(f for f in formulas if f["id"]=="M1_REV_K20")
    m1tr=evaluate(df,m1,train_months,args.k,args.cost_bps).net_return.dropna()
    m1ho=evaluate(df,m1,holdout_months,args.k,args.cost_bps).net_return.dropna()
    winner=result.iloc[0].to_dict() if len(result) else None
    summary={
        "status":"COMPLETED","engine":"luna-holdout-audit-v1",
        "total_months":len(months),"training_months":len(train_months),
        "holdout_months":len(holdout_months),
        "training_end":str(train_months[-1]),"holdout_start":str(holdout_months[0]),
        "top_n_frozen":args.top_n,"k":args.k,"cost_bps":args.cost_bps,
        "winner_by_holdout_return":winner,
        "m1_training_geometric_monthly":geo(m1tr),
        "m1_holdout_geometric_monthly":geo(m1ho),
        "m1_holdout_cumulative":float(np.prod(1+m1ho)-1) if len(m1ho) else -1,
        "selection_guard":"formula ranking uses training months only; holdout returns never influence selection"
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__":
    main()
