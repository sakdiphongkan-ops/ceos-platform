#!/usr/bin/env python3
from __future__ import annotations
import argparse,hashlib,json
from collections import Counter
from pathlib import Path
import numpy as np
import pandas as pd

FACTORS=["REV21","MOM_5","MOM_10","MOM_20","MOM_60","MOM_120","VOL_10","VOL_20",
"MAXDD_60","ADV20","RSI14","HIGH52_RATIO","DIST_MA20","DIST_MA60","BREAKOUT20",
"BREAKOUT55","SKEW_20","SKEW_60","REL_MOM"]

def geo(a):
    a=np.asarray(a,dtype=float); a=a[np.isfinite(a)]
    if len(a)==0 or np.any(a<=-1): return -1.0
    return float(np.expm1(np.log1p(a).mean()))

def perf(a):
    a=np.asarray(a,dtype=float); a=a[np.isfinite(a)]
    if len(a)==0:return {"months":0,"geometric_monthly_return":-1.0,"cumulative_return":-1.0,
      "positive_month_pct":0.0,"months_ge_7pct":0,"min_monthly_return":None,
      "max_monthly_return":None,"max_drawdown_pct":None,"final_index":None}
    eq=np.cumprod(1+a); peak=np.maximum.accumulate(eq); dd=eq/peak-1
    return {"months":int(len(a)),"geometric_monthly_return":geo(a),
      "cumulative_return":float(eq[-1]-1),"positive_month_pct":float((a>0).mean()),
      "months_ge_7pct":int((a>=.07).sum()),"min_monthly_return":float(a.min()),
      "max_monthly_return":float(a.max()),"max_drawdown_pct":float(dd.min()),
      "final_index":float(eq[-1])}

def catalog(n,seed,available_factors):
    rng=np.random.default_rng(seed)
    if "REV21" not in available_factors:
        raise SystemExit("REV21 is required for the locked M1 benchmark")
    search_factors=list(available_factors)
    x=[{"id":"M1_REV21_K20","terms":[["REV21",-1.0]]}]
    for i in range(1,n):
        k=int(rng.integers(2,min(6,len(search_factors)+1)))
        ids=rng.choice(len(search_factors),size=k,replace=False)
        w=rng.uniform(.2,1.0,size=k)*rng.choice([-1.,1.],size=k); w=w/np.sum(np.abs(w))
        x.append({"id":f"F{i:04d}","terms":[(search_factors[j],float(v)) for j,v in zip(ids,w)]})
    return x

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True);ap.add_argument("--output",required=True)
    ap.add_argument("--formula-count",type=int,default=1000);ap.add_argument("--seed",type=int,default=20260920)
    ap.add_argument("--lookback-months",type=int,default=24);ap.add_argument("--min-history-months",type=int,default=12)
    ap.add_argument("--cost-bps",type=float,default=20);ap.add_argument("--k",type=int,default=20)
    a=ap.parse_args(); out=Path(a.output); out.mkdir(parents=True,exist_ok=True)
    d=pd.read_csv(a.input); need={"symbol","month_end","adj_close","fwd1",*FACTORS}; miss=sorted(need-set(d.columns))
    if miss: raise SystemExit(f"missing columns: {miss}")
    d["month_end"]=pd.to_datetime(d.month_end);d["symbol"]=d.symbol.astype(str)
    for c in ["adj_close","fwd1",*FACTORS]: d[c]=pd.to_numeric(d[c],errors="coerce")
    d=d.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"])
    available_factors=[f for f in FACTORS if float(d[f].notna().mean()) >= 0.20]
    if "REV21" not in available_factors:
        raise SystemExit("REV21 coverage is below 20%; cannot establish M1 benchmark")
    d=d.dropna(subset=["adj_close"]).reset_index(drop=True)
    months=sorted(d.month_end.unique().tolist())
    if len(months)<a.lookback_months+a.min_history_months+3: raise SystemExit("insufficient monthly history")
    rows={m:d.index[d.month_end.eq(m)].to_numpy() for m in months}
    ranks={f:d.groupby("month_end")[f].rank(pct=True,method="average").to_numpy() for f in FACTORS}
    fs=catalog(a.formula_count,a.seed,available_factors)
    (out/"formula_catalog.json").write_text(json.dumps(fs,indent=2),encoding="utf-8")
    cand={}
    pos={f:i for i,f in enumerate(FACTORS)}
    for fml in fs:
        w=np.zeros(len(FACTORS))
        for f,v in fml["terms"]:w[pos[f]]=v
        rr=[];prev=set()
        for m in months:
            ix=rows[m]; sc=np.zeros(len(ix))
            for f,v in fml["terms"]: sc+=ranks[f][ix]*v
            finite=np.isfinite(sc) & d.loc[ix,"fwd1"].notna().to_numpy()
            valid_ix=ix[finite]
            if len(valid_ix)==0: continue
            valid_sc=sc[finite]
            ordx=valid_ix[np.argsort(-valid_sc,kind="mergesort")[:a.k]]
            if len(ordx)==0:continue
            cur=set(d.loc[ordx,"symbol"].astype(str));gross=float(d.loc[ordx,"fwd1"].mean())
            overlap=len(cur&prev);turn=1.0 if not prev else 1.0-overlap/float(a.k)
            cost=turn*a.cost_bps/10000.;rr.append((m,gross,gross-cost,turn,cost));prev=cur
        cand[fml["id"]]=pd.DataFrame(rr,columns=["month_end","gross_return","net_return","turnover","cost"]).set_index("month_end")
    ledger=[];freq=Counter()
    for m in months:
        prior=[x for x in months if x<m][-a.lookback_months:]
        if len(prior)<a.min_history_months:continue
        el=[]
        for fid,fr in cand.items():
            h=fr.reindex(prior).net_return.dropna()
            if len(h)>=a.min_history_months:el.append((geo(h),float((h>0).mean()),fid))
        if not el or m not in cand[el[0][2]].index: continue
        el.sort(key=lambda z:(-z[0],-z[1],z[2]));sg,sp,fid=el[0];r=cand[fid].loc[m]
        ledger.append({"month_end":m,"history_start":prior[0],"history_end":prior[-1],"formula_id":fid,
          "selected_geo":sg,"selected_positive":sp,"gross_return":float(r.gross_return),
          "turnover":float(r.turnover),"transaction_cost":float(r.cost),"realized_return":float(r.net_return)})
        freq[fid]+=1
    led=pd.DataFrame(ledger);led.to_csv(out/"tournament_selection_ledger.csv",index=False)
    adaptive=perf(led.realized_return.tolist() if len(led) else [])
    m1=perf(cand["M1_REV21_K20"].net_return.tolist())
    full=[]
    for fid,fr in cand.items(): full.append({"formula_id":fid,**perf(fr.net_return.tolist())})
    full.sort(key=lambda z:(-z["geometric_monthly_return"],-z["positive_month_pct"],z["formula_id"]))
    pd.DataFrame(full).to_csv(out/"full_period_formula_stats.csv",index=False)
    summary={"status":"COMPLETED","engine":"luna-adaptive-tournament-v3","dataset_sha256":hashlib.sha256(Path(a.input).read_bytes()).hexdigest(),
      "formula_count":len(fs),"seed":a.seed,"k":a.k,"cost_bps":a.cost_bps,"lookback_months":a.lookback_months,
      "min_history_months":a.min_history_months,"months_available":len(months),"months_traded":int(len(led)),
      "available_factors":available_factors,
      "factor_coverage":{f:float(d[f].notna().mean()) for f in FACTORS},
      "adaptive":adaptive,"benchmark_m1_rev21_k20":m1,
      "top_adaptive_selections":[{"formula_id":f,"count":n} for f,n in freq.most_common(20)],
      "m1_definition":"lowest REV21 cross-sectional rank, equal-weight K20, monthly rebalance",
      "forward_return_definition":"next calendar month-end snapshot only","leakage_guard":"month t excluded from selection history",
      "full_period_ranking_note":"descriptive only; not used to select adaptive portfolio","initial_capital_baht":30000}
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8");print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__":main()
