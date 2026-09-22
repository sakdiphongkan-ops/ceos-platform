#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, sys
from datetime import datetime, timezone
from pathlib import Path

def fail(msg:str)->None:
    print(json.dumps({"status":"BLOCKED","reason":msg},ensure_ascii=False))
    raise SystemExit(2)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--marker",required=True)
    ap.add_argument("--result",required=True)
    ap.add_argument("--protocol",required=True)
    ap.add_argument("--dataset-sha",default="")
    ap.add_argument("--selection-sha",default="")
    ap.add_argument("--holdout-start",default="")
    ap.add_argument("--mode",choices=["check","seal"],default="check")
    args=ap.parse_args()

    marker=Path(args.marker)
    result=Path(args.result)

    if marker.exists():
        fail(f"HOLDOUT_ALREADY_SEALED:{marker}")
    if result.exists() and args.mode=="check":
        fail(f"HOLDOUT_RESULT_ALREADY_EXISTS:{result}")

    if args.mode=="seal":
        if not result.exists() and not marker.exists():
            fail(f"CANNOT_SEAL_WITHOUT_RESULT:{result}")
        marker.parent.mkdir(parents=True,exist_ok=True)
        payload={
            "schemaVersion":"LUNA-HOLDOUT-EXPOSURE-V2",
            "protocolVersion":args.protocol,
            "sealedAt":datetime.now(timezone.utc).isoformat(),
            "datasetSha256":args.dataset_sha or None,
            "selectionRevision":args.selection_sha or None,
            "holdoutStart":args.holdout_start or None,
            "resultPath":str(result),
            "gitCommit":os.getenv("GITHUB_SHA") or os.getenv("RAILWAY_GIT_COMMIT_SHA") or None,
            "runner":"github-actions",
        }
        marker.write_text(json.dumps(payload,indent=2)+"\n",encoding="utf-8")
        print(json.dumps({"status":"SEALED","marker":str(marker)},ensure_ascii=False))
        return

    print(json.dumps({"status":"OPEN","marker":str(marker),"result":str(result)},ensure_ascii=False))

if __name__=="__main__":
    main()
