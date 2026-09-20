#!/usr/bin/env python3
"""LUNA TradingView Strategy Tournament v1.

Uses the LUNA TradingView-derived indicator panel as a research feature set.
The locked M1 selector remains the control:
  bottom-K by completed calendar-month adjusted-close return at month-end.

Candidate groups:
- TradingView Technical Ratings
- exact/near-exact indicator confluence
- mean-reversion + trend filters
- squeeze / breakout
- Supertrend + RSI
- Ichimoku + RSI + MACD
- RSI divergence + reversal candle
- OBV/liquidity confirmation
- rank/blend formulas over an M1 pool of 50 or 100

All candidate rules are deterministic and evaluated causal-first.
TRAIN+DEV select finalists; OOS/HOLDOUT remain frozen.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Candidate:
    code: str
    kind: str
    pool: int
    rule: str


def perf(x: np.ndarray) -> dict:
    x=np.asarray(x,dtype=float)
    x=x[np.isfinite(x)]
    if len(x)==0:
        return {"months":0,"geo_monthly":-1.0,"cumulative":-1.0,
                "positive_month_pct":0.0,"worst_month":None,"best_month":None,
                "max_drawdown_pct":None}
    eq=np.cumprod(1+x)
    peak=np.maximum.accumulate(eq)
    dd=eq/peak-1
    return {
        "months":int(len(x)),
        "geo_monthly":float(np.expm1(np.log1p(x).mean())),
        "cumulative":float(eq[-1]-1),
        "positive_month_pct":float((x>0).mean()),
        "worst_month":float(x.min()),
        "best_month":float(x.max()),
        "max_drawdown_pct":float(dd.min()),
    }


def build_candidates() -> list[Candidate]:
    out=[]
    # Gate candidates: stock selection remains M1 bottom-20.
    gate_specs=[
        ("BASELINE","BASE","M1_BASE"),
        ("TV_ALL_BUY","TV","TV_ALL_D>0.1"),
        ("TV_ALL_STRONG","TV","TV_ALL_D>0.5"),
        ("TV_OSC_BUY","TV","TV_OSC_D>0.1"),
        ("TV_OSC_STRONG","TV","TV_OSC_D>0.5"),
        ("TV_MA_BUY","TV","TV_MA_D>0.1"),
        ("TV_REVERSAL","TV","TV_OSC_D>0.1 & TV_MA_D<0.1"),
        ("TV_REVERSAL_STRONG","TV","TV_OSC_D>0.5 & TV_MA_D<0"),
        ("TV_MTF_ALL","TV","TV_ALL_D>0.1 & TV_ALL_W>0.1 & TV_ALL_M>0.1"),
        ("TV_MTF_OSC","TV","TV_OSC_D>0.1 & TV_OSC_W>0.1 & TV_OSC_M>0.1"),
        ("SUPER_RSI_TREND","STRATEGY","ST10X30_DIR==1 & RSI14<70 & close>SMA200"),
        ("RSI2_PULLBACK","STRATEGY","RSI2<5 & close>SMA200 & WPR14<-90"),
        ("BB_RSI_MACD_ADX","STRATEGY","close<BB_LOWER20 & RSI14<35 & MACD>MACD_SIGNAL & ADX14>20"),
        ("BB_REENTRY_RSI","STRATEGY","BB_REENTRY_UP==1 & RSI14<50"),
        ("SQUEEZE_RELEASE_MOM","STRATEGY","SQUEEZE_RELEASE==1 & MACD_HIST>0 & close>EMA20"),
        ("SQUEEZE_KC15_MOM","STRATEGY","SQUEEZE_KC_RELEASE_15==1 & MACD_HIST>0 & close>EMA20"),
        ("SQUEEZE_KC20_TV","STRATEGY","SQUEEZE_KC_RELEASE_20==1 & TV_ALL_D>0.1"),
        ("DONCHIAN55_TV","STRATEGY","BREAKOUT55==1 & TV_MA_D>0"),
        ("DONCHIAN55_ADX","STRATEGY","BREAKOUT55==1 & ADX14>20 & TV_MA_D>0"),
        ("ICHIMOKU_RSI_MACD","STRATEGY","price_above_cloud & RSI14>30 & MACD>MACD_SIGNAL"),
        ("RSI_DIV_HAMMER","REVERSAL","RSI_BULL_DIV_PROXY==1 & BULL_REVERSAL==1"),
        ("RSI_DIV_TV_OSC","REVERSAL","RSI_BULL_DIV_PROXY==1 & TV_OSC_D>0.1"),
        ("OBV_TV_CONFIRM","VOLUME","OBV_SLOPE20>0 & TV_ALL_D>0.1"),
        ("ATRP_RISK_GATE","RISK","ATRP14_RANK60<0.8"),
        ("STRENGTH_NOT_DEEP","RISK","DIST_MA60>-0.2 & ADX14<35"),
    ]
    for code,kind,rule in gate_specs:
        out.append(Candidate(code,kind,20,rule))

    # Pool re-ranking: expand the M1 reversal pool, then use TradingView
    # features as a second-stage rank. This is an M1 evolution, not production.
    blend_specs=[
        ("POOL50_TVALL",50,"rank(-M1_MOM20_ADJ)+rank(TV_ALL_D)"),
        ("POOL50_TVOSC",50,"rank(-M1_MOM20_ADJ)+rank(TV_OSC_D)"),
        ("POOL50_REVERSAL",50,"rank(-M1_MOM20_ADJ)+rank(TV_OSC_D)-rank(TV_MA_D)"),
        ("POOL50_MTF",50,"rank(-M1_MOM20_ADJ)+rank(TV_ALL_D)+rank(TV_ALL_W)+rank(TV_ALL_M)"),
        ("POOL50_ST",50,"rank(-M1_MOM20_ADJ)+rank(ST10X30_DIR)"),
        ("POOL50_SQUEEZE",50,"rank(-M1_MOM20_ADJ)+rank(SQUEEZE_RELEASE)+rank(MACD_HIST)"),
        ("POOL50_RSI_DIV",50,"rank(-M1_MOM20_ADJ)+rank(RSI_BULL_DIV_PROXY)+rank(TV_OSC_D)"),
        ("POOL50_VOLUME",50,"rank(-M1_MOM20_ADJ)+rank(OBV_Z20)+rank(TV_MA_D)"),
        ("POOL100_TVALL",100,"rank(-M1_MOM20_ADJ)+rank(TV_ALL_D)"),
        ("POOL100_MTF",100,"rank(-M1_MOM20_ADJ)+rank(TV_ALL_D)+rank(TV_ALL_W)+rank(TV_ALL_M)"),
    ]
    for code,pool,rule in blend_specs:
        out.append(Candidate(code,"RERANK",pool,rule))
    return out


def load_panel(path: str) -> pd.DataFrame:
    df=pd.read_csv(path,parse_dates=["month_end"])
    req={"symbol","month_end","adj_close","M1_MOM20_ADJ"}
    miss=sorted(req-set(df.columns))
    if miss:
        raise SystemExit(f"missing required panel columns: {miss}")
    numeric=[c for c in df.columns if c not in {"symbol","date","month_end"}]
    for c in numeric:
        df[c]=pd.to_numeric(df[c],errors="coerce")
    return df.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"]).reset_index(drop=True)


def add_forward(df: pd.DataFrame) -> pd.DataFrame:
    x=df[["symbol","month_end","adj_close"]].copy().sort_values(["symbol","month_end"])
    x["next_month"]=x.groupby("symbol")["month_end"].shift(-1)
    x["next_adj"]=x.groupby("symbol")["adj_close"].shift(-1)
    x["fwd_month"]=np.where(
        x["next_month"].eq(x["month_end"]+pd.offsets.MonthEnd(1)),
        x["next_adj"]/x["adj_close"]-1,
        np.nan
    )
    return df.merge(x[["symbol","month_end","fwd_month"]],on=["symbol","month_end"],how="left")


def bool_gate(g: pd.DataFrame, rule: str) -> pd.Series:
    x=g
    if rule=="M1_BASE":
        return pd.Series(True,index=x.index)
    if rule=="TV_ALL_D>0.1":
        return x["TV_ALL_D"]>0.1
    if rule=="TV_ALL_D>0.5":
        return x["TV_ALL_D"]>0.5
    if rule=="TV_OSC_D>0.1":
        return x["TV_OSC_D"]>0.1
    if rule=="TV_OSC_D>0.5":
        return x["TV_OSC_D"]>0.5
    if rule=="TV_MA_D>0.1":
        return x["TV_MA_D"]>0.1
    if rule=="TV_OSC_D>0.1 & TV_MA_D<0.1":
        return (x["TV_OSC_D"]>0.1)&(x["TV_MA_D"]<0.1)
    if rule=="TV_OSC_D>0.5 & TV_MA_D<0":
        return (x["TV_OSC_D"]>0.5)&(x["TV_MA_D"]<0)
    if rule=="TV_ALL_D>0.1 & TV_ALL_W>0.1 & TV_ALL_M>0.1":
        return (x["TV_ALL_D"]>0.1)&(x["TV_ALL_W"]>0.1)&(x["TV_ALL_M"]>0.1)
    if rule=="TV_OSC_D>0.1 & TV_OSC_W>0.1 & TV_OSC_M>0.1":
        return (x["TV_OSC_D"]>0.1)&(x["TV_OSC_W"]>0.1)&(x["TV_OSC_M"]>0.1)
    if rule=="ST10X30_DIR==1 & RSI14<70 & close>SMA200":
        return (x["ST10X30_DIR"]==1)&(x["RSI14"]<70)&(x["close"]>x["SMA200"])
    if rule=="RSI2<5 & close>SMA200 & WPR14<-90":
        return (x["RSI2"]<5)&(x["close"]>x["SMA200"])&(x["WPR14"]<-90)
    if rule=="close<BB_LOWER20 & RSI14<35 & MACD>MACD_SIGNAL & ADX14>20":
        return (x["close"]<x["BB_LOWER20"])&(x["RSI14"]<35)&(x["MACD"]>x["MACD_SIGNAL"])&(x["ADX14"]>20)
    if rule=="BB_REENTRY_UP==1 & RSI14<50":
        return (x["BB_REENTRY_UP"]==1)&(x["RSI14"]<50)
    if rule=="SQUEEZE_RELEASE==1 & MACD_HIST>0 & close>EMA20":
        return (x["SQUEEZE_RELEASE"]==1)&(x["MACD_HIST"]>0)&(x["close"]>x["EMA20"])
    if rule=="SQUEEZE_KC_RELEASE_15==1 & MACD_HIST>0 & close>EMA20":
        return (x["SQUEEZE_KC_RELEASE_15"]==1)&(x["MACD_HIST"]>0)&(x["close"]>x["EMA20"])
    if rule=="SQUEEZE_KC_RELEASE_20==1 & TV_ALL_D>0.1":
        return (x["SQUEEZE_KC_RELEASE_20"]==1)&(x["TV_ALL_D"]>0.1)
    if rule=="BREAKOUT55==1 & TV_MA_D>0":
        return (x["BREAKOUT55"]==1)&(x["TV_MA_D"]>0)
    if rule=="BREAKOUT55==1 & ADX14>20 & TV_MA_D>0":
        return (x["BREAKOUT55"]==1)&(x["ADX14"]>20)&(x["TV_MA_D"]>0)
    if rule=="price_above_cloud & RSI14>30 & MACD>MACD_SIGNAL":
        return (x["ICHIMOKU_BULL"]==1)&(x["RSI14"]>30)&(x["MACD"]>x["MACD_SIGNAL"])
    if rule=="RSI_BULL_DIV_PROXY==1 & BULL_REVERSAL==1":
        return (x["RSI_BULL_DIV_PROXY"]==1)&(x["BULL_REVERSAL"]==1)
    if rule=="RSI_BULL_DIV_PROXY==1 & TV_OSC_D>0.1":
        return (x["RSI_BULL_DIV_PROXY"]==1)&(x["TV_OSC_D"]>0.1)
    if rule=="OBV_SLOPE20>0 & TV_ALL_D>0.1":
        return (x["OBV_SLOPE20"]>0)&(x["TV_ALL_D"]>0.1)
    if rule=="ATRP14_RANK60<0.8":
        return x["ATRP14_RANK60"]<0.8
    if rule=="DIST_MA60>-0.2 & ADX14<35":
        return (x["DIST_MA60"]>-0.2)&(x["ADX14"]<35)
    raise ValueError(rule)


def rank_feature(g: pd.DataFrame, col: str, ascending: bool=True) -> pd.Series:
    z=pd.to_numeric(g[col],errors="coerce")
    return z.rank(pct=True,method="average",ascending=ascending)


def score_rerank(g: pd.DataFrame, rule: str) -> pd.Series:
    # Parse rank terms without splitting on the '-' inside rank(-FEATURE)
    # or in subtraction expressions such as rank(A)-rank(B).
    terms=re.findall(r"([+-]?)\s*rank\(([^)]+)\)",rule)
    if not terms:
        raise ValueError(f"invalid rerank rule: {rule}")
    score=pd.Series(0.0,index=g.index)
    for outer,inside in terms:
        inside=inside.strip()
        sign=-1.0 if outer=="-" else 1.0
        if inside.startswith("-"):
            col=inside[1:].strip()
            asc=True
        else:
            col=inside
            asc=False
        score=score+sign*rank_feature(g,col,ascending=asc)
    return score


def select_month(g: pd.DataFrame, c: Candidate) -> pd.DataFrame:
    # Selection must use formation-date information only. Do not filter on
    # fwd_month because that is future information and would introduce look-ahead.
    x=g.dropna(subset=["M1_MOM20_ADJ"]).copy()
    if len(x)<20:
        return x.iloc[0:0]
    pool=x.sort_values(["M1_MOM20_ADJ","symbol"],ascending=[True,True]).head(c.pool)
    if c.kind in {"RERANK"}:
        pool=pool.copy()
        pool["_score"]=score_rerank(pool,c.rule)
        pick=pool.sort_values(["_score","symbol"],ascending=[False,True]).head(20)
        return pick
    pick=pool.head(20).copy()
    pick["gate"]=bool_gate(pick,c.rule).fillna(False)
    return pick


def evaluate(df: pd.DataFrame,c: Candidate,bps: float) -> pd.DataFrame:
    rows=[]
    prev={}
    # Evaluate only formation months for which a subsequent monthly return exists.
    # Keep all symbols in those formation months so selection itself stays causal.
    valid_months=(
        df.groupby("month_end")["fwd_month"]
          .apply(lambda s: bool(s.notna().any()))
    )
    for month,g in df[df["month_end"].map(valid_months).fillna(False)].groupby("month_end",sort=True):
        pick=select_month(g,c)
        if c.kind=="RERANK":
            entered=pick.copy()
            entered["w"]=1/20.0
            current={s:1/20.0 for s in entered["symbol"]}
            gross=float(entered["fwd_month"].mean())
        else:
            if pick.empty:
                entered=pick
                current={}
                gross=0.0
            else:
                entered=pick[pick["gate"]].copy()
                entered["w"]=1/20.0
                current={s:1/20.0 for s in entered["symbol"]}
                gross=float(np.nansum(entered["w"]*entered["fwd_month"].fillna(0.0)))
        syms=set(prev)|set(current)
        turnover=0.5*sum(abs(current.get(s,0)-prev.get(s,0)) for s in syms)
        net=gross-turnover*bps/10000.0
        rows.append({
            "month_end":month,
            "gross_return":gross,
            "turnover":turnover,
            "net_return":net,
            "active_names":len(current),
            "exposure":sum(current.values())
        })
        prev=current
    return pd.DataFrame(rows)


def period(s:pd.Series,start:str,end:str)->pd.Series:
    idx=pd.to_datetime(s.index)
    return s[(idx>=pd.Timestamp(start))&(idx<=pd.Timestamp(end))]


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--costs",default="20,40,60")
    args=ap.parse_args()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)

    df=add_forward(load_panel(args.input))
    candidates=build_candidates()
    rows=[]

    for c in candidates:
        for bps in [float(v) for v in args.costs.split(",")]:
            rr=evaluate(df,c,bps)
            ser=rr.set_index("month_end")["net_return"]
            row={"candidate":c.code,"kind":c.kind,"pool":c.pool,"rule":c.rule,"bps":bps,
                 "avg_exposure":float(rr["exposure"].mean()),
                 "avg_active_names":float(rr["active_names"].mean()),
                 "avg_turnover":float(rr["turnover"].mean())}
            for label,start,end in [
                ("FULL5Y","2021-10-31","2026-08-31"),
                ("TRAIN","2022-10-31","2023-08-31"),
                ("DEV","2023-09-30","2024-08-31"),
                ("OOS","2024-09-30","2025-08-31"),
                ("HOLDOUT","2025-09-30","2026-08-31")
            ]:
                row.update({f"{label}_{k}":v for k,v in perf(period(ser,start,end).to_numpy()).items()})
            rows.append(row)
            if bps==float(args.costs.split(",")[0]):
                rr.assign(candidate=c.code).to_csv(out/f"timeseries_{c.code}.csv",index=False)

    result=pd.DataFrame(rows)
    result.to_csv(out/"candidate_results.csv",index=False)

    ref=float(args.costs.split(",")[0]); stress=float(args.costs.split(",")[-1])
    a=result[result.bps==ref].set_index("candidate")
    b=result[result.bps==stress].set_index("candidate")
    nt=a["TRAIN_months"].replace(0,np.nan); nd=a["DEV_months"].replace(0,np.nan)
    ranking=pd.DataFrame(index=a.index)
    ranking["train_dev_geo"]=np.expm1(
        (nt*np.log1p(a["TRAIN_geo_monthly"].clip(lower=-0.999999))+
         nd*np.log1p(a["DEV_geo_monthly"].clip(lower=-0.999999)))/(nt+nd)
    )
    ranking["stress_train_dev_geo"]=np.expm1(
        (nt*np.log1p(b["TRAIN_geo_monthly"].clip(lower=-0.999999))+
         nd*np.log1p(b["DEV_geo_monthly"].clip(lower=-0.999999)))/(nt+nd)
    )
    ranking["min_geo"]=ranking[["train_dev_geo","stress_train_dev_geo"]].min(axis=1)
    ranking["dev_dd"]=pd.to_numeric(a["DEV_max_drawdown_pct"],errors="coerce")
    ranking["robust_score"]=ranking["min_geo"]-0.25*ranking["dev_dd"].abs()
    ranking["candidate"]=ranking.index
    ranking=ranking.sort_values(["robust_score","train_dev_geo"],ascending=[False,False])
    ranking.to_csv(out/"robust_ranking.csv")

    baseline_audit={"available":False}
    locked_path=Path("research-results/luna-m1-benchmark-locked-20260920.csv")
    if locked_path.exists():
        locked=pd.read_csv(locked_path,parse_dates=["month_end"]).set_index("month_end")
        local=(evaluate(df,next(c for c in candidates if c.code=="BASELINE"),ref)
               .set_index("month_end")["net_return"].rename("local"))
        common=locked.join(local,how="inner")
        if not common.empty:
            diff=common["local"]-common["net_return"]
            baseline_audit={
                "available":True,
                "common_months":int(len(common)),
                "max_abs_diff":float(diff.abs().max()),
                "mean_abs_diff":float(diff.abs().mean()),
                "within_1bp":bool((diff.abs()<=0.0001).all())
            }

    summary={
        "status":"COMPLETED",
        "engine":"luna-tradingview-strategy-tournament-v1",
        "panel_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count":len(candidates),
        "gate_candidates":sum(c.kind!="RERANK" for c in candidates),
        "rerank_candidates":sum(c.kind=="RERANK" for c in candidates),
        "selection_rule":"M1 bottom-K by completed calendar-month adjusted-close return at month-end for gate candidates; pool-50/100 second-stage rerank for evolution candidates.",
        "train_dev_only_selection":True,
        "frozen_periods":["OOS","HOLDOUT"],
        "locked_m1_baseline_audit":baseline_audit,
        "costs_bps":[float(v) for v in args.costs.split(",")],
        "promotion_rule":"Candidate must beat locked M1 on both frozen OOS and HOLDOUT and remain positive at 20/40/60 bps; then replicate on fresh seeds/periods."
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")
    (out/"candidate_catalog.json").write_text(json.dumps([c.__dict__ for c in candidates],indent=2),encoding="utf-8")


if __name__=="__main__":
    main()
