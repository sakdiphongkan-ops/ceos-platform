#!/usr/bin/env python3
"""LUNA Adaptive Tournament v2.

Generates 1,000 deterministic multi-factor rank formulas, evaluates each
monthly with strict forward returns, and adaptively selects from prior 24
months only. M1 REV K20 is included as a locked benchmark candidate.
No future return is used in selecting month t.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import os
import numpy as np
import pandas as pd
from apply_pit_universe import filter_dataframe_by_date
from luna_feasibility import cost_stress, summarize
from pit_financials import PointInTimeFinancials, add_common_financial_factors

BASE_FACTORS=["mom1","mom3","mom6","mom12","high52_ratio","vol20","maxdd60","avg_amount20"]
FINANCIAL_FACTORS=["profit_margin","roe","asset_turnover","cash_conversion"]

def geo(x):
    x=np.asarray(x,dtype=float)
    x=x[np.isfinite(x)]
    if len(x)==0 or np.any(x<=-1): return -1.0
    return float(np.exp(np.log1p(x).mean())-1)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True); ap.add_argument("--output",required=True)
    ap.add_argument("--lookback-months",type=int,default=24)
    ap.add_argument("--min-history-months",type=int,default=12)
    ap.add_argument("--cost-bps",type=float,default=20)
    ap.add_argument("--membership",default=os.getenv("LUNA_PIT_UNIVERSE_MEMBERSHIP"))
    ap.add_argument("--formula-count",type=int,default=1000)
    ap.add_argument("--k",type=int,default=20)
    ap.add_argument("--seed",type=int,default=20260920)
    ap.add_argument("--financial-statements",default=os.getenv("LUNA_PIT_FINANCIAL_STATEMENTS"))
    ap.add_argument("--trading-calendar",default=os.getenv("LUNA_TRADING_CALENDAR"))
    ap.add_argument("--pit-availability-rule",choices=["next_trading_day","source_available_at"],default=os.getenv("LUNA_PIT_AVAILABILITY_RULE","next_trading_day"))
    ap.add_argument("--max-financial-age-days",type=int,default=int(os.getenv("LUNA_MAX_FINANCIAL_AGE_DAYS","180")))
    ap.add_argument("--enable-pit-fundamentals",action="store_true",default=str(os.getenv("LUNA_ENABLE_PIT_FUNDAMENTALS","false")).lower()=="true")
    args=ap.parse_args()
    pit_financials_enabled=bool(args.enable_pit_fundamentals or args.financial_statements)
    factor_columns=list(BASE_FACTORS)
    pit_financial_factor_coverage={}
    pit_financial_revision_count=0
    pit_financial_sha256=None
    pit_calendar_sha256=None
    pit_available_at_rule=None
    pit_validation_error=None
    if not args.membership:
        raise SystemExit("PIT_UNIVERSE_MEMBERSHIP_REQUIRED")
    out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    df=pd.read_csv(args.input)
    if "snapshot_date" not in df.columns:
        raise SystemExit("PIT_SNAPSHOT_DATE_REQUIRED")
    df["snapshot_date"]=pd.to_datetime(df["snapshot_date"])
    df["month_end"]=pd.to_datetime(df["month_end"])
    df, pit_excluded_rows, pit_active_symbols = filter_dataframe_by_date(
        df, args.membership, "snapshot_date"
    )

    if pit_financials_enabled:
        if not args.financial_statements:
            raise SystemExit("PIT_FINANCIAL_STATEMENTS_REQUIRED")
        statement_path=Path(args.financial_statements)
        if not statement_path.exists():
            raise SystemExit(f"PIT_FINANCIAL_STATEMENTS_NOT_FOUND: {statement_path}")
        pit_engine=PointInTimeFinancials()
        statements=pit_engine.load(statement_path)
        pit_financial_sha256=hashlib.sha256(statement_path.read_bytes()).hexdigest()

        if args.pit_availability_rule == "next_trading_day":
            if not args.trading_calendar:
                raise SystemExit("PIT_TRADING_CALENDAR_REQUIRED")
            calendar_path=Path(args.trading_calendar)
            if not calendar_path.exists():
                raise SystemExit(f"PIT_TRADING_CALENDAR_NOT_FOUND: {calendar_path}")
            calendar_raw=pd.read_csv(calendar_path)
            calendar_col=next((c for c in ("date","trading_date","datetime") if c in calendar_raw.columns),None)
            if calendar_col is None:
                raise SystemExit("PIT_TRADING_CALENDAR_DATE_COLUMN_REQUIRED")
            calendar=calendar_raw[calendar_col]
            statements=pit_engine.assign_available_at(statements,calendar)
            pit_calendar_sha256=hashlib.sha256(calendar_path.read_bytes()).hexdigest()
        elif "available_at" not in statements.columns:
            raise SystemExit("PIT_SOURCE_AVAILABLE_AT_REQUIRED")

        pit_available_at_rule=args.pit_availability_rule
        statements=pit_engine.detect_revisions(statements)
        pit_financial_revision_count=int(statements["is_restated"].sum())

        obs=df[["snapshot_date","symbol"]].rename(columns={"snapshot_date":"date","symbol":"ticker"})
        attached=pit_engine.merge_prices(statements,obs)
        attached=add_common_financial_factors(attached)
        attached["financial_age_days"]=(attached["date"]-attached["available_at"]).dt.days
        attached["fundamental_eligible"]=attached["financial_age_days"].between(0,args.max_financial_age_days)
        for f in FINANCIAL_FACTORS:
            if f in attached.columns:
                attached.loc[~attached["fundamental_eligible"],f]=np.nan

        pit_validation=attached[["ticker","date","available_at"]].copy()
        try:
            from pit_financials import validate_pit
            validate_pit(pit_validation,args.max_financial_age_days)
        except Exception as exc:
            pit_validation_error=str(exc)

        available_financial=[f for f in FINANCIAL_FACTORS if f in attached.columns]
        if not available_financial:
            raise SystemExit("NO_PIT_FINANCIAL_FACTORS_AVAILABLE")
        attached=attached[["date","ticker","available_at","financial_age_days","fundamental_eligible",*available_financial]].drop_duplicates(["date","ticker"])
        df=df.merge(attached,left_on=["snapshot_date","symbol"],right_on=["date","ticker"],how="left",validate="many_to_one")
        df.drop(columns=["date","ticker"],inplace=True)
        for f in available_financial:
            df[f]=pd.to_numeric(df[f],errors="coerce")
        factor_columns.extend(available_financial)
        pit_financial_factor_coverage={f:float(df[f].notna().mean()) for f in available_financial}

    req={"symbol","month_end","adj_close",*factor_columns}
    miss=sorted(req-set(df.columns))
    if miss: raise SystemExit(f"missing columns: {miss}")
    df["month_end"]=pd.to_datetime(df.month_end).dt.to_period("M").dt.to_timestamp("M")
    df=df.sort_values(["month_end","symbol"]).drop_duplicates(["month_end","symbol"])
    df["adj_close"]=pd.to_numeric(df.adj_close,errors="coerce")
    for f in factor_columns: df[f]=pd.to_numeric(df[f],errors="coerce")
    factor_coverage={f:float(df[f].notna().mean()) for f in factor_columns}
    active_factors=[f for f in factor_columns if factor_coverage[f] >= 0.20]
    excluded_factors=[f for f in factor_columns if f not in active_factors]
    if "mom1" not in active_factors or len(active_factors) < 2:
        raise SystemExit(f"insufficient usable factors: {factor_coverage}")
    # Strict calendar-contiguous forward return: a missing month is NOT a 1M return.
    df["_next_month"]=df.groupby("symbol").month_end.shift(-1)
    df["_next_adj_close"]=df.groupby("symbol").adj_close.shift(-1)
    expected=df.month_end+pd.offsets.MonthEnd(1)
    df["fwd1"]=np.where(
        df["_next_month"].eq(expected),
        df["_next_adj_close"]/df.adj_close-1,
        np.nan,
    )
    df.drop(columns=["_next_month","_next_adj_close"],inplace=True)
    for f in factor_columns: df[f]=pd.to_numeric(df[f],errors="coerce")
    factor_coverage={f:float(df[f].notna().mean()) for f in factor_columns}
    active_factors=[f for f in factor_columns if factor_coverage[f] >= 0.80]
    if len(active_factors) < 3:
        raise SystemExit(f"Need at least 3 factors with >=80% coverage; coverage={factor_coverage}")
    months=sorted(df.month_end.dropna().unique())
    # Cross-sectional ranks: sparse factor values stay NaN and only prevent
    # scores for formulas that actually use the missing factor.
    R=np.stack([
        df.groupby("month_end")[f].rank(pct=True,method="average").to_numpy()
        for f in active_factors
    ],axis=1)
    factor_pos={f:i for i,f in enumerate(active_factors)}
    valid=np.isfinite(df.fwd1.to_numpy())
    df=df.loc[valid].reset_index(drop=True); R=R[valid]; y=df.fwd1.to_numpy()
    months=sorted(df.month_end.unique())
    month_idx={m:i for i,m in enumerate(months)}
    # Deterministic 1,000 formulas: 1 benchmark + 999 seeded rank blends.
    rng=np.random.default_rng(args.seed)
    formulas=[{"id":"M1_REV_K20_ALIAS","terms":[("mom1",-1.0)]}]
    for i in range(1,args.formula_count):
        n=int(rng.integers(2,min(5,len(active_factors)+1)))
        inds=rng.choice(len(active_factors),size=n,replace=False)
        raw=rng.uniform(0.25,1.0,size=n)
        signs=rng.choice([-1.0,1.0],size=n)
        w=(raw*signs); w=w/np.sum(np.abs(w))
        formulas.append({"id":f"F{i:04d}","terms":[(active_factors[j],float(wi)) for j,wi in zip(inds,w)]})
    (out/"formula_catalog.json").write_text(json.dumps(formulas,indent=2),encoding="utf-8")
    # Candidate returns: each formula uses equal-weight top-K and a turnover-aware cost.
    candidates={}
    month_arrays={m:np.where(df.month_end.to_numpy()==m)[0] for m in months}
    for formula in formulas:
        ret=[]; prev=set()
        weights=np.zeros(len(active_factors))
        for f,w in formula["terms"]: weights[factor_pos[f]]=w
        for m in months:
            ix=month_arrays[m]
            score=R[ix]@weights
            finite=np.isfinite(score)
            order=ix[finite][np.argsort(-score[finite],kind="mergesort")]
            chosen=order[:args.k]
            if len(chosen)==0: continue
            gross=float(np.nanmean(y[chosen]))
            cur=set(df.symbol.iloc[chosen])
            overlap=len(cur&prev)
            turnover=1.0 if not prev else 1.0-overlap/args.k
            cost=turnover*args.cost_bps/10000
            ret.append((m,gross-turnover*args.cost_bps/10000,gross,turnover,cost))
            prev=cur
        candidates[formula["id"]]=pd.DataFrame(ret,columns=["month_end","net_return","gross_return","turnover","cost"]).set_index("month_end")
    rows=[]
    # Strict walk-forward selection. For each t, rank candidates by only t-24...t-1.
    for j,m in enumerate(months):
        prior=months[max(0,j-args.lookback_months):j]
        if len(prior)<args.min_history_months: continue
        eligible=[]
        for fid,fr in candidates.items():
            h=fr.reindex(prior).net_return.dropna()
            if len(h)<args.min_history_months: continue
            eligible.append((geo(h),float((h>0).mean()),fid))
        if not eligible: continue
        eligible.sort(key=lambda z:(-z[0],-z[1],z[2]))
        sgeo,spos,fid=eligible[0]
        rr=candidates[fid].loc[m]
        rows.append({
            "month_end":m,"history_start":prior[0],"history_end":prior[-1],
            "formula_id":fid,"selected_geo":sgeo,"selected_positive":spos,
            "gross_return":rr.gross_return,"turnover":rr.turnover,
            "transaction_cost":rr.cost,"realized_return":rr.net_return
        })
    ledger=pd.DataFrame(rows)
    ledger.to_csv(out/"tournament_selection_ledger.csv",index=False)
    r=ledger.realized_return.dropna() if not ledger.empty else pd.Series(dtype=float)

    def perf_stats(x):
        x=pd.Series(x,dtype=float).dropna()
        if len(x)==0:
            return {"geometric_monthly_return":-1.0,"cumulative_return":-1.0,
                    "positive_month_pct":0.0,"min_monthly_return":None,
                    "max_monthly_return":None,"max_drawdown_pct":None,
                    "max_drawdown_baht":None,"peak_baht":None,"trough_baht":None}
        eq=30000.0*np.cumprod(1+x.to_numpy())
        peak=np.maximum.accumulate(eq)
        dd=eq/peak-1.0
        k=int(np.argmin(dd))
        return {
            "geometric_monthly_return":geo(x),
            "cumulative_return":float(eq[-1]/30000.0-1),
            "positive_month_pct":float((x>0).mean()),
            "min_monthly_return":float(x.min()),
            "max_monthly_return":float(x.max()),
            "max_drawdown_pct":float(dd.min()),
            "max_drawdown_baht":float((eq-peak).min()),
            "peak_baht":float(peak[k]),
            "trough_baht":float(eq[k])
        }

    benchmark_stats=perf_stats(candidates["M1_REV_K20_ALIAS"].net_return)
    adaptive_stats=perf_stats(r)

    summary={
      "status":"COMPLETED","engine":"luna-adaptive-tournament-v2",
      "pit_membership":args.membership,
      "pit_excluded_rows":int(pit_excluded_rows),
      "pit_active_symbols":int(pit_active_symbols),
      "dataset_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
      "formula_count":len(formulas),"months_traded":len(r),
      "factor_coverage":factor_coverage,"active_factors":active_factors,
      "pit_financials_enabled":pit_financials_enabled,
      "pit_financial_statements_sha256":pit_financial_sha256,
      "pit_financial_revision_count":pit_financial_revision_count,
      "pit_financial_factor_coverage":pit_financial_factor_coverage,
      "pit_available_at_rule":pit_available_at_rule,
      "pit_trading_calendar_sha256":pit_calendar_sha256,
      "pit_max_financial_age_days":args.max_financial_age_days,
      "pit_validation_error":pit_validation_error,
      "excluded_sparse_factors":[f for f in factor_columns if f not in active_factors],
      "geometric_monthly_return":adaptive_stats["geometric_monthly_return"],
      "cumulative_return":adaptive_stats["cumulative_return"],
      "positive_month_pct":adaptive_stats["positive_month_pct"],
      "months_ge_7pct":int((r>=.07).sum()) if len(r) else 0,
      "min_monthly_return":adaptive_stats["min_monthly_return"],
      "max_monthly_return":adaptive_stats["max_monthly_return"],
      "max_drawdown_pct":adaptive_stats["max_drawdown_pct"],
      "max_drawdown_baht":adaptive_stats["max_drawdown_baht"],
      "peak_baht":adaptive_stats["peak_baht"],
      "trough_baht":adaptive_stats["trough_baht"],
      "benchmark_m1_alias":benchmark_stats,
      "average_turnover":float(ledger.turnover.mean()) if len(ledger) else 0,
      "total_transaction_cost":float(ledger.transaction_cost.sum()) if len(ledger) else 0,
      "lookback_months":args.lookback_months,"min_history_months":args.min_history_months,
      "cost_bps_per_one_way_turnover":args.cost_bps,
      "benchmark_included":"M1_REV_K20_ALIAS",
      "data_contiguity_guard":"forward return is used only when the next observation is exactly the next calendar month",
      "benchmark_warning":"M1_REV_K20_ALIAS is a factor-table proxy and is NOT the exact production M1 benchmark; use research-results/luna-m1-benchmark-locked-20260920.csv for Apple-to-Apple comparisons",
      "initial_capital_baht":30000,
      "leakage_guard":"month t selection uses only strictly prior months; t return is never in selection history"
    }
    feasibility = summarize(
        r,
        initial_capital=30000.0,
        target=0.07,
        nw_lag=3,
    )
    feasibility_stress = cost_stress(
        ledger.rename(columns={"realized_return":"realized_return"}),
        (20.0, 30.0, 50.0, 75.0, 100.0),
        30000.0,
        0.07,
        3,
    )
    summary["feasibility"] = feasibility
    summary["cost_stress"] = feasibility_stress
    summary["feasibility_engine"] = "luna-feasibility-v1"
    (out/"feasibility_summary.json").write_text(
        json.dumps({"baseline": feasibility, "cost_stress": feasibility_stress}, indent=2, default=str),
        encoding="utf-8",
    )
    pd.DataFrame(feasibility_stress).to_csv(out/"feasibility_cost_stress.csv", index=False)
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    print(json.dumps(summary,indent=2,default=str))

if __name__=="__main__": main()
