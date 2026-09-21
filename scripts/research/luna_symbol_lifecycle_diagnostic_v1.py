#!/usr/bin/env python3
"""LUNA symbol lifecycle / survivorship diagnostic v1.

Measures observed symbol entry/exit behavior in the research panel without
claiming that disappearance equals delisting. It is an audit of what the
dataset actually observes and a guard against silently treating a current
survivor set as the historical universe.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--min-history-months", type=int, default=12)
    args = ap.parse_args()

    d = pd.read_csv(args.input, usecols=["symbol", "month_end"])
    d["symbol"] = d["symbol"].astype(str)
    d["month_end"] = pd.to_datetime(d["month_end"], errors="coerce")
    d = d.dropna(subset=["symbol", "month_end"]).drop_duplicates(["symbol", "month_end"])
    if d.empty:
        raise SystemExit("empty symbol/month panel")

    months = sorted(d["month_end"].unique().tolist())
    month_set = set(months)
    by_symbol = d.groupby("symbol")["month_end"].agg(["min", "max", "count"])

    # Symbols observed in the final month define the explicit survivor set only
    # for the diagnostic. They are never treated as the historical universe.
    final_month = months[-1]
    final_survivors = set(d.loc[d["month_end"].eq(final_month), "symbol"])
    all_symbols = set(d["symbol"])
    historical_only = all_symbols - final_survivors

    active_by_month = {
        m: set(d.loc[d["month_end"].eq(m), "symbol"])
        for m in months
    }

    entries = []
    disappearances = []
    permanent_disappearances = []
    for i, m in enumerate(months):
        cur = active_by_month[m]
        prev = active_by_month[months[i - 1]] if i else set()
        entered = cur - prev if i else cur
        entries.append({"month_end": str(pd.Timestamp(m).date()), "count": len(entered)})
        if i:
            nxt = active_by_month[months[i + 1]]
            disappeared = prev - cur
            disappearances.append({
                "month_end": str(pd.Timestamp(m).date()),
                "count": len(disappeared),
            })
            # "Permanent" means the symbol never reappears later in the observed sample.
            later_union = set()
            for fm in months[i + 1:]:
                later_union.update(active_by_month[fm])
            permanent = sorted(disappeared - later_union)
            permanent_disappearances.append({
                "month_end": str(pd.Timestamp(m).date()),
                "count": len(permanent),
            })

    obs_per_symbol = by_symbol["count"].astype(int)
    eligible_long_history = by_symbol.index[obs_per_symbol >= args.min_history_months]

    # A disappearance ratio based on adjacent observed months is a data-behavior
    # metric, not a delisting rate.
    prior_counts = np.array([
        len(active_by_month[months[i - 1]])
        for i in range(1, len(months))
    ], dtype=float)
    disappearance_counts = np.array(
        [x["count"] for x in disappearances], dtype=float
    )
    ratios = np.divide(
        disappearance_counts,
        prior_counts,
        out=np.zeros_like(disappearance_counts),
        where=prior_counts > 0,
    )

    survivor_observation_share = (
        float(d["symbol"].isin(final_survivors).mean()) if len(d) else 0.0
    )

    last_observed = []
    for sym in eligible_long_history:
        row = by_symbol.loc[sym]
        if row["max"] < final_month:
            last_observed.append({
                "symbol": sym,
                "last_observed": str(pd.Timestamp(row["max"]).date()),
                "history_months": int(row["count"]),
            })

    result = {
        "status": "COMPLETED",
        "engine": "luna-symbol-lifecycle-diagnostic-v1",
        "sample_start": str(pd.Timestamp(months[0]).date()),
        "sample_end": str(pd.Timestamp(final_month).date()),
        "months": int(len(months)),
        "distinct_symbols": int(len(all_symbols)),
        "final_month_symbol_count": int(len(final_survivors)),
        "historical_only_symbol_count": int(len(historical_only)),
        "historical_only_symbol_fraction": float(
            len(historical_only) / len(all_symbols)
        ) if all_symbols else 0.0,
        "survivor_observation_share": survivor_observation_share,
        "entry_stats": {
            "total_entries_observed": int(sum(x["count"] for x in entries)),
            "max_monthly_entries": int(max((x["count"] for x in entries), default=0)),
            "mean_monthly_entries": float(np.mean([x["count"] for x in entries]))
            if entries else 0.0,
        },
        "disappearance_stats": {
            "total_adjacent_disappearances": int(
                sum(x["count"] for x in disappearances)
            ),
            "total_permanent_observed_disappearances": int(
                sum(x["count"] for x in permanent_disappearances)
            ),
            "mean_adjacent_disappearance_ratio": float(
                np.mean(ratios)
            ) if len(ratios) else 0.0,
            "max_adjacent_disappearance_ratio": float(
                np.max(ratios)
            ) if len(ratios) else 0.0,
            "definition": (
                "Observed month-to-month disappearance in this dataset; not a "
                "verified delisting rate and may include missing data or other causes."
            ),
        },
        "long_history": {
            "minimum_months": int(args.min_history_months),
            "eligible_symbols": int(len(eligible_long_history)),
            "eligible_non_final_survivors": int(
                sum(1 for s in eligible_long_history if s not in final_survivors)
            ),
            "last_observed_examples": last_observed[:50],
        },
        "survivorship_guard": {
            "current_survivor_only_is_not_historical_truth": True,
            "current_survivor_only_is_stress_only": True,
            "warning": (
                "A symbol absent from a later month is not labeled delisted unless "
                "an authoritative point-in-time security master confirms it."
            ),
        },
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    path = out / "symbol-lifecycle.json"
    path.write_text(
        json.dumps(result, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
