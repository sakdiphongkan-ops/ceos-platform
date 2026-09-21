#!/usr/bin/env python3
"""LUNA Research Scorecard v1.

Adds institutional-style factor diagnostics to a selected candidate:
IC/ICIR, quintile spread, factor redundancy, turnover, capacity proxy,
cost/K stress, and exact locked-M1 comparison on overlapping months.

The scorecard is descriptive/audit infrastructure. It never changes the
candidate selection or frozen holdout.
"""
from __future__ import annotations
import argparse, hashlib, json, math
from pathlib import Path
import numpy as np
import pandas as pd

def geo(x):
    a=np.asarray(x,dtype=float); a=a[np.isfinite(a)]
    if len(a)==0 or np.any(a<=-1): return -1.0
    return float(np.expm1(np.log1p(a).mean()))

def stats(x):
    a=np.asarray(x,dtype=float); a=a[np.isfinite(a)]
    if len(a)==0:return {"months":0,"geo":-1.0,"cum":-1.0,"pos":0.0,"dd":None,"ge7":0}
    eq=np.cumprod(1+a); peak=np.maximum.accumulate(eq)
    return {"months":int(len(a)),"geo":geo(a),"cum":float(eq[-1]-1),
            "pos":float((a>0).mean()),"dd":float((eq/peak-1).min()),
            "ge7":int((a>=.07).sum()),"min":float(a.min()),"max":float(a.max())}

def rank_series(d,col):
    return d.groupby("month_end")[col].rank(pct=True,method="average")

def formula_score(d,formula):
    s=pd.Series(0.0,index=d.index)
    for f,w in formula["terms"]:
        if f not in d: raise SystemExit(f"formula factor missing: {f}")
        s=s+rank_series(d,f)*float(w)
    kind=formula.get("kind","blend")
    if kind=="interaction" and len(formula["terms"])>=2:
        a=rank_series(d,formula["terms"][0][0]); b=rank_series(d,formula["terms"][1][0])
        s=s+0.50*(a-0.5)*(b-0.5)
    if kind=="gated" and len(formula["terms"])>=2:
        gate=rank_series(d,formula["terms"][0][0])>0.55
        s=s.where(gate,s-0.10)
    return s

def spearman(x,y):
    z=pd.DataFrame({"x":x,"y":y}).dropna()
    if len(z)<3:return np.nan
    return float(z.x.rank().corr(z.y.rank()))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--search-summary",required=True)
    ap.add_argument("--formula-catalog",required=True)
    ap.add_argument("--benchmark",required=False)
    ap.add_argument("--output",required=True)
    ap.add_argument("--k-grid",default="10,20,30,50")
    ap.add_argument("--cost-grid",default="0,10,20,45,60")
    ap.add_argument("--initial-capital",type=float,default=30000)
    args=ap.parse_args()
    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)

    d=pd.read_csv(args.input)
    d["month_end"]=pd.to_datetime(d.month_end)
    for c in d.columns:
        if c not in {"symbol","month_end"}: d[c]=pd.to_numeric(d[c],errors="coerce")
    summary=json.loads(Path(args.search_summary).read_text())
    catalog=json.loads(Path(args.formula_catalog).read_text())
    fid=summary["final_formula"]["id"]
    formula=next(x for x in catalog if x["id"]==fid)
    months=sorted(d.month_end.dropna().unique().tolist())
    holdout_months=[pd.Timestamp(summary["holdout_start"]),pd.Timestamp(summary["holdout_end"])]
    holdout=[m for m in months if holdout_months[0]<=m<=holdout_months[1]]
    dev=[m for m in months if m<holdout_months[0]]

    d["score"]=formula_score(d,formula)
    d["fwd1"]=pd.to_numeric(d["fwd1"],errors="coerce")

    # Per-month factor IC and quintile spread.
    candidate_ic={}; candidate_spread=[]
    for m,g in d.groupby("month_end",sort=True):
        gg=g.dropna(subset=["score","fwd1"])
        candidate_ic[str(m.date())]=spearman(gg["score"],gg["fwd1"])
        if len(gg)>=20:
            q=pd.qcut(gg["score"],5,labels=False,duplicates="drop")
            qret=gg.assign(q=q).groupby("q").fwd1.mean()
            if len(qret)>=2:
                candidate_spread.append({"month_end":str(m.date()),"top_bottom_spread":float(qret.iloc[-1]-qret.iloc[0])})

    ic_df=pd.DataFrame({"month_end":list(candidate_ic.keys()),"ic":list(candidate_ic.values())})
    ic_df["month_end"]=pd.to_datetime(ic_df["month_end"])
    ic=ic_df.ic.dropna()
    dev_ic=ic_df.loc[ic_df["month_end"].isin(dev),"ic"].dropna()
    icir=float(dev_ic.mean()/dev_ic.std(ddof=1)*math.sqrt(12)) if len(dev_ic)>1 and dev_ic.std(ddof=1)>0 else None

    # Exact candidate portfolio series for diagnostics.
    rows={m:d.index[d.month_end.eq(m)].to_numpy() for m in months}
    def portfolio(k,cost_bps):
        prev=set(); rr=[]
        selected_adv=[]
        for m in months:
            ix=rows[m]
            sc=d.loc[ix,"score"].to_numpy()
            good=np.isfinite(sc)&d.loc[ix,"fwd1"].notna().to_numpy()
            vi=ix[good]
            vs=sc[good]
            if len(vi)==0:continue
            order=vi[np.argsort(-vs,kind="mergesort")[:k]]
            cur=set(d.loc[order,"symbol"].astype(str))
            gross=float(d.loc[order,"fwd1"].mean())
            turnover=1.0 if not prev else 1.0-len(cur&prev)/float(k)
            cost=turnover*cost_bps/10000.0
            adv=pd.to_numeric(d.loc[order,"ADV20"],errors="coerce").median() if "ADV20" in d else np.nan
            selected_adv.append(adv)
            rr.append((m,gross-turnover*cost_bps/10000.0,gross,turnover,cost))
            prev=cur
        return pd.DataFrame(rr,columns=["month_end","net_return","gross_return","turnover","cost"]).set_index("month_end"),selected_adv

    stress=[]
    for k in [int(x) for x in args.k_grid.split(",")]:
        for c in [float(x) for x in args.cost_grid.split(",")]:
            fr,advs=portfolio(k,c)
            h=fr.reindex(holdout).dropna()
            s=stats(h.net_return)
            med_adv=float(np.nanmedian(advs)) if advs else None
            participation=(args.initial_capital/med_adv) if med_adv and med_adv>0 else None
            stress.append({"k":k,"cost_bps":c,**s,"median_selected_ADV20":med_adv,
                           "initial_capital_to_ADV20":participation})

    # Redundancy / neutrality diagnostics against known factor families.
    exposures={}
    factor_cols=[c for c in d.columns if c not in {"symbol","month_end","adj_close","fwd1","score"} and
                 pd.api.types.is_numeric_dtype(d[c])]
    for f in factor_cols:
        exposures[f]=spearman(d["score"],d[f])
    redundancy=sorted(
        [{"factor":f,"abs_rank_corr":abs(v),"rank_corr":v} for f,v in exposures.items() if np.isfinite(v)],
        key=lambda x:(-x["abs_rank_corr"],x["factor"])
    )[:20]

    benchmark=None
    if args.benchmark:
        b=pd.read_csv(args.benchmark); b["month_end"]=pd.to_datetime(b.month_end)
        b["net_return"]=pd.to_numeric(b.net_return,errors="coerce")
        overlap=pd.DataFrame({"candidate":portfolio(20,20)[0].net_return}).join(
            b.set_index("month_end")["net_return"].rename("m1"),how="inner"
        ).dropna()
        benchmark={"sha256":hashlib.sha256(Path(args.benchmark).read_bytes()).hexdigest(),
                    "overlap_months":int(len(overlap)),
                    "candidate":stats(overlap.candidate),
                    "m1":stats(overlap.m1),
                    "candidate_minus_m1_geo":float(geo(overlap.candidate)-geo(overlap.m1)) if len(overlap) else None}

    result={
        "status":"COMPLETED","engine":"luna-research-scorecard-v1",
        "input_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "search_summary_sha256":hashlib.sha256(Path(args.search_summary).read_bytes()).hexdigest(),
        "formula_catalog_sha256":hashlib.sha256(Path(args.formula_catalog).read_bytes()).hexdigest(),
        "formula_id":fid,"formula":formula,
        "development_ic_mean":float(dev_ic.mean()) if len(dev_ic) else None,
        "development_icir_annualized":icir,
        "ic_month_count":int(len(ic)),
        "quintile_spread_mean":float(pd.DataFrame(candidate_spread).top_bottom_spread.mean()) if candidate_spread else None,
        "redundancy_top20":redundancy,
        "stress_grid":stress,
        "benchmark_overlap":benchmark,
        "holdout_start":str(holdout_months[0].date()),
        "holdout_end":str(holdout_months[1].date()),
        "promotion_checks":{
            "holdout_geo_positive":bool(summary["frozen_holdout"]["geo"]>0),
            "outer_oos_geo_positive":bool(summary["outer_oos_stats"]["geo"]>0),
            "ic_mean_positive":bool(ic.mean()>0) if len(ic) else False,
            "icir_positive":bool(icir is not None and icir>0),
            "cost_45bps_holdout_positive":bool(any(x["k"]==20 and x["cost_bps"]==45 and x["geo"]>0 for x in stress)),
            "k10_k20_k30_k50_all_positive_at20bps":bool(all(
                x["geo"]>0 for x in stress if x["cost_bps"]==20 and x["k"] in {10,20,30,50}
            )),
        },
        "note":"Diagnostics and promotion checks do not alter formula selection or the frozen holdout."
    }
    (out/"scorecard.json").write_text(json.dumps(result,indent=2,default=str),encoding="utf-8")
    print(json.dumps(result,indent=2,default=str))

if __name__=="__main__":
    main()
