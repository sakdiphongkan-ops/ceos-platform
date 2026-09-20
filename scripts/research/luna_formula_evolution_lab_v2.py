#!/usr/bin/env python3
"""LUNA Formula Evolution Lab v2 - batch/NumPy implementation.

Evolves historical LUNA ideas together with new factor combinations.
Selection is based on TRAIN + DEV only. OOS and HOLDOUT are frozen.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

FEATURES = [
    "MOM_5","MOM_10","MOM_20","MOM_40","MOM_60","MOM_120","MOM_252",
    "REL_MOM","VOL_10","VOL_20","BETA","MAXDD_60","ATR_PCT","ADV20",
    "AMOUNT","ILLIQ_20","RSI14","DIST_MA20","DIST_MA60","DIST_HIGH_252",
    "BREAKOUT20","BREAKOUT55","SKEW_20","SKEW_60","PE","PBV","EV_EBITDA",
    "FCF_YIELD","EARNINGS_YIELD","DIV_YIELD","ROE","ROA","ROIC","GPM",
    "NPM","CFO_MARGIN","REV_G","EPS_G","NI_G","FCF_G","ASSET_G","CAPEX_G",
    "INVESTMENT_RATE","DIV_G","PAYOUT","BUYBACK","DE","NET_DEBT_EBITDA",
    "INTEREST_COVER","CURRENT_RATIO","QUALITY_SCORE","VALUE_QUALITY",
    "MOM_BLEND","CONSERVATIVE_SCORE","SAFETY_SCORE","GROWTH_QUALITY",
    "INV_QUALITY",
]

@dataclass(frozen=True)
class Formula:
    id: str
    terms: tuple[tuple[str,float], ...]
    parents: tuple[str,...] = ()
    note: str = ""

def hid(s: str) -> int:
    return int(hashlib.sha256(s.encode()).hexdigest()[:16], 16)

def normalize(terms):
    d={}
    for f,w in terms:
        d[f]=d.get(f,0.0)+float(w)
    d={f:w for f,w in d.items() if abs(w)>1e-9}
    if not d:
        return ()
    den=sum(abs(w) for w in d.values())
    return tuple(sorted((f,w/den) for f,w in d.items()))

def fid(terms):
    raw="|".join(f"{f}:{w:.8f}" for f,w in terms)
    return "EV_"+hashlib.sha256(raw.encode()).hexdigest()[:12]

def stat(arr):
    x=np.asarray(arr,dtype=float)
    x=x[np.isfinite(x)]
    if len(x)==0:
        return {"months":0,"geo_monthly":-1.0,"cumulative":-1.0,
                "positive_month_pct":0.0,"max_drawdown":1.0,
                "worst_month":None,"best_month":None}
    eq=np.cumprod(1+x)
    peak=np.maximum.accumulate(eq)
    return {
        "months":int(len(x)),
        "geo_period":float(np.exp(np.log1p(x).mean())-1),
        "cumulative":float(eq[-1]-1),
        "positive_period_pct":float((x>0).mean()),
        "max_drawdown":float((1-eq/peak).max()),
        "worst_month":float(x.min()),
        "best_month":float(x.max()),
    }

def monthly_panel(csv, features):
    df=pd.read_csv(csv)
    need={"date","symbol","adj_close"}
    if not need.issubset(df.columns):
        raise SystemExit(f"missing required columns: {sorted(need-set(df.columns))}")
    df["date"]=pd.to_datetime(df["date"],errors="raise")
    df["symbol"]=df["symbol"].astype(str).str.upper().str.strip()
    df["month_end"]=df["date"].dt.to_period("M").dt.to_timestamp("M")
    df["adj_close"]=pd.to_numeric(df["adj_close"],errors="coerce")
    avail=[]
    for f in features:
        if f not in df.columns:
            continue
        df[f]=pd.to_numeric(df[f],errors="coerce")
        if df[f].notna().mean()>=0.20:
            avail.append(f)

    m=(df.sort_values(["symbol","date"])
         .groupby(["symbol","month_end"],as_index=False).tail(1)
         .sort_values(["month_end","symbol"]).reset_index(drop=True))
    m["symbol_id"]=pd.Categorical(m["symbol"]).codes.astype(np.int32)

    for h in (1,2,3):
        target=m[["symbol","month_end","adj_close"]].copy()
        target["month_end"]=target["month_end"]-pd.offsets.MonthEnd(h)
        target=target.rename(columns={"adj_close":f"_px{h}"})
        m=m.merge(target,on=["symbol","month_end"],how="left")
        m[f"fwd{h}"]=m[f"_px{h}"]/m["adj_close"]-1
        m.drop(columns=[f"_px{h}"],inplace=True)

    months=sorted(m["month_end"].dropna().unique())
    panels=[]
    for month in months:
        g=m[m["month_end"]==month].copy()
        if len(g)<20:
            continue
        ranks=[]
        good=True
        for f in avail:
            r=g[f].rank(pct=True,method="average").to_numpy(dtype=np.float32)
            if not np.isfinite(r).any():
                good=False
            ranks.append(r)
        if not good:
            continue
        panels.append({
            "month":pd.Timestamp(month),
            "symbols":g["symbol"].to_numpy(dtype=object),
            "symbol_id":g["symbol_id"].to_numpy(dtype=np.int32),
            "rank":np.column_stack(ranks).astype(np.float32),
            "fwd":{h:g[f"fwd{h}"].to_numpy(dtype=np.float64) for h in (1,2,3)},
        })
    idx={f:i for i,f in enumerate(avail)}
    return panels,avail,idx,m

def seeds(avail):
    specs=[
        ("M1_REV1", [("MOM_20",-1)],"legacy M1-style reversal"),
        ("M2_REV2", [("MOM_40",-1)],"2M reversal"),
        ("REV3", [("MOM_60",-1)],"3M reversal"),
        ("REV6", [("MOM_120",-1)],"6M reversal"),
        ("MOM6", [("MOM_120",1)],"6M momentum"),
        ("MOM12",[("MOM_252",1)],"12M momentum"),
        ("HIGH52",[("DIST_HIGH_252",-1)],"near 52W high"),
        ("LOWVOL",[("VOL_20",-1)],"low volatility"),
        ("HIGHAMT",[("AMOUNT",1)],"high liquidity"),
        ("LOWILLIQ",[("ILLIQ_20",-1)],"low illiquidity"),
        ("REV1_LOWVOL",[("MOM_20",-0.65),("VOL_20",-0.35)],"reversal + low volatility"),
        ("REV1_HIGH52",[("MOM_20",-0.65),("DIST_HIGH_252",-0.35)],"reversal + 52W high"),
        ("REV1_HIGHVOL",[("MOM_20",-0.65),("VOL_20",0.35)],"reversal + high volatility"),
        ("MOM6_HIGH52_LOWVOL",[("MOM_120",0.45),("DIST_HIGH_252",-0.25),("VOL_20",-0.30)],"legacy S46-like"),
        ("MOM12_HIGH52_LOWVOL",[("MOM_252",0.45),("DIST_HIGH_252",-0.25),("VOL_20",-0.30)],"legacy S48-like"),
        ("MOM_BREAKOUT",[("MOM_60",0.55),("BREAKOUT55",0.45)],"momentum + breakout"),
        ("REL_MOM_LOWVOL",[("REL_MOM",0.60),("VOL_20",-0.40)],"relative momentum + low vol"),
        ("ATR_MOM",[("MOM_60",0.60),("ATR_PCT",-0.40)],"momentum + low ATR"),
        ("QUALITY_LOWVOL",[("QUALITY_SCORE",0.60),("VOL_20",-0.40)],"quality + defensive"),
        ("VALUE_QUALITY_MOM",[("VALUE_QUALITY",0.40),("QUALITY_SCORE",0.30),("MOM_60",0.30)],"value-quality + momentum"),
        ("SAFETY_MOM",[("SAFETY_SCORE",0.55),("MOM_120",0.45)],"safety + momentum"),
    ]
    out=[]
    for name,terms,note in specs:
        t=normalize([(f,w) for f,w in terms if f in avail])
        if t:
            out.append(Formula(fid(t),t,(),name+":"+note))
    for f in avail:
        for s in (-1,1):
            t=normalize([(f,s)])
            out.append(Formula(fid(t),t,(),f"probe:{f}:{s}"))
    return list({x.id:x for x in out}.values())

def random_formula(avail,rng,note):
    n=int(rng.integers(2,5))
    fs=rng.choice(avail,size=n,replace=False)
    ws=rng.uniform(.15,1.0,size=n)*rng.choice([-1,1],size=n)
    t=normalize(zip(fs.tolist(),ws.tolist()))
    return Formula(fid(t),t,(),note)

def mutate(parent,avail,i,tag):
    rng=np.random.default_rng(hid(f"{tag}|{parent.id}|{i}"))
    d=dict(parent.terms)
    r=rng.random()
    if r<0.40 and len(d)<4:
        choices=[f for f in avail if f not in d]
        if choices:
            f=choices[int(rng.integers(len(choices)))]
            d[f]=float(rng.choice([-1,1]))*float(rng.uniform(.15,.8))
    elif r<0.75 and d:
        f=list(d)[int(rng.integers(len(d)))]
        d[f]*=float(rng.uniform(.45,1.9))
    elif d:
        f=list(d)[int(rng.integers(len(d)))]
        d[f]*=-1
    if rng.random()<0.25 and len(d)>1:
        f=list(d)[int(rng.integers(len(d)))]
        d.pop(f)
    t=normalize(d.items())
    if not t:
        t=parent.terms
    return Formula(fid(t),t,(parent.id,),"mutation")

def weight_matrix(forms,avail,idx):
    w=np.zeros((len(avail),len(forms)),dtype=np.float32)
    for j,fm in enumerate(forms):
        for f,v in fm.terms:
            w[idx[f],j]=v
    return w

def batch_eval(panels,forms,avail,idx,start,end,k,horizon,cost_bps,anchor=0,return_path=False):
    months=[p for p in panels if pd.Timestamp(start)<=p["month"]<=pd.Timestamp(end)]
    F=len(forms)
    out=np.full((F,len(months)),np.nan,dtype=np.float64)
    turnovers=np.full_like(out,np.nan)
    W=weight_matrix(forms,avail,idx)
    prev=[set() for _ in range(F)]
    for mi,p in enumerate(months):
        if (mi-anchor)%horizon!=0:
            continue
        scores=p["rank"]@W
        fwd=p["fwd"][horizon]
        n=len(p["symbols"])
        kk=min(k,n)
        for j in range(F):
            sc=scores[:,j]
            valid=np.isfinite(sc)&np.isfinite(fwd)
            if valid.sum()<kk:
                continue
            ids=np.flatnonzero(valid)
            vals=sc[ids]
            pick=ids[np.argpartition(-vals,kk-1)[:kk]]
            # deterministic tie break for auditability
            pick=pick[np.lexsort((p["symbols"][pick],-sc[pick]))]
            cur=set(p["symbol_id"][pick].tolist())
            prevset=prev[j]
            overlap=len(cur&prevset)
            turn=1.0 if not prevset else 1.0-overlap/float(kk)
            gross=float(np.mean(fwd[pick]))
            out[j,mi]=gross-turn*cost_bps/10000.0
            turnovers[j,mi]=turn
            prev[j]=cur
    result=[]
    for j,fm in enumerate(forms):
        s=stat(out[j])
        s["geo_monthly"]=(1.0+s["geo_period"])**(1.0/horizon)-1.0 if s["geo_period"]>-1 else -1.0
        s["positive_month_pct"]=s["positive_period_pct"]
        s["formula_id"]=fm.id
        s["avg_turnover"]=float(np.nanmean(turnovers[j])) if np.isfinite(turnovers[j]).any() else np.nan
        s["months_ge_7pct"]=int(np.nansum(out[j]>=((1.07**horizon)-1.0)))
        if return_path:
            s["_path"]=out[j].copy()
        result.append(s)
    return result

def regime_overlay_from_paths(results,panels,mode):
    breadth=[]
    for p in panels:
        # MOM_20 is not necessarily at a fixed column; overlay uses raw rank only
        breadth.append(float(np.nanmean(p["rank"][:,0] > 0.5)) if p["rank"].shape[1] else 0.0)
    breadth=np.asarray(breadth)
    state=np.ones(len(breadth))
    state[breadth<0.25]=0.5
    if mode=="CASH":
        state[breadth<0.25]=0.0
    for r in results:
        path=r["_path"].copy()
        valid=np.isfinite(path)
        path[valid]=path[valid]*state[-len(path):][valid]
        r[f"overlay_{mode}"]=stat(path)

def select_score(tr,dev):
    if tr["months"]<12 or dev["months"]<6:
        return -999
    return (0.45*dev["geo_monthly"]+0.30*tr["geo_monthly"]+
            0.15*dev["positive_month_pct"]+0.10*tr["positive_month_pct"]-
            0.20*dev["max_drawdown"])

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--generations",type=int,default=3)
    ap.add_argument("--initial-random",type=int,default=1000)
    ap.add_argument("--children",type=int,default=1200)
    ap.add_argument("--survivors",type=int,default=40)
    ap.add_argument("--finalists",type=int,default=80)
    args=ap.parse_args()

    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    panels,avail,idx,monthly=monthly_panel(args.input,FEATURES)
    if len(avail)<4: raise SystemExit("Too few usable features")
    splits={
        "TRAIN":("2018-01-31","2021-12-31"),
        "DEV":("2022-01-31","2023-12-31"),
        "OOS":("2024-01-31","2024-12-31"),
        "HOLDOUT":("2025-01-31","2025-12-31"),
    }

    rng=np.random.default_rng(20260920)
    population=seeds(avail)
    population += [random_formula(avail,rng,"random_seed") for _ in range(args.initial_random)]
    population=list({f.id:f for f in population}.values())
    ledger=[]

    for gen in range(args.generations):
        tr=batch_eval(panels,population,avail,idx, *splits["TRAIN"],20,1,20)
        dv=batch_eval(panels,population,avail,idx, *splits["DEV"],20,1,20)
        dv_map={x["formula_id"]:x for x in dv}
        tr_map={x["formula_id"]:x for x in tr}
        ranked=[]
        for fm in population:
            a=tr_map[fm.id];b=dv_map[fm.id]
            sc=select_score(a,b)
            ranked.append((sc,fm,a,b))
            ledger.append({
                "generation":gen,"formula_id":fm.id,"parents":list(fm.parents),
                "terms":list(fm.terms),"note":fm.note,"score":sc,
                "train_geo":a["geo_monthly"],"dev_geo":b["geo_monthly"],
                "train_pos":a["positive_month_pct"],"dev_pos":b["positive_month_pct"],
                "dev_dd":b["max_drawdown"],"dev_turnover":b["avg_turnover"],
            })
        ranked.sort(key=lambda x:(-x[0],x[1].id))
        parents=[x[1] for x in ranked[:args.survivors]]
        children=[mutate(parents[i%len(parents)],avail,i,f"gen{gen}") for i in range(args.children)]
        # Crossovers between surviving formulas
        for i in range(max(20,args.children//5)):
            a=parents[i%len(parents)];b=parents[(i*7+3)%len(parents)]
            d=dict(a.terms)
            for f,w in b.terms:d[f]=0.5*d.get(f,0)+0.5*w
            t=normalize(d.items())
            if t: children.append(Formula(fid(t), (a.id,b.id), t, "crossover"))
        population=list({f.id:f for f in parents+children}.values())

    # Freeze final candidates using only the final generation TRAIN+DEV score.
    final_gen=[x for x in ledger if x["generation"]==args.generations-1]
    final_gen.sort(key=lambda x:(-x["score"],x["formula_id"]))
    frozen_ids=[x["formula_id"] for x in final_gen[:args.finalists]]
    frozen={f.id:f for f in population}
    seed_pool=seeds(avail)
    for f in seed_pool:frozen.setdefault(f.id,f)

    final_forms=[frozen[fid0] for fid0 in frozen_ids if fid0 in frozen]
    all_scenarios=[]
    for k in (5,10,20,50):
        for h in (1,2,3):
            for cost in (0,20,45,60):
                for split_name in ("OOS","HOLDOUT"):
                    s0,s1=splits[split_name]
                    res=batch_eval(panels,final_forms,avail,idx,s0,s1,k,h,cost,0)
                    for r in res:
                        all_scenarios.append({
                            "formula_id":r["formula_id"],"split":split_name,
                            "scenario":"BASE","k":k,"horizon_months":h,"cost_bps":cost,
                            **{key:val for key,val in r.items() if not key.startswith("_")}
                        })

    # Anchor sensitivity for h=2 and h=3 at K20, 20/60 bps.
    for h in (2,3):
        for anchor in range(h):
            for cost in (20,60):
                for split_name in ("OOS","HOLDOUT"):
                    s0,s1=splits[split_name]
                    res=batch_eval(panels,final_forms,avail,idx,s0,s1,20,h,cost,anchor)
                    for r in res:
                        all_scenarios.append({
                            "formula_id":r["formula_id"],"split":split_name,
                            "scenario":"ANCHOR","k":20,"horizon_months":h,
                            "cost_bps":cost,"anchor":anchor,
                            **{key:val for key,val in r.items() if not key.startswith("_")}
                        })

    # Regime overlays are applied to the frozen base path at K20/H1/20bps.
    base=batch_eval(panels,final_forms,avail,idx,*splits["OOS"],20,1,20,0,True)
    for mode in ("HALF","CASH"):
        # Build breadth state directly from MOM_20 rank using its feature index.
        ri=idx.get("MOM_20")
        if ri is None: continue
        months=[p["month"] for p in panels if pd.Timestamp(splits["OOS"][0])<=p["month"]<=pd.Timestamp(splits["OOS"][1])]
        state=[]
        for p in panels:
            if p["month"] not in months: continue
            b=float(np.nanmean(p["rank"][:,ri]>0.5))
            state.append(0.5 if b<0.25 and mode=="HALF" else (0.0 if b<0.25 else 1.0))
        state=np.asarray(state)
        for j,r in enumerate(base):
            path=r["_path"]
            v=path.copy();m=np.isfinite(v)
            if len(state)>=len(v):v[m]=v[m]*state[-len(v):][m]
            s=stat(v)
            all_scenarios.append({"formula_id":r["formula_id"],"split":"OOS",
                "scenario":f"REGIME_{mode}","k":20,"horizon_months":1,"cost_bps":20,**s})

    # Final stability summary: how often each formula is positive across OOS/HOLDOUT stress grid.
    sdf=pd.DataFrame(all_scenarios)
    base_20=sdf[(sdf["scenario"]=="BASE")&(sdf["k"]==20)&(sdf["horizon_months"]==1)]
    summary_rows=[]
    for fid0,g in base_20.groupby("formula_id"):
        o=g[g["split"]=="OOS"];h=g[g["split"]=="HOLDOUT"]
        summary_rows.append({
            "formula_id":fid0,
            "oos_geo_median":float(o["geo_monthly"].median()) if len(o) else np.nan,
            "holdout_geo_median":float(h["geo_monthly"].median()) if len(h) else np.nan,
            "oos_all_costs_positive":bool((o["cumulative"]>0).all()) if len(o) else False,
            "holdout_all_costs_positive":bool((h["cumulative"]>0).all()) if len(h) else False,
            "oos_cost60_geo":float(o.loc[o["cost_bps"]==60,"geo_monthly"].iloc[0]) if (o["cost_bps"]==60).any() else np.nan,
            "holdout_cost60_geo":float(h.loc[h["cost_bps"]==60,"geo_monthly"].iloc[0]) if (h["cost_bps"]==60).any() else np.nan,
        })
    stab=pd.DataFrame(summary_rows).sort_values(["holdout_geo_median","oos_geo_median"],ascending=False)
    stab.to_csv(out/"finalist_stability.csv",index=False)
    pd.DataFrame(ledger).to_csv(out/"evolution_ledger.csv",index=False)
    sdf.to_json(out/"scenario_results.jsonl",orient="records",lines=True)

    catalog=[]
    all_formula_ids=set(frozen_ids)
    for rec in ledger: all_formula_ids.add(rec["formula_id"])
    by_id={f.id:f for f in population}
    for f in seed_pool:by_id.setdefault(f.id,f)
    for fid0 in sorted(all_formula_ids):
        f=by_id.get(fid0)
        if f:catalog.append({"id":f.id,"terms":list(f.terms),"parents":list(f.parents),"note":f.note})
    (out/"formula_catalog.json").write_text(json.dumps(catalog,indent=2),encoding="utf-8")

    queue=[
        {"family":"PEAD","needed":["announcement_dates","earnings_surprise"]},
        {"family":"SUE","needed":["quarterly_EPS_history","announcement_dates"]},
        {"family":"Value","needed":["PE","PBV","FCF_YIELD","EARNINGS_YIELD"]},
        {"family":"Profitability","needed":["ROE","ROIC","CFO_MARGIN","NPM"]},
        {"family":"Investment","needed":["ASSET_G","CAPEX_G","INVESTMENT_RATE"]},
        {"family":"Quality","needed":["ROIC","INTEREST_COVER","CURRENT_RATIO","DE"]},
        {"family":"Liquidity","needed":["AMOUNT","ADV20","ILLIQ_20","TURNOVER"]},
    ]
    missing=[q for q in queue if any(x not in avail for x in q["needed"])]

    summary={
        "status":"COMPLETED","engine":"luna-formula-evolution-lab-v2",
        "dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "months":len(panels),"symbols":int(monthly["symbol"].nunique()),
        "available_features":avail,"population_seeded":len(population),
        "generations":args.generations,"initial_random":args.initial_random,
        "children_per_generation":args.children,"survivors":args.survivors,
        "frozen_finalists":len(final_forms),
        "selection_data":"TRAIN+DEV only","blind_data":["OOS","HOLDOUT"],
        "scenario_count_per_formula":int(4*3*4*2 + 2*3*2*2 + 2),
        "target_hurdle_monthly":0.07,
        "research_queue":missing,
        "notes":[
            "Legacy LUNA seeds are co-evolved with newly generated factor blends.",
            "OOS/HOLDOUT are never used to generate mutations or select finalists.",
            "Cost stress uses 0/20/45/60 bps per one-way turnover model.",
            "Anchor sensitivity is tested for 2M and 3M holding horizons.",
            "This engine can only test observable factors; undisclosed proprietary formulas are not inferable without their inputs."
        ]
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")
    print(json.dumps(summary,indent=2))

if __name__=="__main__":
    main()
