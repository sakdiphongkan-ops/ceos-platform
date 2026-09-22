import csv, json, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
NORMALIZE=ROOT/"scripts/research/normalize_set_tick_data.py"
QA=ROOT/"scripts/research/qa_verified_15m.py"

with tempfile.TemporaryDirectory() as d:
    base=Path(d)
    raw=base/"raw.csv"
    out=base/"normalized.csv"
    report=base/"qa.json"
    raw.write_text(
        "event_time,symbol,bid,ask,last,bid_vol,ask_vol\n"
        "2026-09-21T03:00:00+00:00,AAA,100,100.1,100.05,1000,1200\n"
        "2026-09-21T03:00:00+00:00,AAA,100.1,100.2,100.15,900,1100\n",
        encoding="utf-8"
    )
    mapping=json.dumps({
        "ts":"event_time","symbol":"symbol","bid":"bid","ask":"ask","last":"last",
        "bid_size":"bid_vol","ask_size":"ask_vol"
    })
    subprocess.run([
        sys.executable,str(NORMALIZE),
        "--input",str(raw),
        "--output",str(out),
        "--mapping-json",mapping,
    ],check=True)
    with out.open(encoding="utf-8") as f:
        rows=list(csv.DictReader(f))
    assert len(rows)==2
    assert all(r["source_ts"]==r["ts"] for r in rows)
    assert all(r["data_quality"]=="verified" for r in rows)

    subprocess.run([
        sys.executable,str(QA),
        "--input",str(out),
        "--output",str(report),
        "--min-symbols","1",
        "--min-verified-book-ratio","1.0",
    ],check=True)
    result=json.loads(report.read_text(encoding="utf-8"))
    assert result["status"]=="PASS"
    assert result["source_timestamp_coverage"]==1.0
    assert result["duplicate_rows"]==0

print("SET data normalization contract test: PASS")
