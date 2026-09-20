#!/usr/bin/env python3
"""M1 research v2: theory-driven short-term reversal enhancement.

This is not a blind formula search. It starts from the existing M1 idea:
buy recent losers at monthly rebalance, then tests a small, theory-derived
family of enhancements supported by the reversal/liquidity literature:
- signal magnitude from recent 20/21-trading-day reversal
- liquidity/turnover conditioning
- 52-week-high distance conditioning
- high-volatility conditioning
- medium-horizon trend safety filter
- liquidity floor to avoid untradeable tails
- optional market-stress exposure overlay

All feature ranks are cross-sectional at the decision month. Forward returns
are only calculated when the next calendar month exists. Candidate selection
uses TRAIN+DEV only; OOS and HOLDOUT are frozen tests. Costs are stressed at
multiple bps levels. No randomized formula generation is used.
"""

from __future__ import annotations

import argparse, hashlib, json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

FEATURES = [
    "MOM_20","MOM_40","MOM_60","VOL_20","MAXDD_60",
    "DIST_HIGH_252","AMOUNT","ILLIQ_20",
]

@dataclass(frozen=True)
class Candidate:
    name: str
    mom_w: float
    lq_w: float
    vol_w: float
    trend_floor: float
    liq_floor: float
    lq_style: str = "SAFE"
    k: int = 20
    stress_on: float = 0.75
    stress_off: float = 1.50
    stress_exp_mid: float = 0.75
    stress_exp_high: float = 0.50
    regime_overlay: bool = False

    def id(self) -> str:
        return self.name

def geo(x: Iterable[float]) -> float:
    a = pd.Series(list(x), dtype=float).dropna()
    if len(a) == 0 or (a <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(a).mean()))

def perf(x: pd.Series) -> dict:
    a = pd.to_numeric(x, errors="coerce").dropna().astype(float)
    if a.empty:
        return {
            "months":0,"geo_monthly":-1.0,"cumulative":-1.0,
            "positive_month_pct":0.0,"worst_month":None,"best_month":None,
            "max_drawdown_pct":None,"cagr":-1.0,
        }
    eq = (1.0 + a).cumprod()
    peak = eq.cummax()
    dd = eq / peak - 1.0
    g = geo(a)
    return {
        "months": int(len(a)),
        "geo_monthly": g,
        "cumulative": float(eq.iloc[-1] - 1.0),
        "positive_month_pct": float((a > 0).mean()),
        "worst_month": float(a.min()),
        "best_month": float(a.max()),
        "max_drawdown_pct": float(dd.min()),
        "cagr": float((1.0 + g) ** 12 - 1.0),
    }

def period_mask(idx: pd.Index, start: str, end: str) -> pd.Series:
    s = pd.Series(pd.to_datetime(idx), index=idx)
    return (s >= pd.Timestamp(start)) & (s <= pd.Timestamp(end))

def month_end_label(ts: pd.Timestamp) -> str:
    return ts.to_period("M").to_timestamp("M").strftime("%Y-%m-%d")

def make_candidates() -> list[Candidate]:
    out: list[Candidate] = []
    idx = 0
    for mw in (0.60, 0.75, 0.90):
        for lqw in (0.00, 0.10, 0.20):
            for vw in (0.00, 0.10):
                for trend_floor in (0.00, 0.20):
                    for liq_floor in (0.00, 0.20):
                    for lq_style in ("SAFE", "CONTRARIAN"):
                        # Positive weights are normalized; lq uses lower turnover and
                        # lower price-to-52-week-high distance as positive signals.
                        total = mw + lqw + vw
                        if total <= 0:
                            continue
                        idx += 1
                        name = (
                            f"B{idx:03d}_MW{mw:.2f}_LQ{lqw:.2f}_VW{vw:.2f}"
                            f"_TF{trend_floor:.2f}_LF{liq_floor:.2f}_{lq_style}"
                        )
                        out.append(Candidate(
                            name=name,mom_w=mw/total,lq_w=lqw/total,vol_w=vw/total,
                            trend_floor=trend_floor,liq_floor=liq_floor,lq_style=lq_style
                        ))
    return out

def load_monthly(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    need = {"date","symbol","adj_close",*FEATURES}
    missing = sorted(need - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")
    df["date"] = pd.to_datetime(df["date"])
    df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    for c in ["adj_close",*FEATURES]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["month"] = df["date"].dt.to_period("M").dt.to_timestamp("M")
    # Use only each symbol's last observed day per month.
    m = (
        df.sort_values(["symbol","date"])
          .groupby(["symbol","month"], as_index=False)
          .tail(1)
          .sort_values(["month","symbol"])
          .reset_index(drop=True)
    )
    m["_next_month"] = m.groupby("symbol")["month"].shift(-1)
    m["_next_price"] = m.groupby("symbol")["adj_close"].shift(-1)
    expected = m["month"] + pd.offsets.MonthEnd(1)
    m["fwd1"] = np.where(
        m["_next_month"].eq(expected),
        m["_next_price"] / m["adj_close"] - 1.0,
        np.nan,
    )
    return m.drop(columns=["_next_month","_next_price"])

def add_cross_sectional_ranks(m: pd.DataFrame) -> pd.DataFrame:
    for c in FEATURES:
        m[f"R_{c}"] = m.groupby("month")[c].rank(pct=True, method="average")
    # Signal convention: higher score is more desirable for the reversal candidate.
    m["S_REV"] = 1.0 - m["R_MOM_20"]
    m["S_LQ"] = (1.0 - m["R_VOL_20"] * 0.0)  # placeholder for explicit weighted blend
    m["S_LOW_TURNOVER"] = 1.0 - m["R_ILLIQ_20"]  # lower |return|/amount proxy
    m["S_LOW_PTH"] = 1.0 + m["R_DIST_HIGH_252"]  # lower distance is more negative; invert below
    m["S_LOW_PTH"] = 1.0 - m["R_DIST_HIGH_252"]
    m["S_HIGH_VOL"] = m["R_VOL_20"]
    m["S_MED_TREND"] = m["R_MOM_60"]
    m["S_LIQ"] = m["R_AMOUNT"]
    return m

def build_regime(monthly: pd.DataFrame) -> pd.DataFrame:
    g = monthly.groupby("month").agg(
        breadth=("MOM_20", lambda s: float((s > 0).mean())),
        median_vol=("VOL_20","median"),
        median_abs_ret=("MOM_20", lambda s: float(pd.Series(s).abs().median())),
    ).sort_index()
    for c in ["breadth","median_vol","median_abs_ret"]:
        mu = g[c].shift(1).rolling(12, min_periods=12).mean()
        sd = g[c].shift(1).rolling(12, min_periods=12).std()
        g[f"z_{c}"] = (g[c] - mu) / sd.replace(0,np.nan)
    # Stress = weak breadth + high volatility. All conditioning is lagged by one month.
    g["stress"] = 0.5 * (-g["z_breadth"]) + 0.5 * g["z_median_vol"]
    return g.reset_index()[["month","stress","breadth","median_vol","median_abs_ret"]]

def score_candidates(m: pd.DataFrame, candidates: list[Candidate]) -> dict[str,pd.DataFrame]:
    results = {}
    ranks = [c for c in m.columns if c.startswith("R_")]
    for c in candidates:
        x = m[["month","symbol","fwd1",*ranks]].copy()
        # Safe liquidity/trend filters, evaluated cross-sectionally at decision month.
        if c.trend_floor > 0:
            x = x[x.groupby("month")["R_MOM_60"].transform("rank", pct=True) >= c.trend_floor]
        if c.liq_floor > 0:
            x = x[x.groupby("month")["R_AMOUNT"].transform("rank", pct=True) >= c.liq_floor]
        if c.lq_style == "SAFE":
            lq_signal = 0.50 * (1.0 - x["R_ILLIQ_20"]) + 0.50 * x["R_AMOUNT"]
        else:
            # Literature-inspired contrarian variant: emphasize illiquidity and
            # distance below the 52-week high. Liquidity-floor candidates still
            # cap the most untradeable tail.
            lq_signal = 0.50 * x["R_ILLIQ_20"] + 0.50 * (1.0 - x["R_DIST_HIGH_252"])
        x["score"] = (
            c.mom_w * (1.0 - x["R_MOM_20"])
            + c.lq_w * lq_signal
            + c.vol_w * x["R_VOL_20"]
        )
        x = x.dropna(subset=["score","fwd1"])
        x = x.sort_values(["month","score","symbol"], ascending=[True,False,True])
        top = x.groupby("month", sort=True).head(c.k)
        gross = top.groupby("month")["fwd1"].mean()
        turnover = []
        prev: set[str] = set()
        for month, part in top.groupby("month", sort=True):
            cur = set(part["symbol"])
            t = 1.0 if not prev else 1.0 - len(cur & prev) / float(c.k)
            turnover.append((month,t))
            prev = cur
        turn = pd.Series(dict(turnover), dtype=float)
        out = pd.DataFrame({"gross":gross, "turnover":turn}).sort_index()
        results[c.name] = out
    return results

def apply_regime(base: pd.DataFrame, regime: pd.DataFrame, c: Candidate) -> pd.Series:
    x = base.join(regime.set_index("month")["stress"], how="left")
    r = x["gross"].copy()
    if not c.regime_overlay:
        return r
    exposure = np.where(
        x["stress"].isna(), 1.0,
        np.where(x["stress"] >= c.stress_off, c.stress_exp_high,
                 np.where(x["stress"] >= c.stress_on, c.stress_exp_mid, 1.0)),
    )
    # When exposure is reduced, the balance stays in cash.
    return r * exposure

def cost_net(gross: pd.Series, turnover: pd.Series, bps: float, exposure: pd.Series | None = None) -> pd.Series:
    if exposure is None:
        exposure = pd.Series(1.0,index=gross.index)
    exposure = exposure.astype(float)
    prev = exposure.shift(1).fillna(1.0)
    exposure_turnover = (exposure - prev).abs()
    total_turnover = turnover * exposure + exposure_turnover
    return gross * exposure - total_turnover * (bps / 10000.0)

def evaluate_periods(net: pd.Series) -> dict:
    ans = {}
    for label,start,end in [
        ("TRAIN","2021-01-01","2023-12-31"),
        ("DEV","2024-01-01","2024-12-31"),
        ("OOS","2025-01-01","2025-12-31"),
        ("HOLDOUT","2026-01-01","2026-12-31"),
    ]:
        s = net.loc[period_mask(net.index,start,end)]
        mm = perf(s)
        for k,v in mm.items():
            ans[f"{label}_{k}"] = v
    return ans

def block_bootstrap(a: pd.Series, block: int = 3, n: int = 2000, seed: int = 20260920) -> dict:
    x = a.dropna().to_numpy(dtype=float)
    if len(x) < block*3:
        return {"n":int(len(x)),"p05":None,"p50":None,"p95":None}
    rng = np.random.default_rng(seed)
    vals = []
    starts = np.arange(0, len(x)-block+1)
    for _ in range(n):
        sample = []
        while len(sample) < len(x):
            s = int(rng.choice(starts))
            sample.extend(x[s:s+block].tolist())
        sample = np.asarray(sample[:len(x)])
        vals.append(geo(sample))
    q = np.quantile(vals,[0.05,0.50,0.95])
    return {"n":int(len(x)),"p05":float(q[0]),"p50":float(q[1]),"p95":float(q[2])}

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--costs",default="20,40,60")
    ap.add_argument("--top-dev",type=int,default=12)
    args = ap.parse_args()

    out = Path(args.output); out.mkdir(parents=True,exist_ok=True)
    m = add_cross_sectional_ranks(load_monthly(args.input))
    regime = build_regime(m)
    candidates = make_candidates()
    base_map = score_candidates(m,candidates)

    rows=[]
    for c in candidates:
        base=base_map[c.name]
        for bps in [float(z) for z in args.costs.split(",")]:
            exposure = None
            gross = base["gross"]
            if not c.regime_overlay:
                exposure = pd.Series(1.0,index=gross.index)
            net = cost_net(gross,base["turnover"],bps,exposure)
            row = {"candidate":c.name,"bps":bps,"regime_overlay":c.regime_overlay,**evaluate_periods(net)}
            rows.append(row)

    all_df = pd.DataFrame(rows)
    ref_bps=float(args.costs.split(",")[0])
    stress_bps=float(args.costs.split(",")[-1])
    wide=all_df[["candidate","bps","DEV_geo_monthly","DEV_positive_month_pct","DEV_max_drawdown_pct"]].copy()
    piv=wide.pivot_table(index="candidate",columns="bps",values="DEV_geo_monthly",aggfunc="first")
    posp=wide.pivot_table(index="candidate",columns="bps",values="DEV_positive_month_pct",aggfunc="first")
    dd=wide[wide["bps"]==ref_bps].set_index("candidate")["DEV_max_drawdown_pct"]
    robust=pd.DataFrame(index=piv.index)
    robust["dev_geo_ref"]=piv.get(ref_bps,np.nan)
    robust["dev_geo_stress"]=piv.get(stress_bps,np.nan)
    robust["dev_geo_worst"]=robust[["dev_geo_ref","dev_geo_stress"]].min(axis=1)
    robust["dev_pos_ref"]=posp.get(ref_bps,np.nan)
    robust["dev_pos_stress"]=posp.get(stress_bps,np.nan)
    robust["dev_dd_ref"]=dd
    robust["robust_score"]=robust["dev_geo_worst"] - 0.25*robust["dev_dd_ref"].abs()
    robust["candidate"]=robust.index
    dev=robust.sort_values(["robust_score","dev_pos_ref","dev_pos_stress"],ascending=[False,False,False])
    shortlist=dev.head(args.top_dev)
    # Regime overlays are evaluated only after the base family has been frozen by DEV.
    overlay_specs=[]
    for r in shortlist.itertuples(index=False):
        base_c = next(c for c in candidates if c.name == r.candidate)
        for on,off,mid,high in [
            (0.75,1.50,0.75,0.50),
            (1.00,1.75,0.75,0.50),
            (0.50,1.25,0.85,0.60),
        ]:
            c=Candidate(**{**asdict(base_c),"name":base_c.name+f"_REG_{on}_{off}_{mid}_{high}",
                           "regime_overlay":True,"stress_on":on,"stress_off":off,
                           "stress_exp_mid":mid,"stress_exp_high":high})
            overlay_specs.append(c)
    overlay_map=score_candidates(m,overlay_specs)
    overlay_rows=[]
    for c in overlay_specs:
        base=overlay_map[c.name]
        rj=base.join(regime.set_index("month")["stress"],how="left")
        exposure=pd.Series(
            np.where(rj["stress"].isna(),1.0,
                     np.where(rj["stress"]>=c.stress_off,c.stress_exp_high,
                              np.where(rj["stress"]>=c.stress_on,c.stress_exp_mid,1.0))),
            index=rj.index)
        for bps in [float(z) for z in args.costs.split(",")]:
            net=cost_net(rj["gross"],rj["turnover"],bps,exposure)
            overlay_rows.append({"candidate":c.name,"bps":bps,**evaluate_periods(net),
                                 "stress_on":c.stress_on,"stress_off":c.stress_off,
                                 "mid_exposure":c.stress_exp_mid,"high_exposure":c.stress_exp_high,
                                 "bootstrap_oos":block_bootstrap(net.loc[period_mask(net.index,"2025-01-01","2025-12-31")])})
    overlay_df=pd.DataFrame(overlay_rows)

    # Select only from DEV at the reference 20 bps. OOS/HOLDOUT are descriptive.
    best_base_meta=dev.iloc[0].to_dict()
    best_base_row=all_df[(all_df.bps==ref_bps)&(all_df.candidate==best_base_meta["candidate"])].iloc[0].to_dict()
    best_base={**best_base_row,"robust_score":float(best_base_meta["robust_score"]),
               "dev_geo_worst_cost":float(best_base_meta["dev_geo_worst"]) }
    if not overlay_df.empty:
        owide=overlay_df[["candidate","bps","DEV_geo_monthly","DEV_positive_month_pct","DEV_max_drawdown_pct"]]
        opiv=owide.pivot_table(index="candidate",columns="bps",values="DEV_geo_monthly",aggfunc="first")
        opos=owide.pivot_table(index="candidate",columns="bps",values="DEV_positive_month_pct",aggfunc="first")
        odd=owide[owide["bps"]==ref_bps].set_index("candidate")["DEV_max_drawdown_pct"]
        ometa=pd.DataFrame(index=opiv.index)
        ometa["ref"]=opiv.get(ref_bps,np.nan)
        ometa["stress"]=opiv.get(stress_bps,np.nan)
        ometa["worst"]=ometa[["ref","stress"]].min(axis=1)
        ometa["pos_ref"]=opos.get(ref_bps,np.nan)
        ometa["pos_stress"]=opos.get(stress_bps,np.nan)
        ometa["dd"]=odd
        ometa["score"]=ometa["worst"]-0.25*ometa["dd"].abs()
        ometa["candidate"]=ometa.index
        ob=ometa.sort_values(["score","pos_ref","pos_stress"],ascending=[False,False,False]).iloc[0]
        best_overlay=overlay_df[(overlay_df.bps==ref_bps)&(overlay_df.candidate==ob["candidate"])].iloc[0].to_dict()
        best_overlay["robust_score"]=float(ob["score"])
        best_overlay["dev_geo_worst_cost"]=float(ob["worst"])
    else:
        best_overlay={}

    summary={
        "status":"COMPLETED",
        "engine":"luna-m1-research-v2",
        "dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count":len(candidates),
        "overlay_count":len(overlay_specs),
        "reference_cost_bps":float(args.costs.split(",")[0]),
        "cost_stress_bps":[float(z) for z in args.costs.split(",")],
        "selection_rule":"base candidate and regime overlay are selected using DEV only; robust score uses DEV at reference and stress costs plus drawdown; OOS and HOLDOUT are frozen evaluations",
        "theory_basis":[
            "short-term reversal",
            "liquidity-provision conditioning",
            "52-week-high conditioning",
            "volatility conditioning",
            "medium-horizon trend safety filter",
            "liquidity floor",
            "market-stress exposure control",
        ],
        "best_base_dev":best_base,
        "best_overlay_dev":best_overlay,
        "best_base_oos_holdout":all_df[(all_df.bps==float(args.costs.split(",")[0]))&(all_df.candidate==best_base.get("candidate"))].to_dict("records"),
        "best_overlay_oos_holdout":overlay_df[(overlay_df.bps==float(args.costs.split(",")[0]))&(overlay_df.candidate==best_overlay.get("candidate"))].to_dict("records"),
        "m1_core_reference":"M1 = bottom 20 by MOM_20 (1-month short-term reversal), monthly rebalance, equal weight",
        "hurdle_monthly":0.07,
        "hurdle_test":"A candidate is not promoted merely for clearing 7% in DEV; OOS and blind HOLDOUT must also be inspected.",
        "bootstrap":"3-month block bootstrap on OOS monthly returns for shortlisted regime overlays",
    }
    (out/"candidate_results.csv").write_text(all_df.to_csv(index=False),encoding="utf-8")
    (out/"overlay_results.csv").write_text(overlay_df.to_csv(index=False),encoding="utf-8")
    (out/"regime_series.csv").write_text(regime.to_csv(index=False),encoding="utf-8")
    (out/"candidate_catalog.json").write_text(json.dumps([asdict(c) for c in candidates],indent=2,default=str),encoding="utf-8")
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__ == "__main__":
    main()
