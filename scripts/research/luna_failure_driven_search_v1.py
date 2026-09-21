#!/usr/bin/env python3
"""LUNA failure-driven search v1.

Research trigger revision: institutional benchmark path-based CI validation.

The search never chooses a strategy using the frozen holdout. Candidate
selection is nested walk-forward: inner train -> validation, then outer OOS.
A locked M1 benchmark CSV is loaded only for reference/reporting.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

BASE_FACTORS=[
    "REV21","MOM_5","MOM_10","MOM_20","MOM_40","MOM_60","MOM_120","MOM_252",
    "REL_MOM","VOL_10","VOL_20","MAXDD_60","ATR_PCT","ADV20","AMOUNT",
    "ILLIQ_20","BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60",
    "DIST_HIGH_252","SKEW_20","SKEW_60",
    # PIT fundamentals/composites become eligible automatically once coverage exists.
    "PE","PBV","EV_EBITDA","FCF_YIELD","EARNINGS_YIELD","DIV_YIELD",
    "ROE","ROA","ROIC","GPM","NPM","CFO_MARGIN","REV_G","EPS_G","NI_G","FCF_G",
    "ASSET_G","CAPEX_G","INVESTMENT_RATE","DIV_G","PAYOUT","BUYBACK","DE",
    "NET_DEBT_EBITDA","INTEREST_COVER","CURRENT_RATIO","TURNOVER",
    "QUALITY_SCORE","VALUE_QUALITY","MOM_BLEND","CONSERVATIVE_SCORE",
    "SAFETY_SCORE","GROWTH_QUALITY","INV_QUALITY"
]

def geo(x):
    x=np.asarray(x,dtype=float); x=x[np.isfinite(x)]
    if len(x)==0 or np.any(x<=-1): return -1.0
    return float(np.expm1(np.log1p(x).mean()))

def stats(x):
    a=np.asarray(x,dtype=float); a=a[np.isfinite(a)]
    if len(a)==0:
        return {"months":0,"geo":-1.0,"cum":-1.0,"pos":0.0,"dd":None,"ge7":0}
    eq=np.cumprod(1+a); peak=np.maximum.accumulate(eq); dd=eq/peak-1
    return {"months":int(len(a)),"geo":geo(a),"cum":float(eq[-1]-1),
            "pos":float((a>0).mean()),"dd":float(dd.min()),
            "ge7":int((a>=.07).sum()),"min":float(a.min()),"max":float(a.max())}

def rank_matrix(d, factors):
    return {f:d.groupby("month_end")[f].rank(pct=True,method="average").to_numpy()
            for f in factors}

def make_catalog(count, seed, factors):
    rng=np.random.default_rng(seed)
    formulas=[{"id":"M1_REV21_K20","kind":"benchmark_proxy","terms":[["REV21",1.0]]}]
    # Failure-driven families: pure factors, signed blends, pair interactions,
    # and regime-like gated blends built from ranked signals.
    families=["single","pair","blend3","blend4","interaction","gated"]
    for i in range(1,count):
        family=families[(i-1)%len(families)]
        if family=="single":
            fs=[factors[int(rng.integers(len(factors)))]]
        elif family=="pair":
            fs=list(rng.choice(factors,size=2,replace=False))
        elif family=="blend3":
            fs=list(rng.choice(factors,size=3,replace=False))
        elif family in ("blend4","interaction","gated"):
            fs=list(rng.choice(factors,size=4,replace=False))
        raw=rng.uniform(.15,1.0,size=len(fs))
        sign=rng.choice([-1.0,1.0],size=len(fs))
        w=raw*sign; w=w/np.sum(np.abs(w))
        formulas.append({"id":f"F{i:05d}","kind":family,
                         "terms":[[f,float(v)] for f,v in zip(fs,w)]})
    return formulas

def score_formula(formula, ix, ranks, args):
    sc=np.zeros(len(ix),dtype=float)
    terms=formula["terms"]
    for f,w in terms:
        sc += ranks[f][ix]*float(w)
    kind=formula["kind"]
    if kind=="interaction" and len(terms)>=2:
        a=ranks[terms[0][0]][ix]; b=ranks[terms[1][0]][ix]
        sc += args.interaction_strength*((a-0.5)*(b-0.5))
    elif kind=="gated" and len(terms)>=2:
        gate=ranks[terms[0][0]][ix] > args.gate_threshold
        sc=np.where(gate,sc,sc-args.gate_penalty)
    return sc

def formula_returns(d, months, rows, ranks, formula, k, cost_bps):
    prev=set(); out=[]
    for m in months:
        ix=rows[m]
        sc=score_formula(formula,ix,ranks,ARGS)
        good=np.isfinite(sc) & d.loc[ix,"fwd1"].notna().to_numpy()
        vix=ix[good]
        if len(vix)==0: continue
        order=vix[np.argsort(-sc[good],kind="mergesort")[:k]]
        if len(order)==0: continue
        cur=set(d.loc[order,"symbol"].astype(str))
        gross=float(d.loc[order,"fwd1"].mean())
        turnover=1.0 if not prev else 1.0-len(cur&prev)/float(k)
        cost=turnover*cost_bps/10000.0
        out.append((m,gross,gross-cost,turnover,cost))
        prev=cur
    return pd.DataFrame(out,columns=["month_end","gross_return","net_return","turnover","cost"]).set_index("month_end")

def select_best(candidates, train_months, valid_months, min_hist, diversity_penalty):
    board=[]
    for fid,fr in candidates.items():
        tr=fr.reindex(train_months).net_return.dropna()
        va=fr.reindex(valid_months).net_return.dropna()
        if len(tr)<min_hist or len(va)<max(3,min_hist//2): continue
        # Stability-first objective: validation performance dominates, with
        # train consistency and drawdown controls to reduce overfit.
        s_tr=stats(tr); s_va=stats(va)
        objective=(s_va["geo"] + 0.35*s_tr["geo"]
                   - 0.25*abs(s_va["dd"]) - diversity_penalty*max(0,0.5-s_va["pos"]))
        board.append((objective,s_va["geo"],s_va["pos"],s_va["dd"],fid))
    board.sort(key=lambda z:(-z[0],-z[1],-z[2],z[4]))
    return board[0] if board else None, board

def main():
    global ARGS
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True); ap.add_argument("--output",required=True)
    ap.add_argument("--benchmark",required=False)
    ap.add_argument("--formula-count",type=int,default=5000)
    ap.add_argument("--seed",type=int,default=20260921)
    ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--cost-bps",type=float,default=20)
    ap.add_argument("--lookback-months",type=int,default=24)
    ap.add_argument("--inner-train-months",type=int,default=12)
    ap.add_argument("--inner-valid-months",type=int,default=6)
    ap.add_argument("--outer-holdout-months",type=int,default=12)
    ap.add_argument("--min-history-months",type=int,default=9)
    ap.add_argument("--interaction-strength",type=float,default=0.50)
    ap.add_argument("--gate-threshold",type=float,default=0.55)
    ap.add_argument("--gate-penalty",type=float,default=0.10)
    ap.add_argument("--diversity-penalty",type=float,default=0.10)
    args=ap.parse_args(); ARGS=args
    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)

    d=pd.read_csv(args.input)
    required={"symbol","month_end","adj_close","fwd1",*BASE_FACTORS}
    miss=sorted(required-set(d.columns))
    if miss: raise SystemExit(f"missing columns: {miss}")
    d["month_end"]=pd.to_datetime(d.month_end); d["symbol"]=d.symbol.astype(str)
    for c in ["adj_close","fwd1",*BASE_FACTORS]: d[c]=pd.to_numeric(d[c],errors="coerce")
    d=d.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"]).reset_index(drop=True)
    coverage={f:float(d[f].notna().mean()) for f in BASE_FACTORS}
    factors=[f for f in BASE_FACTORS if coverage[f]>=0.50]
    if "REV21" not in factors: raise SystemExit("REV21 coverage <50%")
    months=sorted(d.month_end.dropna().unique().tolist())
    if len(months)<args.outer_holdout_months+args.lookback_months+args.inner_valid_months+3:
        raise SystemExit("insufficient monthly history")
    rows={m:d.index[d.month_end.eq(m)].to_numpy() for m in months}
    ranks=rank_matrix(d,factors)
    formulas=make_catalog(args.formula_count,args.seed,factors)
    (out/"formula_catalog.json").write_text(json.dumps(formulas,indent=2),encoding="utf-8")

    candidates={}
    for fml in formulas:
        candidates[fml["id"]]=formula_returns(d,months,rows,ranks,fml,args.k,args.cost_bps)

    # Persist the complete monthly return matrix so downstream statistical
    # diagnostics can test the full searched family without recomputing signals.
    return_matrix=pd.DataFrame({
        fid: fr["net_return"].reindex(months)
        for fid,fr in candidates.items()
    }, index=pd.Index(months,name="month_end"))
    return_matrix.to_csv(out/"formula_return_matrix.csv.gz",compression="gzip")

    # Frozen holdout: NEVER used in candidate construction/selection.
    holdout=months[-args.outer_holdout_months:]
    development=months[:-args.outer_holdout_months]
    outer_ledger=[]; chosen_counter={}
    # Outer OOS begins only after enough prior history; each outer month picks from
    # an inner validation process inside the preceding development window.
    for j,m in enumerate(development):
        prior=development[max(0,j-args.lookback_months):j]
        if len(prior)<args.inner_train_months+args.inner_valid_months: continue
        train=prior[-(args.inner_train_months+args.inner_valid_months):-args.inner_valid_months]
        valid=prior[-args.inner_valid_months:]
        best,_=select_best(candidates,train,valid,args.min_history_months,args.diversity_penalty)
        if best is None or m not in candidates[best[4]].index: continue
        fid=best[4]; r=candidates[fid].loc[m]
        outer_ledger.append({"month_end":m,"train_start":train[0],"train_end":train[-1],
            "valid_start":valid[0],"valid_end":valid[-1],"formula_id":fid,
            "selection_objective":best[0],"valid_geo":best[1],"valid_pos":best[2],
            "realized_return":float(r.net_return),"turnover":float(r.turnover)})
        chosen_counter[fid]=chosen_counter.get(fid,0)+1

    # Final development selection is performed once, immediately before holdout.
    prior=development[-args.lookback_months:]
    train=prior[-(args.inner_train_months+args.inner_valid_months):-args.inner_valid_months]
    valid=prior[-args.inner_valid_months:]
    final_best,board=select_best(candidates,train,valid,args.min_history_months,args.diversity_penalty)
    if final_best is None: raise SystemExit("no final candidate survived selection")
    final_fid=final_best[4]

    holdout_fr=candidates[final_fid].reindex(holdout).dropna()
    holdout_stats=stats(holdout_fr.net_return)
    selected_formula=next(x for x in formulas if x["id"]==final_fid)

    outer=pd.DataFrame(outer_ledger)
    outer.to_csv(out/"outer_oos_ledger.csv",index=False)
    pd.DataFrame(board[:200],columns=["objective","valid_geo","valid_pos","valid_dd","formula_id"]).to_csv(out/"final_selection_board.csv",index=False)

    # Full-period descriptive table is explicitly non-selection evidence.
    full=[]
    for fid,fr in candidates.items():
        s=stats(fr.net_return)
        full.append({"formula_id":fid,**s})
    pd.DataFrame(full).sort_values(["geo","pos"],ascending=[False,False]).to_csv(out/"full_period_descriptive.csv",index=False)

    benchmark=None
    if args.benchmark:
        b=pd.read_csv(args.benchmark)
        benchmark={"path":args.benchmark,"sha256":hashlib.sha256(Path(args.benchmark).read_bytes()).hexdigest()}
        if "net_return" in b:
            benchmark["stats"]=stats(b["net_return"].to_numpy())
        if "month_end" in b:
            benchmark["months"]=int(b["month_end"].nunique())

    summary={
        "status":"COMPLETED","engine":"luna-failure-driven-search-v1",
        "input_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "formula_count":len(formulas),"seed":args.seed,"factors":factors,
        "factor_coverage":coverage,"months_available":len(months),
        "development_months":len(development),"holdout_months":len(holdout),
        "outer_oos_months":int(len(outer)),"outer_oos_stats":stats(outer["realized_return"] if len(outer) else []),
        "final_formula":selected_formula,"final_selection":final_best[:4],
        "frozen_holdout":holdout_stats,"holdout_start":str(holdout[0]),"holdout_end":str(holdout[-1]),
        "benchmark_locked":benchmark,
        "top_outer_selected":[{"formula_id":k,"count":v} for k,v in sorted(chosen_counter.items(),key=lambda z:(-z[1],z[0]))[:20]],
        "selection_rule":"nested walk-forward: inner train -> recent validation -> outer realized month",
        "holdout_rule":"final formula fixed before holdout; holdout never used for formula search",
        "leakage_guard":"current-month fwd1 is never part of same-month or future selection history",
        "formula_search_families":["single","pair","blend3","blend4","interaction","gated"],
        "initial_capital_baht":30000
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__": main()

# CI trigger: rerun validated failure-driven search after publish-race fix. Universe/sector robustness, multiple-testing, fresh-seed replication, and PIT factors are now part of the downstream evidence chain.
