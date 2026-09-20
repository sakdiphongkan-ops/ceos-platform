#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd

def geo(a):
    a=np.asarray(a,dtype=float);a=a[np.isfinite(a)]
    if len(a)==0 or np.any(a<=-1):return -1.0
    return float(np.expm1(np.log1p(a).mean()))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True);ap.add_argument("--catalog",required=True);ap.add_argument("--output",required=True)
    ap.add_argument("--holdout-months",type=int,default=12);ap.add_argument("--lookback-months",type=int,default=24)
    ap.add_argument("--top-n",type=int,default=25);ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--cost-bps",type=float,default=20);ap.add_argument("--stress-bps",default="0,20,45,60")
    a=ap.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    d=pd.read_csv(a.input);cat=json.loads(Path(a.catalog).read_text())
    factors=sorted({f for x in cat for f,_ in x["terms"]})
    need={"symbol","month_end","fwd1",*factors}
    miss=sorted(need-set(d.columns))
    if miss:raise SystemExit(f"missing columns: {miss}")
    d["month_end"]=pd.to_datetime(d.month_end);d["symbol"]=d.symbol.astype(str)
    for c in ["fwd1",*factors]:d[c]=pd.to_numeric(d[c],errors="coerce")
    d=d.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"])
    d=d.dropna(subset=factors).reset_index(drop=True)
    months=sorted(d.month_end.unique().tolist())
    if len(months)<=a.holdout_months+a.lookback_months:raise SystemExit("insufficient months")
    rows={m:d.index[d.month_end.eq(m)].to_numpy() for m in months}
    ranks={f:d.groupby("month_end")[f].rank(pct=True,method="average").to_numpy() for f in factors}
    pos={f:i for i,f in enumerate(factors)}
    candidate={}
    for fml in cat:
        w=np.zeros(len(factors))
        for f,v in fml["terms"]:w[pos[f]]=v
        rr=[];prev=set()
        for m in months:
            ix=rows[m];score=np.zeros(len(ix))
            for f,v in fml["terms"]:score+=ranks[f][ix]*v
            chosen=ix[np.argsort(-score,kind="mergesort")[:a.k]]
            chosen=chosen[d.loc[chosen,"fwd1"].notna().to_numpy()]
            if len(chosen)==0:continue
            cur=set(d.loc[chosen,"symbol"]);gross=float(d.loc[chosen,"fwd1"].mean())
            overlap=len(cur&prev);turn=1 if not prev else 1-overlap/a.k
            cost=turn*a.cost_bps/10000
            rr.append((m,gross,gross-cost,turn));prev=cur
        candidate[fml["id"]]=pd.DataFrame(rr,columns=["month_end","gross","net","turnover"]).set_index("month_end")
    ho=set(months[-a.holdout_months:])
    tr=[m for m in months if m not in ho]
    train=tr[-a.lookback_months:]
    ranked=[]
    for fid,fr in candidate.items():
        h=fr.reindex(train).net.dropna()
        if len(h)>=max(12,min(a.lookback_months,len(train))):
            ranked.append((geo(h.tolist()),float((h>0).mean()),fid))
    ranked.sort(key=lambda z:(-z[0],-z[1],z[2]))
    frozen=ranked[:a.top_n]
    if not any(x[2]=="M1_REV21_K20" for x in frozen):
        frozen.append(next(x for x in ranked if x[2]=="M1_REV21_K20"))
    outrows=[]
    for rank,(tg,tp,fid) in enumerate(frozen,1):
        fr=candidate[fid]
        for bps in [float(x) for x in a.stress_bps.split(",")]:
            gross=[];net=[];prev=set()
            for m in months:
                if m not in ho or m not in fr.index:continue
                rr=fr.loc[m]; gross.append(float(rr.gross))
                # Recompute cost at the requested stress level using stored turnover.
                net.append(float(rr.gross)-float(rr.turnover)*bps/10000)
            eq=np.cumprod(1+np.asarray(net)) if net else np.array([])
            dd=(eq/np.maximum.accumulate(eq)-1).min() if len(eq) else None
            outrows.append({"train_rank":rank,"formula_id":fid,"train_geo":tg,"train_positive":tp,
              "stress_cost_bps":bps,"holdout_months":len(net),
              "holdout_geo":geo(net),"holdout_cumulative":float(eq[-1]-1) if len(eq) else None,
              "holdout_positive_pct":float((np.asarray(net)>0).mean()) if net else None,
              "holdout_months_ge_7pct":int((np.asarray(net)>=.07).sum()) if net else 0,
              "holdout_max_drawdown":float(dd) if dd is not None else None})
    res=pd.DataFrame(outrows);res.to_csv(out/"holdout_ranked.csv",index=False)
    summary={"status":"COMPLETED","engine":"luna-frozen-holdout-v2","holdout_months":a.holdout_months,
      "training_months_used":train,"frozen_top_n":a.top_n,"m1_included":True,
      "stress_bps":[float(x) for x in a.stress_bps.split(",")],"selection_blind_to_holdout":True,
      "rank_rule":"training geometric return over trailing lookback, then positive-month ratio",
      "note":"Holdout results are descriptive; no holdout metric is used to choose the frozen candidates."}
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__":main()
