#!/usr/bin/env python3
"""LUNA Adaptive Tournament v4: expanded price-factor search with locked M1 REV21 K20."""
from __future__ import annotations
import argparse, hashlib, json
from collections import Counter
from pathlib import Path
import numpy as np
import pandas as pd

ALL_FACTORS=[
    "REV21","MOM_5","MOM_10","MOM_20","MOM_60","MOM_120","MOM_252",
    "VOL_10","VOL_20","MAXDD_60","ADV20","AVG_AMOUNT20","HIGH52_RATIO",
    "BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60","SKEW_20","SKEW_60"
]

def geo(x):
    x=np.asarray(x,dtype=float);x=x[np.isfinite(x)]
    if len(x)==0 or np.any(x<=-1):return -1.0
    return float(np.expm1(np.log1p(x).mean()))

def perf(x):
    x=pd.Series(x,dtype=float).dropna()
    if x.empty:
        return {"months":0,"geometric_monthly_return":-1.0,"cumulative_return":-1.0,
        "positive_month_pct":0.0,"months_ge_7pct":0,"min_monthly_return":None,
        "max_monthly_return":None,"max_drawdown_pct":None,"final_baht":30000.0}
    eq=30000*np.cumprod(1+x.to_numpy());peak=np.maximum.accumulate(eq);dd=eq/peak-1
    return {"months":int(len(x)),"geometric_monthly_return":geo(x),
      "cumulative_return":float(eq[-1]/30000-1),"positive_month_pct":float((x>0).mean()),
      "months_ge_7pct":int((x>=.07).sum()),"min_monthly_return":float(x.min()),
      "max_monthly_return":float(x.max()),"max_drawdown_pct":float(dd.min()),"final_baht":float(eq[-1])}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True);ap.add_argument("--output",required=True)
    ap.add_argument("--formula-count",type=int,default=1000);ap.add_argument("--seed",type=int,default=20260920)
    ap.add_argument("--lookback-months",type=int,default=24);ap.add_argument("--min-history-months",type=int,default=12)
    ap.add_argument("--cost-bps",type=float,default=20);ap.add_argument("--k",type=int,default=20)
    args=ap.parse_args();out=Path(args.output);out.mkdir(parents=True,exist_ok=True)

    d=pd.read_csv(args.input);req={"symbol","month_end","adj_close","fwd1",*ALL_FACTORS};miss=sorted(req-set(d.columns))
    if miss:raise SystemExit(f"missing columns: {miss}")
    d["month_end"]=pd.to_datetime(d["month_end"]);d["symbol"]=d["symbol"].astype(str)
    for c in ["adj_close","fwd1",*ALL_FACTORS]:d[c]=pd.to_numeric(d[c],errors="coerce")
    d=d.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"]).reset_index(drop=True)
    coverage={f:float(d[f].notna().mean()) for f in ALL_FACTORS}
    active=[f for f in ALL_FACTORS if coverage[f]>=0.20]
    if "REV21" not in active:raise SystemExit("REV21 coverage below 20%")
    d=d[d["adj_close"].notna()].copy().reset_index(drop=True)
    months=sorted(d["month_end"].dropna().unique())
    if len(months)<40:raise SystemExit(f"only {len(months)} months")

    ranks={f:d.groupby("month_end")[f].rank(pct=True,method="average").to_numpy() for f in active}
    rng=np.random.default_rng(args.seed)
    formulas=[{"id":"M1_REV21_K20","terms":[("REV21",-1.0)]}]
    for i in range(1,args.formula_count):
        n=int(rng.integers(2,min(6,len(active)+1)))
        idx=rng.choice(len(active),size=n,replace=False)
        raw=rng.uniform(.20,1.0,size=n)*rng.choice([-1.,1.],size=n)
        raw=raw/np.sum(np.abs(raw))
        formulas.append({"id":f"F{i:04d}","terms":[(active[j],float(w)) for j,w in zip(idx,raw)]})
    (out/"formula_catalog.json").write_text(json.dumps(formulas,indent=2),encoding="utf-8")

    months_idx={m:np.where(d["month_end"].eq(m).to_numpy())[0] for m in months}
    sym=d["symbol"].to_numpy(); y=d["fwd1"].to_numpy(dtype=float)
    returns={};ledgers={}
    fpos={f:i for i,f in enumerate(active)}

    for formula in formulas:
        w=np.zeros(len(active))
        for f,v in formula["terms"]:w[fpos[f]]=v
        prev=set();rows=[]
        for m in months:
            ix=months_idx[m];score=np.zeros(len(ix),dtype=float)
            finite=np.ones(len(ix),dtype=bool)
            for f,v in formula["terms"]:
                rr=ranks[f][ix];finite &= np.isfinite(rr);score += np.nan_to_num(rr,nan=0.0)*v
            fwd=y[ix];finite &= np.isfinite(fwd)
            if finite.sum()<args.k:continue
            vi=ix[finite];vs=score[finite];vf=fwd[finite]
            order=np.argsort(-vs,kind="mergesort")[:args.k];chosen=vi[order]
            gross=float(np.mean(vf[order]));cur=set(sym[chosen]);overlap=len(cur&prev)
            turnover=1.0 if not prev else 1.0-overlap/args.k
            cost=turnover*args.cost_bps/10000
            rows.append({"month_end":m,"gross_return":gross,"turnover":turnover,"transaction_cost":cost,"net_return":gross-cost})
            prev=cur
        ledgers[formula["id"]]=pd.DataFrame(rows).set_index("month_end")
        returns[formula["id"]]=ledgers[formula["id"]]["net_return"]

    selections=[];freq=Counter()
    for i,m in enumerate(months):
        prior=months[max(0,i-args.lookback_months):i]
        if len(prior)<args.min_history_months:continue
        eligible=[]
        for fid,fr in returns.items():
            h=fr.reindex(prior).dropna()
            if len(h)>=args.min_history_months:eligible.append((geo(h),float((h>0).mean()),fid))
        eligible.sort(key=lambda z:(-z[0],-z[1],z[2]))
        if not eligible or m not in ledgers[eligible[0][2]].index:continue
        sg,sp,fid=eligible[0];r=ledgers[fid].loc[m]
        selections.append({"month_end":m,"history_start":prior[0],"history_end":prior[-1],"formula_id":fid,
        "selected_geo":sg,"selected_positive":sp,"gross_return":float(r.gross_return),
        "turnover":float(r.turnover),"transaction_cost":float(r.transaction_cost),"realized_return":float(r.net_return)})
        freq[fid]+=1

    ledger=pd.DataFrame(selections);ledger.to_csv(out/"selection-ledger.csv",index=False)
    adaptive=perf(ledger["realized_return"] if len(ledger) else [])
    benchmark=perf(returns["M1_REV21_K20"])
    summary={
      "status":"COMPLETED","engine":"luna-adaptive-tournament-v4",
      "dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
      "formula_count":len(formulas),"seed":args.seed,"k":args.k,"cost_bps":args.cost_bps,
      "lookback_months":args.lookback_months,"min_history_months":args.min_history_months,
      "months_available":len(months),"months_traded":int(len(ledger)),
      "active_factors":active,"factor_coverage":coverage,
      "adaptive":adaptive,"benchmark_m1_rev21_k20":benchmark,
      "top_selected_formulas":dict(freq.most_common(20)),
      "leakage_guard":"selection for month t uses only strictly earlier calendar months",
      "data_contiguity_guard":"fwd1 is valid only for exact next calendar month",
      "benchmark_note":"M1_REV21_K20 is the closest public-data proxy to the legacy 21-trading-day reversal construction; public dataset universe is not the legacy 925-symbol universe.",
      "initial_capital_baht":30000
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__":main()
