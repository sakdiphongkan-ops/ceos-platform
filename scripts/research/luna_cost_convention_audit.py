#!/usr/bin/env python3
"""Audit LUNA transaction-cost convention without changing upstream research selection."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def geo(x):
    s = pd.Series(x, dtype=float).dropna()
    if s.empty or (s <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(s).mean()))


def stats(returns, initial_capital=30000.0):
    s = pd.Series(returns, dtype=float).dropna()
    if s.empty:
        return {"months": 0, "geometric_monthly_return": -1.0}
    eq = initial_capital * np.cumprod(1 + s.to_numpy())
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1
    i = int(np.argmin(dd))
    return {
        "months": int(len(s)),
        "geometric_monthly_return": geo(s),
        "cumulative_return": float(eq[-1] / initial_capital - 1),
        "positive_month_pct": float((s > 0).mean()),
        "target_hit_pct": float((s >= 0.07).mean()),
        "max_drawdown_pct": float(dd[i]),
        "max_drawdown_baht": float(eq[i] - peak[i]),
        "ending_baht": float(eq[-1]),
        "min_monthly_return": float(s.min()),
        "max_monthly_return": float(s.max()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--initial-capital", type=float, default=30000.0)
    ap.add_argument("--cost-bps-per-side", default="16,20,30,50,75,100")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(args.ledger)
    required = {"month_end", "gross_return", "turnover", "transaction_cost", "realized_return"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"COST_AUDIT_REQUIRED_COLUMNS_MISSING:{missing}")

    rows = []
    for bps in [float(x.strip()) for x in args.cost_bps_per_side.split(",") if x.strip()]:
        one_sided = df["gross_return"] - df["turnover"] * bps / 10000.0
        two_sided = df["gross_return"] - 2.0 * df["turnover"] * bps / 10000.0
        one = stats(one_sided, args.initial_capital)
        two = stats(two_sided, args.initial_capital)
        rows.append({
            "cost_bps_per_side": bps,
            "one_sided_geometric_monthly_return": one["geometric_monthly_return"],
            "two_sided_geometric_monthly_return": two["geometric_monthly_return"],
            "one_sided_cumulative_return": one["cumulative_return"],
            "two_sided_cumulative_return": two["cumulative_return"],
            "one_sided_max_drawdown_baht": one["max_drawdown_baht"],
            "two_sided_max_drawdown_baht": two["max_drawdown_baht"],
            "one_sided_ending_baht": one["ending_baht"],
            "two_sided_ending_baht": two["ending_baht"],
            "two_sided_minus_one_sided_geo": two["geometric_monthly_return"] - one["geometric_monthly_return"],
        })

    result = {
        "status": "COMPLETED",
        "engine": "luna-cost-convention-audit-v1",
        "initial_capital_baht": args.initial_capital,
        "purpose": "Detect whether upstream strategy conclusions depend on an under-specified one-sided turnover cost model.",
        "interpretation": {
            "one_sided": "replacement fraction multiplied by one per-side cost",
            "two_sided": "replacement fraction multiplied by two per-side trading legs (sell + buy)",
            "important": "The audit does not assume a broker commission rate; it compares conventions.",
        },
        "results": rows,
    }
    (out / "cost_convention_audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    pd.DataFrame(rows).to_csv(out / "cost_convention_audit.csv", index=False)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
