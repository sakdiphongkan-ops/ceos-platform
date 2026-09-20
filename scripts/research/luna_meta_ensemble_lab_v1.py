#!/usr/bin/env python3
"""LUNA Meta-Ensemble Lab v1.

Tests whether combining robust mechanisms is more stable than choosing a single
formula. Parameters are selected on TRAIN only; holdout is frozen. The same
library is evaluated across multiple rolling origins and cost/K stress.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

FACTORS = [
    "mom1","mom2","mom3","mom4","mom6","mom12","high52_ratio","vol20","maxdd60","avg_amount20"
]

COMPONENTS = {
    "REV1": {"mom1": -1.0},
    "REV2": {"mom2": -1.0},
    "REV3": {"mom3": -1.0},
    "REV4": {"mom4": -1.0},
    "REV6": {"mom6": -1.0},
    "REV1_REV2_MIX": {"mom1": -0.55, "mom2": -0.45},
    "REV2_REV4_MIX": {"mom2": -0.55, "mom4": -0.45},
    "MOM6": {"mom6": 1.0},
    "MOM12": {"mom12": 1.0},
    "HIGH52": {"high52_ratio": 1.0},
    "LOWVOL": {"vol20": -1.0},
    "LOWDD": {"maxdd60": 1.0},
    "LIQ": {"avg_amount20": 1.0},
    "REV1_LOWVOL": {"mom1": -0.65, "vol20": -0.35},
    "REV1_HIGH52": {"mom1": -0.65, "high52_ratio": 0.35},
    "MOM6_HIGH52_LOWVOL": {"mom6": 0.45, "high52_ratio": 0.25, "vol20": -0.30},
    "MOM12_HIGH52_LOWVOL": {"mom12": 0.45, "high52_ratio": 0.25, "vol20": -0.30},
    "HIGH52_LOWVOL": {"high52_ratio": 0.60, "vol20": -0.40},
}

def geo(a):
    x=np.asarray(a,dtype=float)
    x=x[np.isfinite(x)]
    if len(x)==0 or np.any(x<=-1): return -1.0
    return float(np.exp(np.log1p(x).mean())-1.0)

def stats(a):
    x=np.asarray(a,dtype=float); x=x[np.isfinite(x)]
    if len(x)==0:
        return {"months":0,"geo_monthly":-1.0,"cumulative":-1.0,
                "positive_month_pct":0.0,"max_drawdown":1.0}
    eq=np.cumprod(1+x); peak=np.maximum.accumulate(eq)
    return {
        "months":int(len(x)),
        "geo_monthly":geo(x),
        "cumulative":float(eq[-1]-1.0),
        "positive_month_pct":float((x>0).mean()),
        "max_drawdown":float((eq/peak-1.0).min()),
        "worst_month":float(x.min()),
        "best_month":float(x.max()),
    }

def prepare(csv):
    df=pd.read_csv(csv)
    need={"date","symbol","adj_close"} | set(FACTORS)
    missing=sorted(need-set(df.columns))
    if missing: raise SystemExit(f"missing columns: {missing}")
    df["date"]=pd.to_datetime(df["date"],errors="raise")
    df["symbol"]=df["symbol"].astype(str).str.upper().str.strip()
    df["month"]=df["date"].dt.to_period("M").dt.to_timestamp("M")
    for c in ["adj_close"]+FACTORS:
        df[c]=pd.to_numeric(df[c],errors="coerce")
    m=(df.sort_values(["symbol","date"])
         .groupby(["symbol","month"],as_index=False).tail(1)
         .sort_values(["month","symbol"]).reset_index(drop=True))
    target=m[["symbol","month","adj_close"]].copy()
    target["month"]=target["month"]-pd.offsets.MonthEnd(1)
    target=target.rename(columns={"adj_close":"_next_px"})
    m=m.merge(target,on=["symbol","month"],how="left")
    m["fwd1"]=m["_next_px"]/m["adj_close"]-1
    m.drop(columns=["_next_px"],inplace=True)
    m=m[m["fwd1"].notna()].copy()
    months=sorted(m["month"].unique())
    panels=[]
    for month in months:
        g=m[m["month"]==month].copy()
        if len(g)<20: continue
        ranks={f:g[f].rank(pct=True,method="average").to_numpy(dtype=np.float32) for f in FACTORS}
        valid=np.ones(len(g),dtype=bool)
        for f in FACTORS: valid &= np.isfinite(ranks[f])
        g=g.iloc[np.flatnonzero(valid)]
        if len(g)<20: continue
        ranks={f:r[valid] for f,r in ranks.items()}
        panels.append({"month":pd.Timestamp(month),
                       "symbols":g["symbol"].to_numpy(dtype=object),
                       "ranks":ranks,
                       "fwd":g["fwd1"].to_numpy(dtype=float)})
    return panels

def component_paths(panels,k,cost_bps):
    names=list(COMPONENTS)
    paths={n:np.full(len(panels),np.nan) for n in names}
    for name,terms in COMPONENTS.items():
        prev=set()
        for mi,p in enumerate(panels):
            score=np.zeros(len(p["fwd"]),dtype=float)
            for f,w in terms: score += w*p["ranks"][f]
            order=np.argsort(-score,kind="mergesort")[:k]
            cur=set(p["symbols"][order].tolist())
            overlap=len(cur&prev)
            turnover=1.0 if mi==0 else 1.0-overlap/float(k)
            paths[name][mi]=float(np.mean(p["fwd"][order]))-turnover*cost_bps/10000.0
            prev=cur
    return paths

def ensemble_from(paths,months_idx,weights):
    a=np.zeros(len(months_idx))
    for j,i in enumerate(months_idx):
        vals=[]
        ws=[]
        for name,w in weights.items():
            if np.isfinite(paths[name][i]):
                vals.append(paths[name][i]); ws.append(w)
        if vals:
            a[j]=float(np.average(vals,weights=ws))
    return a

def candidate_weights(train_paths,train_idx):
    names=list(COMPONENTS)
    rows=[]
    # Single best, equal top-N, and inverse-drawdown style candidates.
    component_geo={n:geo([train_paths[n][i] for i in train_idx]) for n in names}
    order=sorted(names,key=lambda n:component_geo[n],reverse=True)
    rows.append(("BEST1",{order[0]:1.0}))
    for n in (2,3,4,5):
        chosen=order[:n]
        rows.append((f"EQ_TOP{n}",{x:1.0/n for x in chosen}))
    # Fixed mechanism ensembles are included as hypothesis families.
    rows.append(("REV_MOM_DEF",{"REV1":.34,"MOM6":.22,"HIGH52":.18,"LOWVOL":.16,"LIQ":.10}))
    rows.append(("REV_REGIME",{"REV1":.45,"REV1_LOWVOL":.25,"MOM6_HIGH52_LOWVOL":.15,"HIGH52":.15}))
    rows.append(("TREND_DEF",{"MOM6":.30,"MOM12":.20,"HIGH52":.25,"LOWVOL":.15,"LOWDD":.10}))
    return rows

def run():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--cost-bps",type=float,default=20)
    args=ap.parse_args()
    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    panels=prepare(args.input)
    if len(panels)<36: raise SystemExit(f"too few monthly panels: {len(panels)}")
    # Three rolling origins. Holdout is frozen and never used in choosing the weight set.
    origins=[
        ("O1_2024","2022-01-31","2023-12-31","2024-01-31","2024-12-31"),
        ("O2_2025","2023-01-31","2024-12-31","2025-01-31","2025-12-31"),
        ("O3_2026","2024-01-31","2025-12-31","2026-01-31","2026-08-31"),
    ]
    all_rows=[]
    selected=[]
    for name,t0,t1,h0,h1 in origins:
        ti=[i for i,p in enumerate(panels) if pd.Timestamp(t0)<=p["month"]<=pd.Timestamp(t1)]
        hi=[i for i,p in enumerate(panels) if pd.Timestamp(h0)<=p["month"]<=pd.Timestamp(h1)]
        paths=component_paths(panels,args.k,args.cost_bps)
        candidates=candidate_weights(paths,ti)
        scored=[]
        for cid,w in candidates:
            tr=ensemble_from(paths,ti,w)
            scored.append((geo(tr),float((tr>0).mean()),cid,w,stats(tr)))
        scored.sort(key=lambda x:(-x[0],-x[1],x[2]))
        # selection is frozen at the origin; then evaluate untouched holdout
        for rank,(tr_geo,tr_pos,cid,w,tr_stats) in enumerate(scored,1):
            ho=ensemble_from(paths,hi,w)
            row={
                "origin":name,"training_rank":rank,"candidate_id":cid,
                "weights":json.dumps(w,sort_keys=True),
                "train_geo_monthly":tr_geo,
                "train_positive_pct":tr_pos,
                "holdout_geo_monthly":geo(ho),
                "holdout_cumulative":float(np.prod(1+ho)-1) if len(ho) else -1,
                "holdout_positive_pct":float((ho>0).mean()) if len(ho) else 0,
                "holdout_max_drawdown":stats(ho)["max_drawdown"],
            }
            all_rows.append(row)
        best=scored[0]
        best_hold=ensemble_from(paths,hi,best[3])
        selected.append({
            "origin":name,"selected_candidate":best[2],"weights":best[3],
            "train_geo_monthly":best[0],"train_positive_pct":best[1],
            "holdout":stats(best_hold)
        })
    result=pd.DataFrame(all_rows)
    result.to_csv(out/"meta_ensemble_results.csv",index=False)
    sel=pd.DataFrame(selected); sel.to_csv(out/"selected_by_origin.csv",index=False)
    # Stress the frozen selections.
    stress=[]
    for s in selected:
        for k2 in (10,20,50):
            for bps in (0,20,45,60):
                p2=component_paths(panels,k2,bps)
                name=s["origin"]
                origin=next(o for o in origins if o[0]==name)
                hi=[i for i,p in enumerate(panels) if pd.Timestamp(origin[3])<=p["month"]<=pd.Timestamp(origin[4])]
                ho=ensemble_from(p2,hi,s["weights"])
                stress.append({"origin":name,"k":k2,"cost_bps":bps,"selected_candidate":s["selected_candidate"],**stats(ho)})
    pd.DataFrame(stress).to_csv(out/"selected_stress.csv",index=False)
    summary={
      "status":"COMPLETED","engine":"luna-meta-ensemble-lab-v1",
      "dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
      "months":len(panels),"component_count":len(COMPONENTS),
      "component_names":list(COMPONENTS),
      "origins":selected,
      "scenario_grid":"K=10/20/50; cost=0/20/45/60",
      "target_geometric_monthly":0.07,
      "selection_guard":"weights are selected using training months only; holdout is frozen",
      "purpose":"test whether diversified mechanism combinations reduce single-formula/seed instability",
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__": run()
