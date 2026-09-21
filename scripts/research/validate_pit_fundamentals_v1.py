#!/usr/bin/env python3
"""Validate LUNA PIT fundamental feed v1."""
from __future__ import annotations
import argparse, json
from pathlib import Path
import pandas as pd

NUMERIC = [
    "pe","pbv","ev_ebitda","fcf_yield","earnings_yield","div_yield","roe","roa","roic",
    "gpm","npm","cfo_margin","rev_g","eps_g","ni_g","fcf_g","asset_g","capex_g",
    "investment_rate","div_g","payout","buyback","de","net_debt_ebitda","interest_cover",
    "current_ratio","turnover"
]
ALLOWED = {"symbol","available_at","as_of_date","fiscal_year","quarter","statement_type",
           "adjustment_status","source","source_record_id",*NUMERIC}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--allow-missing",action="store_true")
    args=ap.parse_args()

    src=Path(args.input); out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    if not src.exists():
        if not args.allow_missing:
            raise SystemExit(f"PIT fundamentals not found: {src}")
        result={"status":"UNAVAILABLE","engine":"luna-pit-fundamentals-validator-v1",
                "reason":f"Input not present: {src}",
                "contract":"data/contracts/luna_pit_fundamentals_v1.schema.json"}
        (out/"pit-fundamentals-validation.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
        print(json.dumps(result,indent=2)); return

    d=pd.read_csv(src)
    required={"symbol","available_at"}
    missing=sorted(required-set(d.columns))
    unknown=sorted(set(d.columns)-ALLOWED)
    if missing: raise SystemExit(f"missing required PIT fundamental columns: {missing}")
    if unknown: raise SystemExit(f"unexpected PIT fundamental columns: {unknown}")

    d["symbol"]=d["symbol"].astype("string").str.strip().str.upper()
    d["available_at"]=pd.to_datetime(d["available_at"],errors="coerce",utc=True)
    if "as_of_date" in d.columns:
        d["as_of_date"]=pd.to_datetime(d["as_of_date"],errors="coerce")
    if "fiscal_year" in d.columns:
        d["fiscal_year"]=pd.to_numeric(d["fiscal_year"],errors="coerce")
    if "quarter" in d.columns:
        d["quarter"]=pd.to_numeric(d["quarter"],errors="coerce")

    issues=[]
    bad=int(d["symbol"].isna().sum()+d["symbol"].eq("").sum())
    if bad: issues.append({"check":"symbol_present","bad_rows":bad})
    bad=int(d["available_at"].isna().sum())
    if bad: issues.append({"check":"available_at_present","bad_rows":bad})

    if "quarter" in d.columns:
        bad=int((d["quarter"].notna() & ~d["quarter"].isin([1,2,3,4,9])).sum())
        if bad: issues.append({"check":"quarter_domain","bad_rows":bad})

    for col in NUMERIC:
        if col in d.columns:
            vals=pd.to_numeric(d[col],errors="coerce")
            original=d[col].notna()
            bad=int((original & vals.isna()).sum())
            if bad: issues.append({"check":f"{col}_numeric","bad_rows":bad})

    key=[c for c in ["symbol","fiscal_year","quarter","statement_type","adjustment_status","available_at"] if c in d.columns]
    dup=int(d.duplicated(key,keep=False).sum()) if key else 0
    if dup: issues.append({"check":"source_identity_unique","bad_rows":dup,"key":key})

    # available_at may be later than as_of_date, but never earlier by a
    # negative accounting chronology is itself not prohibited; the contract
    # therefore records the relationship instead of inventing a publication date.
    chronology=None
    if "as_of_date" in d.columns:
        available_date=d["available_at"].dt.tz_convert(None).dt.normalize()
        chronology={
            "rows_available_before_asof":int((d["available_at"].notna() & d["as_of_date"].notna() &
                                             (available_date < d["as_of_date"])).sum()),
            "definition":"Informational only: reporting as-of date is not treated as availability date."
        }

    result={
        "status":"COMPLETED" if not issues else "FAILED",
        "engine":"luna-pit-fundamentals-validator-v1",
        "input":str(src),
        "rows":int(len(d)),
        "symbols":int(d["symbol"].nunique(dropna=True)),
        "numeric_fields_present":[c for c in NUMERIC if c in d.columns],
        "checks_failed":issues,
        "chronology":chronology,
        "contract":"data/contracts/luna_pit_fundamentals_v1.schema.json",
        "time_rule":"available_at <= decision_ts for a point-in-time join."
    }
    (out/"pit-fundamentals-validation.json").write_text(json.dumps(result,indent=2,ensure_ascii=False,default=str),encoding="utf-8")
    print(json.dumps(result,indent=2,ensure_ascii=False,default=str))
    if issues: raise SystemExit("PIT fundamentals validation failed")
if __name__=="__main__": main()
