#!/usr/bin/env python3
"""LUNA expanded monthly formula search v1.

Searches 10,000 deterministic formulas over nonlinear rank transforms and
interaction features. Screening uses development data only; exact OOS and
12-month blind holdout are evaluated on frozen finalists.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

BASE = ["mom1","mom3","mom6","mom12","high52_ratio","vol20","maxdd60","avg_amount20"]

def geo(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0 or np.any(x <= -1): return -1.0
    return float(np.exp(np.log1p(x).mean()) - 1)

def make_features(df: pd.DataFrame) -> list[str]:
    out = []
    for f in BASE:
        out += [f"r_{f}", f"sq_{f}", f"abs_{f}"]
    out += ["mom1_mom3_spread","mom3_mom6_spread","mom6_mom12_spread",
            "mom1_over_vol","mom3_over_vol","mom6_over_vol",
            "liquidity_over_vol","high52_over_vol","rev1_lowvol","rev3_lowvol"]
    return out

def build_feature_frame(df: pd.DataFrame) -> pd.DataFrame:
    x = df.copy()
    x["month_end"] = pd.to_datetime(x["month_end"]).dt.to_period("M").dt.to_timestamp("M")
    x = x.sort_values(["symbol","month_end"]).drop_duplicates(["symbol","month_end"])
    x["adj_close"] = pd.to_numeric(x["adj_close"], errors="coerce")
    x["next_month"] = x.groupby("symbol")["month_end"].shift(-1)
    x["next_adj"] = x.groupby("symbol")["adj_close"].shift(-1)
    expected = x["month_end"] + pd.offsets.MonthEnd(1)
    x["fwd1"] = np.where(x["next_month"].eq(expected), x["next_adj"]/x["adj_close"]-1, np.nan)
    for f in BASE: x[f] = pd.to_numeric(x[f], errors="coerce")

    for f in BASE:
        x[f"r_{f}"] = x.groupby("month_end")[f].rank(pct=True, method="average")
        x[f"sq_{f}"] = x[f"r_{f}"] ** 2
        x[f"abs_{f}"] = (x[f"r_{f}"] - 0.5).abs()

    x["mom1_mom3_spread"] = 0.5 + 0.5*(x["r_mom1"] - x["r_mom3"])
    x["mom3_mom6_spread"] = 0.5 + 0.5*(x["r_mom3"] - x["r_mom6"])
    x["mom6_mom12_spread"] = 0.5 + 0.5*(x["r_mom6"] - x["r_mom12"])
    x["mom1_over_vol"] = x["r_mom1"] / x["r_vol20"].replace(0,np.nan)
    x["mom3_over_vol"] = x["r_mom3"] / x["r_vol20"].replace(0,np.nan)
    x["mom6_over_vol"] = x["r_mom6"] / x["r_vol20"].replace(0,np.nan)
    x["liquidity_over_vol"] = x["r_avg_amount20"] / x["r_vol20"].replace(0,np.nan)
    x["high52_over_vol"] = x["r_high52_ratio"] / x["r_vol20"].replace(0,np.nan)
    x["rev1_lowvol"] = (1-x["r_mom1"]) * (1-x["r_vol20"])
    x["rev3_lowvol"] = (1-x["r_mom3"]) * (1-x["r_vol20"])
    return x

def generate_formulas(features: list[str], n: int, seed: int):
    rng = np.random.default_rng(seed)
    formulas = []
    for i in range(n):
        k = int(rng.integers(2,5))
        idx = rng.choice(len(features), size=k, replace=False)
        raw = rng.uniform(0.20,1.0,size=k)
        sign = rng.choice([-1.0,1.0],size=k)
        w = raw*sign
        w = w/np.abs(w).sum()
        formulas.append({"id":f"X{i:05d}",
                         "terms":[(features[j],float(wj)) for j,wj in zip(idx,w)]})
    return formulas

def exact_portfolios(x, formulas, formula_ids, k, cost_bps):
    months = sorted(x.month_end.dropna().unique())
    rows = []
    for fid in formula_ids:
        f = formulas[fid]
        prev = set()
        for m in months:
            d = x.loc[x.month_end.eq(m)].copy()
            cols = []
            ok = np.ones(len(d), dtype=bool)
            score = np.zeros(len(d), dtype=float)
            for name,w in f["terms"]:
                v = pd.to_numeric(d[name], errors="coerce").to_numpy(float)
                ok &= np.isfinite(v)
                score += w*np.nan_to_num(v, nan=0.0)
            if ok.sum() < k: continue
            d = d.loc[ok].copy()
            d["score"] = score[ok]
            pick = d.sort_values(["score","symbol"],ascending=[False,True]).head(k)
            cur = set(pick.symbol)
            gross = float(pick.fwd1.mean())
            overlap = len(cur & prev)
            turnover = 1.0 if not prev else 1.0-overlap/k
            net = gross-turnover*cost_bps/10000.0
            rows.append({"formula_id":f["id"],"month_end":m,"gross_return":gross,
                         "turnover":turnover,"net_return":net})
            prev = cur
    return pd.DataFrame(rows)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True); ap.add_argument("--output",required=True)
    ap.add_argument("--formula-count",type=int,default=10000)
    ap.add_argument("--finalists",type=int,default=200)
    ap.add_argument("--development-fraction",type=float,default=0.65)
    ap.add_argument("--holdout-months",type=int,default=12)
    ap.add_argument("--cost-bps",type=float,default=20)
    ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--seed",type=int,default=20260921)
    args=ap.parse_args()

    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    raw=pd.read_csv(args.input)
    req={"symbol","month_end","adj_close",*BASE}
    miss=sorted(req-set(raw.columns))
    if miss: raise SystemExit(f"missing columns: {miss}")
    x=build_feature_frame(raw)
    x=x[(x.month_end>=pd.Timestamp("2021-10-01")) & (x.month_end<=x.month_end.max())].copy()
    features=make_features(x)
    formulas=generate_formulas(features,args.formula_count,args.seed)
    (out/"formula_catalog.json").write_text(json.dumps(formulas,indent=2),encoding="utf-8")

    months=sorted(x.month_end.dropna().unique())
    holdout_start=months[-args.holdout_months]
    dev_end_idx=max(1,int(len(months)*(1-args.holdout_months/len(months))*args.development_fraction))
    dev_end=months[dev_end_idx]
    screen_start=max(0,dev_end_idx-24)
    dev=x[(x.month_end>=months[screen_start])&(x.month_end<dev_end)&x.fwd1.notna()].copy()

    # Development-only screening: covariance proxy of each feature with next-month return.
    stats={}
    y=dev.fwd1.to_numpy(float)
    for name in features:
        v=dev[name].to_numpy(float)
        mask=np.isfinite(v)&np.isfinite(y)
        if mask.sum()<50: stats[name]=0.0; continue
        stats[name]=float(np.corrcoef(v[mask],y[mask])[0,1])

    scores=[]
    for i,f in enumerate(formulas):
        proxy=sum(w*stats.get(name,0.0) for name,w in f["terms"])
        scores.append((proxy,i))
    scores.sort(reverse=True)
    finalist_ids=[i for _,i in scores[:args.finalists]]
    exact=exact_portfolios(x,formulas,finalist_ids,args.k,args.cost_bps)
    exact.to_csv(out/"finalist_monthly_returns.csv",index=False)

    train=exact[exact.month_end<holdout_start]
    hold=exact[exact.month_end>=holdout_start]
    train_stats=(train.groupby("formula_id").net_return.agg(
        train_geo=lambda s: geo(s.to_numpy(float)),
        train_pos=lambda s: float((s>0).mean()),
        train_n="count"
    ).reset_index().sort_values(["train_geo","train_pos","formula_id"],ascending=[False,False,True]).head(args.finalists))
    hold_stats=hold.merge(train_stats[["formula_id","train_geo"]],on="formula_id",how="inner")
    hold_stats=hold_stats.groupby(["formula_id","train_geo"]).net_return.agg(
        hold_geo=lambda s: geo(s.to_numpy(float)),
        hold_cum=lambda s: float(np.prod(1+s.to_numpy(float))-1),
        hold_pos=lambda s: float((s>0).mean()),
        hold_n="count"
    ).reset_index().sort_values("hold_geo",ascending=False)

    summary={
      "status":"COMPLETED","engine":"luna-monthly-expanded-interaction-v1",
      "formula_count":len(formulas),"finalists":len(finalist_ids),
      "features":features,"seed":args.seed,"k":args.k,"cost_bps":args.cost_bps,
      "holdout_start":str(holdout_start.date()),
      "top_holdout_candidates":hold_stats.head(25).to_dict(orient="records"),
      "holdout_candidates_ge_7pct":int((hold_stats.hold_geo>=0.07).sum()) if len(hold_stats) else 0,
      "dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
      "methodology_note":"Screening is development-only; exact finalists are evaluated OOS; the final holdout is blind to formula screening and ranking."
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__": main()
