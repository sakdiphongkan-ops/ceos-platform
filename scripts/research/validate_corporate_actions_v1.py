#!/usr/bin/env python3
"""Validate LUNA corporate-action ledger v1."""
from __future__ import annotations
import argparse, json
from pathlib import Path
import pandas as pd

ALLOWED={"symbol","action_type","effective_date","available_at","ex_date","payment_date",
         "ratio_num","ratio_den","cash_amount","old_symbol","new_symbol","source","source_record_id"}
ACTIONS={"SPLIT","REVERSE_SPLIT","BONUS","RIGHTS","DIVIDEND","DELIST","LIST","NAME_CHANGE","OTHER"}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--allow-missing",action="store_true")
    args=ap.parse_args()

    src=Path(args.input); out=Path(args.output); out.mkdir(parents=True,exist_ok=True)
    if not src.exists():
        if not args.allow_missing:
            raise SystemExit(f"corporate action ledger not found: {src}")
        result={"status":"UNAVAILABLE","engine":"luna-corporate-actions-validator-v1",
                "reason":f"Input not present: {src}",
                "contract":"data/contracts/luna_corporate_actions_v1.schema.json"}
        (out/"corporate-actions-validation.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
        print(json.dumps(result,indent=2)); return

    d=pd.read_csv(src)
    required={"symbol","action_type","effective_date","available_at"}
    missing=sorted(required-set(d.columns)); unknown=sorted(set(d.columns)-ALLOWED)
    if missing: raise SystemExit(f"missing corporate-action columns: {missing}")
    if unknown: raise SystemExit(f"unexpected corporate-action columns: {unknown}")

    d["symbol"]=d["symbol"].astype("string").str.strip().str.upper()
    d["action_type"]=d["action_type"].astype("string").str.strip().str.upper()
    d["effective_date"]=pd.to_datetime(d["effective_date"],errors="coerce")
    d["available_at"]=pd.to_datetime(d["available_at"],errors="coerce",utc=True)
    for c in ["ex_date","payment_date"]:
        if c in d.columns: d[c]=pd.to_datetime(d[c],errors="coerce")

    issues=[]
    bad=int(d["symbol"].isna().sum()+d["symbol"].eq("").sum())
    if bad: issues.append({"check":"symbol_present","bad_rows":bad})
    bad=int(d["action_type"].isna().sum() + (~d["action_type"].isin(ACTIONS)).sum())
    if bad: issues.append({"check":"action_type_domain","bad_rows":bad})
    for c in ["effective_date","available_at"]:
        bad=int(d[c].isna().sum())
        if bad: issues.append({"check":f"{c}_present","bad_rows":bad})

    if "ratio_num" in d.columns and "ratio_den" in d.columns:
        rn=pd.to_numeric(d["ratio_num"],errors="coerce")
        rd=pd.to_numeric(d["ratio_den"],errors="coerce")
        bad=int(((rn.notna() & (rn<=0)) | (rd.notna() & (rd<=0))).sum())
        if bad: issues.append({"check":"positive_ratios","bad_rows":bad})

    if "cash_amount" in d.columns:
        raw_cash=d["cash_amount"]
        cash=pd.to_numeric(raw_cash,errors="coerce")
        bad=int((raw_cash.notna() & cash.isna()).sum())
        if bad: issues.append({"check":"cash_amount_numeric","bad_rows":bad})

    # Event availability can be after its economic effective date. That is valid.
    # The important leakage rule is enforced downstream: available_at <= decision_ts.
    duplicate_key=[c for c in ["symbol","action_type","effective_date","ex_date","source_record_id"] if c in d.columns]
    if duplicate_key:
        dup=int(d.duplicated(duplicate_key,keep=False).sum())
        if dup: issues.append({"check":"event_identity_unique","bad_rows":dup,"key":duplicate_key})

    result={
        "status":"COMPLETED" if not issues else "FAILED",
        "engine":"luna-corporate-actions-validator-v1",
        "input":str(src),
        "rows":int(len(d)),
        "symbols":int(d["symbol"].nunique(dropna=True)),
        "action_type_counts":{str(k):int(v) for k,v in d["action_type"].value_counts(dropna=False).items()},
        "checks_failed":issues,
        "contract":"data/contracts/luna_corporate_actions_v1.schema.json",
        "time_rule":"available_at <= decision_ts for event eligibility."
    }
    (out/"corporate-actions-validation.json").write_text(json.dumps(result,indent=2,ensure_ascii=False,default=str),encoding="utf-8")
    print(json.dumps(result,indent=2,ensure_ascii=False,default=str))
    if issues: raise SystemExit("corporate action validation failed")
if __name__=="__main__": main()
