import pandas as pd
from pit_financials import PointInTimeFinancials

def make_rows():
    return pd.DataFrame([
        {"ticker":"AAA","period_end":"2025-03-31","published_at":"2025-05-10T09:00:00+07:00","retrieved_at":"2025-05-10T09:01:00+07:00","net_profit":100,"total_assets":1000,"equity":500,"revenue":1000},
        {"ticker":"AAA","period_end":"2025-03-31","published_at":"2025-05-10T09:00:00+07:00","retrieved_at":"2025-05-11T09:01:00+07:00","net_profit":100,"total_assets":1000,"equity":500,"revenue":1000},
        {"ticker":"AAA","period_end":"2025-03-31","published_at":"2025-05-10T09:01:00+07:00","retrieved_at":"2025-08-20T09:01:00+07:00","net_profit":70,"total_assets":1020,"equity":510,"revenue":1000},
    ])

def calendar():
    return pd.to_datetime(
        ["2025-05-12","2025-08-21","2025-08-22"],
        utc=True,
    ).tz_convert("Asia/Bangkok")

def prepared():
    m=PointInTimeFinancials()
    return m, m.assign_available_at(make_rows(), calendar())

def test_duplicate_content_is_not_a_restatement():
    m, rows = prepared()
    r=m.detect_revisions(rows)
    assert len(r)==2
    assert r["revision_no"].tolist()==[0,1]
    assert r["is_restated"].tolist()==[False,True]

def test_snapshot_asof_blocks_future_restatement():
    m, rows = prepared()
    s=m.detect_revisions(rows)
    before=m.snapshot_asof(s,"2025-08-01T23:59:59+07:00")
    after=m.snapshot_asof(s,"2025-08-21T23:59:59+07:00")
    assert float(before.iloc[0]["net_profit"])==100
    assert float(after.iloc[0]["net_profit"])==70

def test_price_merge_is_point_in_time():
    m, rows = prepared()
    s=m.detect_revisions(rows)
    prices=pd.DataFrame([
        {"date":"2025-08-01T10:00:00+07:00","ticker":"AAA"},
        {"date":"2025-08-21T10:00:00+07:00","ticker":"AAA"},
    ])
    r=m.merge_prices(s,prices)
    assert r.iloc[0]["net_profit"]==100
    assert r.iloc[1]["net_profit"]==70

def test_missing_available_at_is_rejected():
    m=PointInTimeFinancials()
    try:
        m.detect_revisions(make_rows())
    except ValueError:
        pass
    else:
        raise AssertionError("PIT accepted data without available_at")

def test_next_trading_day_is_conservative():
    m=PointInTimeFinancials()
    rows=make_rows()
    out=m.assign_available_at(rows, calendar())
    assert out["available_at"].dt.strftime("%Y-%m-%d").tolist() == [
        "2025-05-12","2025-05-12","2025-08-21"
    ]
    assert (out["available_at"] > out["published_at"]).all()

def test_safe_pct_change_handles_zero():
    m=PointInTimeFinancials()
    assert m.safe_pct_change(0,0)==0.0
    assert m.safe_pct_change(0,100) is None
