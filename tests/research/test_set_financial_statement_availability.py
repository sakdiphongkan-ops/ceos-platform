#!/usr/bin/env python3
"""Regression test for documented SET financial-statement availability derivation."""
from __future__ import annotations
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
SCRIPT=ROOT/"scripts/research/derive_set_financial_statement_availability_v1.py"

def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp=Path(tmp)
        fs=tmp/"fs.json"; lu=tmp/"last.json"; out=tmp/"out.json"
        fs.write_text(json.dumps({
            "data":[
                {"symbol":"PTT","fiscalYear":2025,"quarter":4,"asOfDate":"2025-12-31","roe":10.0},
                {"symbol":"AOT","fiscalYear":2025,"quarter":4,"asOfDate":"2025-12-31","roe":8.0}
            ]
        }),encoding="utf-8")
        lu.write_text(json.dumps({
            "data":[{"asOfYear":2025,"asOfQuarter":4,"lastUpdateDate":"2026-02-20"}]
        }),encoding="utf-8")
        subprocess.run([
            sys.executable,str(SCRIPT),
            "--financial-statement",str(fs),
            "--last-update",str(lu),
            "--output",str(out)
        ],check=True,cwd=ROOT)
        rows=json.loads(out.read_text(encoding="utf-8"))
        assert rows[0]["available_at"]=="2026-02-19T21:00:00+00:00", rows[0]
        assert rows[0]["asOfDate"]=="2025-12-31", rows[0]
        print("SET financial statement availability regression: OK")

if __name__=="__main__":
    main()
