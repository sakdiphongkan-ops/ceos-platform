#!/usr/bin/env python3
"""LUNA M1 + P10 regime selector.

Research-only hybrid:
1) Candidate A is the locked M1 reversal portfolio supplied as monthly holdings.
2) Candidate B is a pre-specified P10 momentum/trend portfolio built from PIT-ranked
   factor data: 0.60*MOM1 + 0.30*52W_HIGH_RATIO - 0.10*VOL20, top-5.
3) At month t, select A or B using only the trailing lookback-month geometric
   net return of each candidate, including that candidate's own turnover cost.
4) The selected portfolio is charged the actual turnover cost based on its
   selected holdings. Holdout is never used to tune the lookback.

This module is intentionally research-only. It does not arm or deploy live trading.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


P10_FORMULA = {
    "mom1_weight": 0.60,
    "high52_weight": 0.30,
    "vol20_weight": -0.10,
    "k": 5,
}


def geometric_return(x: pd.Series) -> float:
    x = pd.Series(x, dtype=float).dropna()
    if x.empty or (x <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(x).mean()))


def max_drawdown(returns: pd.Series, initial_capital: float = 30000.0) -> dict:
    x = pd.Series(returns, dtype=float).dropna()
    if x.empty:
        return {"max_drawdown_pct": None, "max_drawdown_baht": None}
    equity = initial_capital * np.cumprod(1.0 + x.to_numpy())
    peak = np.maximum.accumulate(equity)
    dd = equity / peak - 1.0
    i = int(np.argmin(dd))
    return {
        "max_drawdown_pct": float(dd[i]),
        "max_drawdown_baht": float(equity[i] - peak[i]),
    }


def validate_frame(df: pd.DataFrame, required: set[str], name: str) -> None:
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"{name}_REQUIRED_COLUMNS_MISSING:{missing}")
    if df.empty:
        raise SystemExit(f"{name}_EMPTY")
    if df["month_end"].isna().any() or df["symbol"].isna().any():
        raise SystemExit(f"{name}_INVALID_KEYS")


def build_p10(rank_df: pd.DataFrame) -> pd.DataFrame:
    required = {"month_end", "symbol", "fwd1", "r_mom1", "r_high52_ratio", "r_vol20"}
    validate_frame(rank_df, required, "P10")
    x = rank_df.copy()
    x["month_end"] = pd.to_datetime(x["month_end"])
    x["score"] = (
        P10_FORMULA["mom1_weight"] * pd.to_numeric(x["r_mom1"])
        + P10_FORMULA["high52_weight"] * pd.to_numeric(x["r_high52_ratio"])
        + P10_FORMULA["vol20_weight"] * pd.to_numeric(x["r_vol20"])
    )
    x["fwd"] = pd.to_numeric(x["fwd1"], errors="coerce")
    x = x.dropna(subset=["fwd", "score"]).sort_values(
        ["month_end", "score", "symbol"], ascending=[True, False, True]
    )
    x["rn"] = x.groupby("month_end").cumcount() + 1
    x = x[x["rn"] <= P10_FORMULA["k"]]
    return x[["month_end", "symbol", "fwd"]].assign(strategy="P10", k=5)


def build_m1(m1_df: pd.DataFrame) -> pd.DataFrame:
    required = {"month_end", "symbol", "next_month_return"}
    validate_frame(m1_df, required, "M1")
    x = m1_df.copy()
    x["month_end"] = pd.to_datetime(x["month_end"])
    x["fwd"] = pd.to_numeric(x["next_month_return"], errors="coerce")
    x = x.dropna(subset=["fwd"])
    return x[["month_end", "symbol", "fwd"]].assign(strategy="M1", k=20)


def candidate_monthly_stats(holdings: pd.DataFrame, cost_bps: float) -> pd.DataFrame:
    grouped = holdings.groupby(["strategy", "month_end"], sort=True)
    rows = []
    for (strategy, month_end), frame in grouped:
        symbols = set(frame["symbol"])
        rows.append({
            "strategy": strategy,
            "month_end": month_end,
            "k": int(frame["k"].iloc[0]),
            "gross": float(frame["fwd"].mean()),
            "symbols": symbols,
        })
    out = pd.DataFrame(rows).sort_values(["strategy", "month_end"])
    out["turnover"] = 1.0
    for strategy, idx in out.groupby("strategy").groups.items():
        prev = set()
        for i in idx:
            cur = out.at[i, "symbols"]
            k = max(int(out.at[i, "k"]), 1)
            out.at[i, "turnover"] = 1.0 if not prev else 1.0 - len(cur & prev) / k
            prev = cur
    out["net"] = out["gross"] - out["turnover"] * cost_bps / 10000.0
    return out


def select_regime(
    stats: pd.DataFrame,
    lookback_months: int,
    first_trade_date: pd.Timestamp,
) -> pd.DataFrame:
    rows = []
    months = sorted(stats["month_end"].unique())
    for month in months:
        if month < first_trade_date:
            continue
        candidates = []
        for strategy in sorted(stats["strategy"].unique()):
            frame = stats[(stats["strategy"] == strategy) & (stats["month_end"] < month)]
            frame = frame.tail(lookback_months)
            if len(frame) < lookback_months:
                continue
            candidates.append((geometric_return(frame["net"]), strategy))
        if not candidates:
            continue
        candidates.sort(key=lambda z: (-z[0], z[1]))
        rows.append({
            "month_end": month,
            "selected_strategy": candidates[0][1],
            "selected_history_geo": candidates[0][0],
        })
    return pd.DataFrame(rows)


def build_meta_path(
    holdings: pd.DataFrame,
    choices: pd.DataFrame,
    cost_bps: float,
) -> pd.DataFrame:
    selected = choices.merge(
        holdings,
        left_on=["month_end", "selected_strategy"],
        right_on=["month_end", "strategy"],
        how="inner",
    )
    rows = []
    prev_symbols: set[str] = set()
    for month, frame in selected.groupby("month_end", sort=True):
        symbols = set(frame["symbol"])
        k = int(frame["k"].iloc[0])
        turnover = 1.0 if not prev_symbols else 1.0 - len(symbols & prev_symbols) / max(k, 1)
        gross = float(frame["fwd"].mean())
        rows.append({
            "month_end": month,
            "selected_strategy": frame["selected_strategy"].iloc[0],
            "k": k,
            "gross_return": gross,
            "turnover": turnover,
            "transaction_cost": turnover * cost_bps / 10000.0,
            "net_return": gross - turnover * cost_bps / 10000.0,
        })
        prev_symbols = symbols
    return pd.DataFrame(rows)


def summarize(frame: pd.DataFrame, initial_capital: float = 30000.0) -> dict:
    if frame.empty:
        return {"months": 0}
    r = pd.to_numeric(frame["net_return"], errors="coerce").dropna()
    result = {
        "months": int(len(r)),
        "geometric_monthly_return": geometric_return(r),
        "cumulative_return": float(np.prod(1.0 + r.to_numpy()) - 1.0),
        "positive_month_pct": float((r > 0).mean()),
        "average_turnover": float(frame["turnover"].mean()),
    }
    result.update(max_drawdown(r, initial_capital))
    return result


def cost_stress(frame: pd.DataFrame, bps_values=(20, 40, 60, 100)) -> list[dict]:
    rows = []
    for bps in bps_values:
        x = frame.copy()
        x["net_return"] = x["gross_return"] - x["turnover"] * float(bps) / 10000.0
        rows.append({"cost_bps": int(bps), **summarize(x)})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--m1-holdings", required=True)
    ap.add_argument("--p10-ranked", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lookback-months", type=int, default=6)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--first-trade-date", default="2022-01-31")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    m1 = build_m1(pd.read_csv(args.m1_holdings))
    p10 = build_p10(pd.read_csv(args.p10_ranked))
    holdings = pd.concat([m1, p10], ignore_index=True)
    stats = candidate_monthly_stats(holdings, args.cost_bps)
    choices = select_regime(
        stats,
        args.lookback_months,
        pd.Timestamp(args.first_trade_date),
    )
    meta = build_meta_path(holdings, choices, args.cost_bps)

    summary = {
        "status": "COMPLETED",
        "engine": "luna-m1-regime6-p10-v1",
        "candidate_pool": ["M1_EXACT", "P10_MOM60_TREND_K5"],
        "p10_formula": P10_FORMULA,
        "lookback_months": args.lookback_months,
        "cost_bps": args.cost_bps,
        "initial_capital_baht": 30000,
        "holdout_rule": "lookback is frozen before holdout; holdout returns are never used in selector tuning",
        "data_contract_warning": "M1 holdings are from the locked 925-universe benchmark while P10 uses the PIT ranked_v2 924-symbol factor dataset. This candidate is research-only until both branches are rebuilt on the same universe/data contract.",
        "summary": summarize(meta, 30000),
        "cost_stress": cost_stress(meta),
    }
    choices.to_csv(out / "regime_selection_ledger.csv", index=False)
    meta.to_csv(out / "regime_portfolio_path.csv", index=False)
    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
