import csv, tempfile
from pathlib import Path
from apply_pit_universe import load_membership, build_index, eligible

with tempfile.TemporaryDirectory() as d:
    p=Path(d)/"m.csv"
    p.write_text("symbol,start_date,end_date\nAAA,2024-01-01,2024-12-31\nAAA,2025-01-01,\nBBB,2025-06-01,2025-06-30\n",encoding="utf-8")
    idx=build_index(load_membership(str(p)))
    assert eligible(idx,"AAA",__import__("datetime").date(2024,6,1))
    assert not eligible(idx,"AAA",__import__("datetime").date(2023,12,31))
    assert eligible(idx,"AAA",__import__("datetime").date(2026,1,1))
    assert not eligible(idx,"BBB",__import__("datetime").date(2025,7,1))

    # Market-date boundary is Asia/Bangkok, not UTC.
    import datetime as dt
    from zoneinfo import ZoneInfo
    boundary=dt.datetime.fromisoformat("2024-12-31T17:30:00+00:00").astimezone(ZoneInfo("Asia/Bangkok")).date()
    assert boundary == dt.date(2025,1,1)
    assert eligible(idx,"AAA",boundary)
print("PIT universe test: PASS")
