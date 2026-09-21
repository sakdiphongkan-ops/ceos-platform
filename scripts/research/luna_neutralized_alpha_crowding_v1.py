#!/usr/bin/env python3
"""LUNA Neutralized Alpha & Crowding v1.

Measures whether a candidate's signal contains predictive information after
cross-sectional neutralization against known factor families, and whether the
candidate is redundant with benchmark/peer signals.

This is diagnostic only and never changes frozen holdout selection.
"""
from __future__ import annotations
import argparse, hashlib, json, math
from pathlib import Path
import numpy as np
import pandas as pd

def corr(a,b):
    z=pd.DataFrame({"a":a,"b":b}).dropna()
    if len(z)<5:return np.nan
    return float(z.a.rank().corr(z.b.rank()))

def neutralize(y,X):
    mask=np.isfinite(y)
    for c in range(X.shape[1]): mask &= np.isfinite(X[:,c])
    out=np.full(len(y),np.nan)
    if mask.sum()<X.shape[1]+2:return out
    A=np.column_stack([np.ones(mask.sum()),X[mask]])
    beta=np.linalg.lstsq(A,y[mask],rcond=None)[0]
    out[mask]=y[mask]-A@beta
    return out

def formula_score(g,terms,kind):
    s=np.zeros(len(g))
    ranks={c:g[c].rank(pct=True,method="average").to_numpy() for c,_ in terms}
    for f,w in terms:s += ranks[f]*float(w)
    if kind=="interaction" and len(terms)>=2:
        a=ranks[terms[0][0]]; b=ranks[terms[1][0]]
        s += 0.50*(a-0.5)*(b-0.5)
    if kind=="gated" and len(terms)>=2:
        gate=ranks[terms[0][0]]>0.55
        s=np.where(gate,s,s-0.10)
    return s

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--search-summary",required=True)
    ap.add_argument("--formula-catalog",required=True)
    ap.add_argument("--benchmark",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--peer-count",type=int,default=25)
    args=ap.parse_args()
    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)

    d=pd.read_csv(args.input); d["month_end"]=pd.to_datetime(d.month_end)
    for c in d.columns:
        if c not in {"symbol","month_end"}: d[c]=pd.to_numeric(d[c],errors="coerce")
    summary=json.loads(Path(args.search_summary).read_text())
    catalog=json.loads(Path(args.formula_catalog).read_text())
    final_id=summary["final_formula"]["id"]
    final=next(x for x in catalog if x["id"]==final_id)

    neutralizers=[
        c for c in ["MOM_20","MOM_60","MOM_120","VOL_20","MAXDD_60","ADV20","AMOUNT",
                    "DIST_MA20","DIST_MA60","DIST_HIGH_252","RSI14"]
        if c in d.columns
    ]
    months=sorted(d.month_end.dropna().unique())
    raw_ic=[]; neutral_ic=[]; churn=[]; prev_resid=None

    # Final candidate neutral alpha series.
    resid_by_month={}
    raw_by_month={}
    for m,g0 in d.groupby("month_end",sort=True):
        g=g0.copy()
        score=formula_score(g,final["terms"],final.get("kind","blend"))
        y=g["fwd1"].to_numpy()
        raw=corr(score,y)
        X=np.column_stack([g[c].rank(pct=True,method="average").to_numpy() for c in neutralizers])
        resid=neutralize(score,X)
        ric=corr(resid,y)
        raw_ic.append(raw); neutral_ic.append(ric)
        if np.isfinite(ric):
            resid_by_month[m]=pd.Series(resid,index=g.symbol.astype(str)).dropna()
            if prev_resid is not None:
                common=prev_resid.index.intersection(resid_by_month[m].index)
                if len(common)>=5:
                    churn.append(1-corr(prev_resid.loc[common],resid_by_month[m].loc[common]))
            prev_resid=resid_by_month[m]
            raw_by_month[m]=pd.Series(score,index=g.symbol.astype(str)).dropna()

    # Peer crowding: use the final-selection board, then measure maximum rank
    # correlation to final candidate on each month. Benchmark M1 is separate.
    board_path=Path(args.search_summary).with_name("final_selection_board.csv")
    peer_ids=[]
    if board_path.exists():
        b=pd.read_csv(board_path).head(args.peer_count)
        peer_ids=[x for x in b.formula_id.astype(str).tolist() if x!=final_id]
    formulas={x["id"]:x for x in catalog}
    peer_corrs={x:[] for x in peer_ids}
    for m,g in d.groupby("month_end",sort=True):
        final_s=formula_score(g,final["terms"],final.get("kind","blend"))
        for fid in peer_ids:
            f=formulas.get(fid)
            if not f: continue
            ps=formula_score(g,f["terms"],f.get("kind","blend"))
            cc=corr(final_s,ps)
            if np.isfinite(cc): peer_corrs[fid].append(cc)

    crowd=[]
    for fid,v in peer_corrs.items():
        if v:
            crowd.append({"peer_formula_id":fid,"mean_rank_corr":float(np.mean(v)),
                          "max_abs_rank_corr":float(np.max(np.abs(v)))})
    crowd=sorted(crowd,key=lambda x:(-x["max_abs_rank_corr"],x["peer_formula_id"]))

    b=pd.read_csv(args.benchmark); b["month_end"]=pd.to_datetime(b.month_end)
    b["net_return"]=pd.to_numeric(b["net_return"],errors="coerce")
    bench=[]
    for m,g0 in d.groupby("month_end",sort=True):
        if m not in set(b.month_end): continue
        fs=formula_score(g0,final["terms"],final.get("kind","blend"))
        bm=float(b.loc[b.month_end.eq(m),"net_return"].iloc[0])
        # Compare stock-level final signal with benchmark is unavailable from the
        # locked monthly return file; compare monthly residual-alpha IC only.
        bench.append({"month_end":str(m.date()),"benchmark_net_return":bm})

    raw=np.asarray([x for x in raw_ic if np.isfinite(x)])
    ric=np.asarray([x for x in neutral_ic if np.isfinite(x)])
    result={
      "status":"COMPLETED","engine":"luna-neutralized-alpha-crowding-v1",
      "input_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
      "search_summary_sha256":hashlib.sha256(Path(args.search_summary).read_bytes()).hexdigest(),
      "formula_catalog_sha256":hashlib.sha256(Path(args.formula_catalog).read_bytes()).hexdigest(),
      "benchmark_sha256":hashlib.sha256(Path(args.benchmark).read_bytes()).hexdigest(),
      "formula_id":final_id,"formula":final,"neutralizers":neutralizers,
      "raw_ic_mean":float(raw.mean()) if len(raw) else None,
      "raw_ic_std":float(raw.std(ddof=1)) if len(raw)>1 else None,
      "neutral_ic_mean":float(ric.mean()) if len(ric) else None,
      "neutral_ic_std":float(ric.std(ddof=1)) if len(ric)>1 else None,
      "neutral_icir_annualized":float(ric.mean()/ric.std(ddof=1)*math.sqrt(12)) if len(ric)>1 and ric.std(ddof=1)>0 else None,
      "neutral_churn_mean":float(np.mean(churn)) if churn else None,
      "neutral_churn_month_pairs":len(churn),
      "crowding_peers":crowd[:args.peer_count],
      "crowding_max_abs_corr":float(max((x["max_abs_rank_corr"] for x in crowd),default=np.nan)),
      "benchmark_months_overlap":len(bench),
      "interpretation_guard":"neutralized IC and crowding are diagnostics; no selection or holdout tuning is performed here"
    }
    (out/"neutralized-alpha-crowding.json").write_text(json.dumps(result,indent=2,default=str),encoding="utf-8")
    print(json.dumps(result,indent=2,default=str))

if __name__=="__main__": main()
