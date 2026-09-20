#!/usr/bin/env python3
"""LUNA M1 Intramonth Entry Timing Tournament v1.

Research design:
1) At month-end t, select M1 Top-K recent losers by 20-trading-day momentum.
2) In month t+1, optionally wait for a technical confirmation during the first N
   trading days.
3) Signal is observed at day-close; entry is the NEXT trading day's adjusted close.
4) Exit at next month-end adjusted close.
5) Rejected / no-signal names remain cash; no reallocation.
6) Candidate selection is frozen using TRAIN+DEV only. OOS/HOLDOUT are untouched.

This is deliberately separate from the month-end technical gate experiment.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd


def geo(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if x.size == 0 or np.any(x <= -1):
        return -1.0
    return float(np.expm1(np.mean(np.log1p(x))))


def perf(x: np.ndarray) -> dict:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return {
            "months": 0, "geo_monthly": -1.0, "cumulative": -1.0,
            "positive_month_pct": 0.0, "worst_month": None,
            "best_month": None, "max_drawdown_pct": None,
        }
    eq = np.cumprod(1 + x)
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1
    return {
        "months": int(len(x)),
        "geo_monthly": geo(x),
        "cumulative": float(eq[-1] - 1),
        "positive_month_pct": float(np.mean(x > 0)),
        "worst_month": float(np.min(x)),
        "best_month": float(np.max(x)),
        "max_drawdown_pct": float(np.min(dd)),
    }


def load(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {
        "date", "symbol", "open", "high", "low", "close", "adj_close",
        "volume", "MOM_20", "RSI14", "RSI_SLOPE3",
        "MACD", "MACD_SIGNAL", "MACD_HIST_SLOPE3",
        "MACD_CROSS_UP", "STOCH_K", "STOCH_D", "STOCH_CROSS_UP",
        "BB_PCTB20", "OBV_SLOPE20",
        "CANDLE_HAMMER", "CANDLE_BULL_ENGULF",
    }
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"daily input missing columns: {missing}")
    for c in required - {"date", "symbol"}:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    df = (
        df.sort_values(["symbol", "date"])
          .drop_duplicates(["symbol", "date"])
          .reset_index(drop=True)
    )
    df["month"] = df["date"].dt.to_period("M").dt.to_timestamp("M")
    return df


def make_signal(df: pd.DataFrame, mode: str, threshold: float = 35.0) -> pd.Series:
    g = df.groupby("symbol", sort=False)
    if mode == "RSI_RECOVERY":
        return (df["RSI14"] <= threshold) & (df["RSI_SLOPE3"] > 0)
    if mode == "RSI_CROSS30":
        return (
            (df["RSI14"] > 30)
            & (g["RSI14"].shift(1) <= 30)
        )
    if mode == "MACD_CROSS":
        return df["MACD_CROSS_UP"] >= 1
    if mode == "MACD_TURN":
        return (df["MACD_HIST_SLOPE3"] > 0) & (df["MACD"] < 0)
    if mode == "STOCH_CROSS":
        return (df["STOCH_CROSS_UP"] >= 1) & (df["STOCH_K"] < 60)
    if mode == "STOCH_LOW":
        return (df["STOCH_K"] > df["STOCH_D"]) & (df["STOCH_K"] < 50)
    if mode == "BB_REENTRY":
        prev = g["BB_PCTB20"].shift(1)
        return (df["BB_PCTB20"] > 0) & (prev <= 0)
    if mode == "OBV_CONFIRM":
        return df["OBV_SLOPE20"] > 0
    if mode == "REVERSAL":
        return (df["CANDLE_HAMMER"] == 1) | (df["CANDLE_BULL_ENGULF"] == 1)
    if mode == "COMPOSITE":
        return (
            (df["RSI_SLOPE3"] > 0).astype(int)
            + (df["MACD_HIST_SLOPE3"] > 0).astype(int)
            + ((df["STOCH_K"] > df["STOCH_D"]) & (df["STOCH_K"] < 50)).astype(int)
            + (df["OBV_SLOPE20"] > 0).astype(int)
            + ((df["CANDLE_HAMMER"] == 1) | (df["CANDLE_BULL_ENGULF"] == 1)).astype(int)
        ) >= int(threshold)
    raise ValueError(f"unknown signal mode: {mode}")


def build_candidates() -> list[dict]:
    out = [{"code": "M1_FIRST_CLOSE", "mode": "BASELINE", "days": 1, "threshold": 0, "min_signals": 0}]
    idx = 0
    specs = [
        ("RSI_RECOVERY", [30, 35, 40, 45], [3, 5, 10]),
        ("RSI_CROSS30", [0], [3, 5, 10]),
        ("MACD_CROSS", [0], [3, 5, 10]),
        ("MACD_TURN", [0], [3, 5, 10]),
        ("STOCH_CROSS", [0], [3, 5, 10]),
        ("STOCH_LOW", [0], [3, 5, 10]),
        ("BB_REENTRY", [0], [3, 5, 10]),
        ("OBV_CONFIRM", [0], [3, 5, 10]),
        ("REVERSAL", [0], [3, 5, 10]),
    ]
    for mode, thresholds, days in specs:
        for threshold, window in itertools.product(thresholds, days):
            idx += 1
            out.append({
                "code": f"T{idx:03d}_{mode}_{window}_{threshold:g}",
                "mode": mode, "days": window,
                "threshold": threshold, "min_signals": 1,
            })
    idx = 0
    for window, min_sig in itertools.product([3, 5, 10], [2, 3, 4]):
        idx += 1
        out.append({
            "code": f"E{idx:03d}_COMPOSITE_{window}_N{min_sig}",
            "mode": "COMPOSITE", "days": window,
            "threshold": min_sig, "min_signals": min_sig,
        })
    return out


def month_end_dates(df: pd.DataFrame) -> pd.Series:
    return (
        df.sort_values(["symbol", "date"])
          .groupby(["symbol", "month"], as_index=False)
          .tail(1)[["symbol", "month", "date", "adj_close"]]
    )


def select_m1(df: pd.DataFrame, k: int) -> pd.DataFrame:
    me = month_end_dates(df).copy()
    me = me.dropna(subset=["MOM_20"]).copy()
    pieces = []
    for month, g in me.groupby("month", sort=True):
        x = g.sort_values(["MOM_20", "symbol"], ascending=[True, True]).head(k).copy()
        x["m1_rank"] = np.arange(1, len(x) + 1)
        pieces.append(x)
    if not pieces:
        raise SystemExit("no M1 month-end selections")
    return pd.concat(pieces, ignore_index=True)


def entry_map_for_candidate(
    df: pd.DataFrame,
    selections: pd.DataFrame,
    mode: str,
    threshold: float,
    days: int,
    k: int,
) -> pd.DataFrame:
    x = df.copy()
    x["signal"] = make_signal(x, mode, threshold).fillna(False)
    month_days = (
        x.sort_values(["symbol", "date"])
         .groupby(["symbol", "month"], sort=False)["date"]
         .apply(list)
         .to_dict()
    )
    price_lookup = x.set_index(["symbol", "date"])["adj_close"].to_dict()

    rows = []
    for _, s in selections.iterrows():
        cur_month = s["month"]
        next_month = (cur_month + pd.offsets.MonthEnd(1))
        sym = s["symbol"]
        dates = month_days.get((sym, next_month), [])
        if len(dates) < 2:
            rows.append({
                "month": next_month, "symbol": sym,
                "entered": False, "entry_date": None,
                "entry_price": None, "exit_price": None, "stock_return": 0.0,
            })
            continue
        scan_dates = dates[: min(days, len(dates) - 1)]
        sub = x[(x["symbol"] == sym) & x["date"].isin(scan_dates)].sort_values("date")
        hit = sub[sub["signal"]].head(1)
        if hit.empty:
            rows.append({
                "month": next_month, "symbol": sym,
                "entered": False, "entry_date": None,
                "entry_price": None, "exit_price": None, "stock_return": 0.0,
            })
            continue
        signal_date = pd.Timestamp(hit.iloc[0]["date"])
        future_dates = [d for d in dates if pd.Timestamp(d) > signal_date]
        if not future_dates:
            rows.append({
                "month": next_month, "symbol": sym,
                "entered": False, "entry_date": None,
                "entry_price": None, "exit_price": None, "stock_return": 0.0,
            })
            continue
        entry_date = pd.Timestamp(future_dates[0])
        exit_date = pd.Timestamp(dates[-1])
        entry_price = price_lookup.get((sym, entry_date))
        exit_price = price_lookup.get((sym, exit_date))
        if pd.isna(entry_price) or pd.isna(exit_price) or entry_price <= 0:
            entered = False
            stock_return = 0.0
        else:
            entered = True
            stock_return = float(exit_price / entry_price - 1.0)
        rows.append({
            "month": next_month, "symbol": sym,
            "entered": entered, "entry_date": entry_date,
            "entry_price": entry_price, "exit_price": exit_price,
            "stock_return": stock_return,
        })
    return pd.DataFrame(rows)


def baseline_map(df: pd.DataFrame, selections: pd.DataFrame) -> pd.DataFrame:
    me = month_end_dates(df)
    month_groups = {
        (r.symbol, r.month): r for r in me.itertuples(index=False)
    }
    rows = []
    for _, s in selections.iterrows():
        next_month = s["month"] + pd.offsets.MonthEnd(1)
        sym = s["symbol"]
        key_rows = df[(df["symbol"] == sym) & (df["month"] == next_month)].sort_values("date")
        if key_rows.empty:
            rows.append({"month": next_month, "symbol": sym, "entered": False, "stock_return": 0.0})
            continue
        first = key_rows.iloc[0]
        last = key_rows.iloc[-1]
        p0, p1 = first["adj_close"], last["adj_close"]
        ok = pd.notna(p0) and pd.notna(p1) and p0 > 0
        rows.append({
            "month": next_month, "symbol": sym,
            "entered": bool(ok), "stock_return": float(p1 / p0 - 1) if ok else 0.0,
            "entry_date": first["date"], "entry_price": p0,
            "exit_date": last["date"], "exit_price": p1,
        })
    return pd.DataFrame(rows)


def monthly_returns(trades: pd.DataFrame, cost_bps: float, k: int) -> pd.DataFrame:
    rows = []
    for month, g in trades.groupby("month", sort=True):
        entered = g[g["entered"]].copy()
        gross = float(entered["stock_return"].sum() / k)
        # Round-trip = one unit of one-way turnover for each entered name.
        turnover = float(len(entered) / k)
        cost = turnover * cost_bps / 10000.0
        rows.append({
            "month": month,
            "gross_return": gross,
            "turnover": turnover,
            "transaction_cost": cost,
            "net_return": gross - cost,
            "active_names": int(len(entered)),
            "exposure": float(len(entered) / k),
            "avg_entry_delay_days": None if entered.empty else float(
                np.mean([
                    max(0, (pd.Timestamp(r.entry_date) - pd.Timestamp(g.month.iloc[0])).days)
                    for r in entered.itertuples()
                ])
            ),
        })
    return pd.DataFrame(rows)


def period(s: pd.Series, start: str, end: str) -> pd.Series:
    idx = pd.to_datetime(s.index)
    return s[(idx >= pd.Timestamp(start)) & (idx <= pd.Timestamp(end))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--costs", default="20,40,60")
    ap.add_argument("--k", type=int, default=20)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    df = load(args.input)
    selections = select_m1(df, args.k)
    candidates = build_candidates()

    result_rows = []
    selected_trades = {}

    for c in candidates:
        if c["mode"] == "BASELINE":
            trades = baseline_map(df, selections)
        else:
            trades = entry_map_for_candidate(
                df, selections, c["mode"], c["threshold"], c["days"], args.k
            )
        selected_trades[c["code"]] = trades
        for bps in [float(v) for v in args.costs.split(",")]:
            rr = monthly_returns(trades, bps, args.k)
            ser = rr.set_index("month")["net_return"]
            row = {
                "candidate": c["code"], "mode": c["mode"],
                "days": c["days"], "threshold": c["threshold"], "bps": bps,
                "avg_exposure": float(rr["exposure"].mean()),
                "avg_active_names": float(rr["active_names"].mean()),
                "average_turnover": float(rr["turnover"].mean()),
            }
            for label, start, end in [
                ("TRAIN", "2022-10-31", "2023-08-31"),
                ("DEV", "2023-09-30", "2024-08-31"),
                ("OOS", "2024-09-30", "2025-08-31"),
                ("HOLDOUT", "2025-09-30", "2026-08-31"),
            ]:
                p = perf(period(ser, start, end).to_numpy())
                row.update({f"{label}_{k}": v for k, v in p.items()})
            result_rows.append(row)

    result = pd.DataFrame(result_rows)
    result.to_csv(out / "candidate_results.csv", index=False)

    ref = float(args.costs.split(",")[0])
    stress = float(args.costs.split(",")[-1])
    refdf = result[result["bps"] == ref].set_index("candidate")
    stressdf = result[result["bps"] == stress].set_index("candidate")
    n_train = refdf["TRAIN_months"].replace(0, np.nan)
    n_dev = refdf["DEV_months"].replace(0, np.nan)
    ranking = pd.DataFrame(index=refdf.index)
    ranking["train_dev_geo"] = np.expm1(
        (
            n_train * np.log1p(refdf["TRAIN_geo_monthly"].clip(lower=-0.999999))
            + n_dev * np.log1p(refdf["DEV_geo_monthly"].clip(lower=-0.999999))
        ) / (n_train + n_dev)
    )
    ranking["stress_train_dev_geo"] = np.expm1(
        (
            n_train * np.log1p(stressdf["TRAIN_geo_monthly"].clip(lower=-0.999999))
            + n_dev * np.log1p(stressdf["DEV_geo_monthly"].clip(lower=-0.999999))
        ) / (n_train + n_dev)
    )
    ranking["min_geo"] = ranking[["train_dev_geo", "stress_train_dev_geo"]].min(axis=1)
    ranking["dev_drawdown"] = refdf["DEV_max_drawdown_pct"]
    ranking["robust_score"] = ranking["min_geo"] - 0.25 * ranking["dev_drawdown"].abs()
    ranking["candidate"] = ranking.index
    ranking = ranking.sort_values(["robust_score", "train_dev_geo"], ascending=[False, False])
    ranking.to_csv(out / "robust_ranking.csv")

    chosen = str(ranking.index[0])
    chosen_ref = result[(result["candidate"] == chosen) & (result["bps"] == ref)].iloc[0].to_dict()
    m1_ref = result[(result["candidate"] == "M1_FIRST_CLOSE") & (result["bps"] == ref)].iloc[0].to_dict()

    summary = {
        "status": "COMPLETED",
        "engine": "luna-m1-intramonth-entry-timing-v1",
        "data_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count": len(candidates),
        "k": args.k,
        "selection_rule": "M1 Top-K by month-end 20-day momentum; technical timing only affects next-month entry timing; no reallocation.",
        "entry_rule": "Signal at daily close; enter next trading-day adjusted close; exit at next month-end adjusted close.",
        "periods": {
            "TRAIN": "2022-10-31_to_2023-08-31",
            "DEV": "2023-09-30_to_2024-08-31",
            "OOS": "2024-09-30_to_2025-08-31",
            "HOLDOUT": "2025-09-30_to_2026-08-31",
        },
        "selected_candidate": chosen_ref,
        "m1_baseline": m1_ref,
        "delta_selected_vs_m1": {
            "OOS_geo_monthly": float(chosen_ref["OOS_geo_monthly"] - m1_ref["OOS_geo_monthly"]),
            "HOLDOUT_geo_monthly": float(chosen_ref["HOLDOUT_geo_monthly"] - m1_ref["HOLDOUT_geo_monthly"]),
            "HOLDOUT_cumulative": float(chosen_ref["HOLDOUT_cumulative"] - m1_ref["HOLDOUT_cumulative"]),
        },
        "promotion_rule": "No timing rule is promoted unless frozen OOS and HOLDOUT both improve versus the timing baseline and remain positive under cost stress.",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    (out / "candidate_catalog.json").write_text(json.dumps(candidates, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
