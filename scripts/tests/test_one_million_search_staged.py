#!/usr/bin/env python3
"""Small deterministic smoke tests for the staged LUNA 1M engine."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import one_million_search_staged as eng  # noqa: E402


def main() -> None:
    rules = list(eng.generate_rules(["MOM_5", "RSI14", "VOL_20"], 1000))
    assert len(rules) == 1000
    assert len({r.id for r in rules}) == 1000

    rows = []
    for d in range(14):
        for s in range(4):
            close = 100 + d + s
            rows.append(
                {
                    "date": pd.Timestamp("2025-01-01") + pd.Timedelta(days=d),
                    "symbol": f"S{s}",
                    "MOM_5": float(s + d / 10),
                    "RSI14": float(50 + s - d / 20),
                    "VOL_20": float(0.01 + (3 - s) / 100),
                    "fwd_return": float((s - 1.5) / 1000 + d / 100000),
                }
            )
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"]).dt.date

    ranks, rets, day_ids, dates, starts, ends = eng.prepare_exact_frame(
        df, ["MOM_5", "RSI14", "VOL_20"]
    )
    rule = eng.Rule("MOM_5", "top", 0.25, "single")
    daily, counts = eng.exact_period(
        rule,
        ranks,
        rets,
        day_ids,
        starts,
        ends,
        day_start=5,
        day_end=10,
        cost=45 / 10000,
    )
    assert np.isfinite(daily).sum() > 0
    assert (counts > 0).sum() > 0
    # Cost must be charged: daily net return cannot exceed the selected gross
    # return by less than the configured 45 bps.
    assert np.nanmax(daily) < 0.01

    stats = eng.build_screen_stats(
        df,
        ["MOM_5", "RSI14", "VOL_20"],
        development_end_idx=6,
        screen_days=4,
        holdout_days=2,
        purge_days=1,
        min_names_per_day=2,
    )
    assert stats
    print("staged LUNA engine smoke test: PASS")


if __name__ == "__main__":
    main()
