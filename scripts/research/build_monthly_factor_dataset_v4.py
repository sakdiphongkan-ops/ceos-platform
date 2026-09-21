#!/usr/bin/env python3
"""Build a point-in-time monthly panel for LUNA failure-driven research.

Keeps the full factor universe, derives REV21 as the negative 20-session
momentum alias for the legacy reversal benchmark, and computes fwd1 only when
the next calendar-month snapshot exists.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

FACTORS = [
    "MOM_5","MOM_10","MOM_20","MOM_40","MOM_60","MOM_80","MOM_120","MOM_252",
    "REV21","REL_MOM","VOL_10","VOL_20","MAXDD_60","ATR_PCT","ADV20","AMOUNT",
    "ILLIQ_20","BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60",
    "DIST_HIGH_252","SKEW_20","SKEW_60",
    # Point-in-time fundamentals; they remain NaN when no fundamentals feed is supplied.
    "PE","PBV","EV_EBITDA","FCF_YIELD","EARNINGS_YIELD","DIV_YIELD",
    "ROE","ROA","ROIC","GPM","NPM","CFO_MARGIN","REV_G","EPS_G","NI_G","FCF_G",
    "ASSET_G","CAPEX_G","INVESTMENT_RATE","DIV_G","PAYOUT","BUYBACK","DE",
    "NET_DEBT_EBITDA","INTEREST_COVER","CURRENT_RATIO","TURNOVER",
    "QUALITY_SCORE","VALUE_QUALITY","MOM_BLEND","CONSERVATIVE_SCORE",
    "SAFETY_SCORE","GROWTH_QUALITY","INV_QUALITY"
]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()

    d=pd.read_csv(args.input)
    required={"date","symbol","adj_close"}
    missing=sorted(required-set(d.columns))
    if missing: raise SystemExit(f"missing columns: {missing}")
    d["date"]=pd.to_datetime(d["date"],errors="raise")
    d["symbol"]=d["symbol"].astype(str).str.strip().str.upper()
    d["adj_close"]=pd.to_numeric(d["adj_close"],errors="coerce")
    for c in d.columns:
        if c not in {"date","symbol","sector","sector_code","industry","industry_code",
                     "sector_available_at","industry_available_at","metadata_available_at",
                     "listed_date","delist_date"}:
            d[c]=pd.to_numeric(d[c],errors="coerce")

    d=d.dropna(subset=["symbol","adj_close"]).sort_values(["symbol","date"])
    d["month_end"]=d["date"].dt.to_period("M").dt.to_timestamp("M")
    idx=d.groupby(["symbol","month_end"])["date"].idxmax()
    m=d.loc[idx].copy().sort_values(["month_end","symbol"]).reset_index(drop=True)

    out=m[["symbol","month_end","adj_close"]].copy()

    # Preserve optional point-in-time classification metadata for downstream
    # neutrality diagnostics. These columns are descriptive only unless an
    # explicit availability timestamp is supplied.
    metadata_cols=[
        "sector","sector_code","industry","industry_code",
        "sector_available_at","industry_available_at","metadata_available_at",
        "listed_date","delist_date"
    ]
    for c in metadata_cols:
        if c in m.columns and c not in out.columns:
            out[c]=m[c]
    for f in FACTORS:
        if f=="REV21":
            src="MOM_20"
            out[f]=-pd.to_numeric(m[src],errors="coerce") if src in m else np.nan
        else:
            out[f]=pd.to_numeric(m[f],errors="coerce") if f in m else np.nan

    # Strict next-calendar-month forward return.
    out["_next_month"]=out.groupby("symbol")["month_end"].shift(-1)
    out["_next_price"]=out.groupby("symbol")["adj_close"].shift(-1)
    expected=out["month_end"]+pd.offsets.MonthEnd(1)
    out["fwd1"]=np.where(
        out["_next_month"].eq(expected),
        out["_next_price"]/out["adj_close"]-1,
        np.nan,
    )
    out=out.drop(columns=["_next_month","_next_price"])
    out=out.replace([np.inf,-np.inf],np.nan).sort_values(["month_end","symbol"]).reset_index(drop=True)

    Path(args.output).parent.mkdir(parents=True,exist_ok=True)
    out.to_csv(args.output,index=False)
    manifest={
        "engine":"monthly-factor-builder-v4",
        "input_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "output_sha256":hashlib.sha256(Path(args.output).read_bytes()).hexdigest(),
        "rows":int(len(out)),
        "symbols":int(out.symbol.nunique()),
        "months":int(out.month_end.nunique()),
        "min_month":str(out.month_end.min()) if len(out) else None,
        "max_month":str(out.month_end.max()) if len(out) else None,
        "factor_count":len(FACTORS),
        "factor_missing_share":{f:float(out[f].isna().mean()) for f in FACTORS},
        "REV21_definition":"-MOM_20 alias; legacy reversal benchmark reference remains external/locked",
        "forward_return_definition":"next calendar-month-end snapshot only",
    }
    Path(str(args.output)+".manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    print(json.dumps(manifest,indent=2))

if __name__=="__main__":
    main()
