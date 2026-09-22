#!/usr/bin/env python3
"""Filter intraday quotes using point-in-time security-universe membership.

Membership CSV columns:
symbol,start_date,end_date
Dates are ISO YYYY-MM-DD; end_date may be blank for still-active securities.
A quote is eligible only when start_date <= quote date <= end_date.
"""
import argparse, csv, hashlib, json
from datetime import datetime, timezone
from pathlib import Path

def parse_date(s):
    return datetime.fromisoformat(s.strip().replace("Z","+00:00")).date()

def load_membership(path):
    rows=[]
    with open(path,newline="",encoding="utf-8") as f:
        for r in csv.DictReader(f):
            symbol=(r.get("symbol") or "").strip().upper().replace(".BK","")
            if not symbol: continue
            start=parse_date(r["start_date"])
            end=parse_date(r["end_date"]) if (r.get("end_date") or "").strip() else None
            if end and end<start: raise ValueError(f"end_date before start_date: {symbol}")
            rows.append((symbol,start,end))
    if not rows: raise ValueError("No membership rows")
    return rows

def build_index(rows):
    idx={}
    for symbol,start,end in rows:
        idx.setdefault(symbol,[]).append((start,end))
    return idx

def eligible(index,symbol,day):
    return any(start<=day and (end is None or day<=end) for start,end in index.get(symbol,()))

def filter_dataframe_by_date(df, membership_path, date_column):
    members=load_membership(membership_path)
    index=build_index(members)
    dates=df[date_column].dt.date if hasattr(df[date_column].dtype,"tz") is False else df[date_column].dt.tz_convert("UTC").dt.date
    mask=[
        eligible(index,str(symbol),day)
        for symbol,day in zip(df["symbol"],dates)
    ]
    out=df.loc[mask].copy()
    if out.empty:
        raise ValueError("PIT_UNIVERSE_FILTER_REMOVED_ALL_ROWS")
    return out, len(df)-len(out), len(set(out["symbol"]))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--quotes",required=True)
    ap.add_argument("--membership",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--manifest",default=None)
    args=ap.parse_args()
    members=load_membership(args.membership)
    member_index=build_index(members)
    with open(args.quotes,newline="",encoding="utf-8") as f:
        reader=csv.DictReader(f)
        fields=reader.fieldnames or []
        if "symbol" not in fields or "ts" not in fields: raise ValueError("quotes require symbol,ts")
        rows=list(reader)
    out=[]
    excluded=0
    for r in rows:
        symbol=r["symbol"].strip().upper().replace(".BK","")
        ts=r["ts"].replace("Z","+00:00")
        day=datetime.fromisoformat(ts).date()
        if eligible(member_index,symbol,day):
            r["symbol"]=symbol
            out.append(r)
        else: excluded+=1
    out.sort(key=lambda r:(r["ts"],r["symbol"]))
    with open(args.output,"w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=fields)
        w.writeheader(); w.writerows(out)
    def sha(p):
        h=hashlib.sha256()
        with open(p,"rb") as f:
            for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
        return h.hexdigest()
    manifest={
      "status":"COMPLETED","input_rows":len(rows),"output_rows":len(out),
      "excluded_rows":excluded,"membership_rows":len(members),
      "input_sha256":sha(args.quotes),"membership_sha256":sha(args.membership),
      "output_sha256":sha(args.output),
      "point_in_time_rule":"start_date <= quote UTC date <= end_date; blank end_date means open-ended",
      "generated_at":datetime.now(timezone.utc).isoformat()
    }
    mp=args.manifest or args.output+".manifest.json"
    Path(mp).write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    print(json.dumps(manifest,indent=2))

if __name__=="__main__": main()
