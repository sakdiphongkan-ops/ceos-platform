#!/usr/bin/env python3
# Research panel builder: sparse factors are excluded factor-by-factor; no blanket dropna.\nfrom __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import numpy as np
import pandas as pd

FACTORS=[
"REV21","MOM_5","MOM_10","MOM_20","MOM_60","MOM_120","VOL_10","VOL_20",
"MAXDD_60","ADV20","RSI14","HIGH52_RATIO","DIST_MA20","DIST_MA60",
"BREAKOUT20","BREAKOUT55","SKEW_20","SKEW_60","REL_MOM"
]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True); ap.add_argument("--output",required=True)
    a=ap.parse_args()
    d=pd.read_csv(a.input)
    need={"date","symbol","adj_close"}
    miss=sorted(need-set(d.columns))
    if miss: raise SystemExit(f"missing columns: {miss}")
    d["date"]=pd.to_datetime(d["date"],errors="raise")
    d["symbol"]=d["symbol"].astype(str).str.strip().str.upper()
    d["adj_close"]=pd.to_numeric(d["adj_close"],errors="coerce")
    d=d.dropna(subset=["date","symbol","adj_close"]).sort_values(["symbol","date"])
    d=d.drop_duplicates(["symbol","date"],keep="last")
    g=d.groupby("symbol",group_keys=False)
    d["REV21"]=g["adj_close"].pct_change(21)
    hi=g["adj_close"].rolling(252,min_periods=252).max().reset_index(level=0,drop=True)
    d["HIGH52_RATIO"]=d["adj_close"]/hi-1.0
    d["month_end"]=d["date"].dt.to_period("M").dt.to_timestamp("M")
    ix=d.groupby(["symbol","month_end"])["date"].idxmax()
    m=d.loc[ix].copy().sort_values(["symbol","month_end"]).reset_index(drop=True)
    m["next_month_end"]=m.groupby("symbol")["month_end"].shift(-1)
    m["next_adj_close"]=m.groupby("symbol")["adj_close"].shift(-1)
    expected=m["month_end"]+pd.offsets.MonthEnd(1)
    m["fwd1"]=np.where(m["next_month_end"].eq(expected),
                       m["next_adj_close"]/m["adj_close"]-1.0,np.nan)
    outcols=["symbol","month_end","date","adj_close","REV21"]+[
        f for f in FACTORS if f!="REV21"
    ]+["fwd1"]
    for c in FACTORS:
        if c not in m.columns: m[c]=np.nan
        m[c]=pd.to_numeric(m[c],errors="coerce")
    out=m[outcols].rename(columns={"date":"snapshot_date"})
    # Do not blanket-drop sparse factors. Availability is tracked factor-by-factor
    # and the tournament excludes unavailable factors from the formula catalog.
    out=out.dropna(subset=["adj_close"]).sort_values(["month_end","symbol"]).reset_index(drop=True)
    p=Path(a.output); p.parent.mkdir(parents=True,exist_ok=True); out.to_csv(p,index=False)
    manifest={
      "engine":"monthly-snapshot-builder-v1",
      "input_sha256":hashlib.sha256(Path(a.input).read_bytes()).hexdigest(),
      "output_sha256":hashlib.sha256(p.read_bytes()).hexdigest(),
      "rows":int(len(out)),"symbols":int(out.symbol.nunique()),
      "factor_coverage":{f:float(out[f].notna().mean()) for f in FACTORS},
      "months":int(out.month_end.nunique()),
      "min_month":str(out.month_end.min()) if len(out) else None,
      "max_month":str(out.month_end.max()) if len(out) else None,
      "rev21_definition":"adj_close(t)/adj_close(t-21 trading observations)-1",
      "fwd1_definition":"next calendar month-end snapshot only; missing month => NaN"
    }
    Path(str(p)+".manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    print(json.dumps(manifest,indent=2))

if __name__=="__main__": main()
