#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

def sha256(path:Path)->str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--membership",required=True)
    ap.add_argument("--manifest",required=True)
    ap.add_argument("--allowed-domains",default="set.or.th,settrade.com")
    args=ap.parse_args()
    membership=Path(args.membership); manifest=Path(args.manifest)
    if not membership.is_file() or not manifest.is_file():
        raise SystemExit("PIT_MEMBERSHIP_AND_MANIFEST_REQUIRED")
    m=json.loads(manifest.read_text(encoding="utf-8"))
    required=("schema_version","provider","source_url","authority_level","retrieved_at","membership_file_sha256")
    for k in required:
        if not str(m.get(k,"")).strip(): raise SystemExit(f"PIT_MANIFEST_MISSING:{k}")
    if m["schema_version"]!="LUNA-PIT-MEMBERSHIP-V1": raise SystemExit("PIT_MANIFEST_SCHEMA_INVALID")
    if m["membership_file_sha256"]!=sha256(membership): raise SystemExit("PIT_MEMBERSHIP_SHA256_MISMATCH")
    if str(m["authority_level"]) not in {"PRIMARY_EXCHANGE","INDEX_PROVIDER","ISSUER_OFFICIAL"}:
        raise SystemExit("PIT_MANIFEST_AUTHORITY_LEVEL_INVALID")
    if not isinstance(m["retrieved_at"],str): raise SystemExit("PIT_MANIFEST_RETRIEVED_AT_INVALID")
    if not datetime.fromisoformat(m["retrieved_at"].replace("Z","+00:00")): raise SystemExit("PIT_MANIFEST_RETRIEVED_AT_INVALID")
    host=(urlparse(str(m["source_url"])).hostname or "").lower()
    allowed=[x.strip().lower() for x in args.allowed_domains.split(",") if x.strip()]
    if not any(host==d or host.endswith("."+d) for d in allowed):
        raise SystemExit(f"PIT_MANIFEST_SOURCE_DOMAIN_NOT_ALLOWED:{host}")
    print(json.dumps({"status":"PASS","membership_sha256":sha256(membership),"source_url":m["source_url"],"authority_level":m["authority_level"]},indent=2))
if __name__=="__main__": main()
