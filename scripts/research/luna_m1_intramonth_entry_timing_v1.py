#!/usr/bin/env python3
"""LUNA M1 intramonth technical entry-timing tournament v1.

At month-end t:
  1) select M1 Top-K recent losers by 20-day adjusted-close momentum.
  2) during the first N trading days of t+1, wait for a technical confirmation.
  3) signal is observed at close; entry is next trading day's adjusted close.
  4) exit at t+1 month-end adjusted close.
No reallocation: untriggered names remain cash.

Candidate selection is TRAIN+DEV only; OOS/HOLDOUT stay frozen.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0)
    dn = -d.clip(upper=0)
    au = up.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(ad.ne(0), 100.0)


def load(path: str) -> pd.DataFrame:
    p = pd.read_csv(path, parse_dates=["date"])
    need = {"date", "symbol", "open", "high", "low", "close", "volume", "adj_close"}
    missing = sorted(need - set(p.columns))
    if missing:
        raise SystemExit(f"daily input missing columns: {missing}")

    for c in need - {"date", "symbol"}:
        p[c] = pd.to_numeric(p[c], errors="coerce")
    p["symbol"] = p["symbol"].astype(str).str.upper().str.strip()
    p = (
        p.sort_values(["symbol", "date"])
         .drop_duplicates(["symbol", "date"])
         .reset_index(drop=True)
    )

    g = p.groupby("symbol", sort=False)
    adj = p["adj_close"].where(p["adj_close"].notna(), p["close"])

    # M1 selection basis.
    p["MOM_20"] = g["adj_close"].pct_change(20)

    # Daily technical features. These follow common chart definitions and use
    # the same raw OHLC inputs for stochastic/candlestick measures.
    p["RSI14"] = g["adj_close"].apply(rsi).reset_index(level=0, drop=True)
    e12 = g["adj_close"].apply(lambda x: ema(x, 12)).reset_index(level=0, drop=True)
    e26 = g["adj_close"].apply(lambda x: ema(x, 26)).reset_index(level=0, drop=True)
    p["MACD"] = e12 - e26
    p["MACD_SIGNAL"] = p.groupby("symbol")["MACD"].transform(lambda x: ema(x, 9))
    p["MACD_HIST"] = p["MACD"] - p["MACD_SIGNAL"]
    p["MACD_HIST_SLOPE3"] = p.groupby("symbol")["MACD_HIST"].diff(3)
    p["MACD_CROSS_UP"] = (
        (p["MACD"] > p["MACD_SIGNAL"]) &
        (p.groupby("symbol")["MACD"].shift(1) <= p.groupby("symbol")["MACD_SIGNAL"].shift(1))
    ).astype(int)

    low14 = g["low"].transform(lambda x: x.rolling(14, min_periods=14).min())
    high14 = g["high"].transform(lambda x: x.rolling(14, min_periods=14).max())
    p["STOCH_K"] = 100 * (p["close"] - low14) / (high14 - low14).replace(0, np.nan)
    p["STOCH_D"] = p.groupby("symbol")["STOCH_K"].transform(
        lambda x: x.rolling(3, min_periods=3).mean()
    )
    p["STOCH_CROSS_UP"] = (
        (p["STOCH_K"] > p["STOCH_D"]) &
        (p.groupby("symbol")["STOCH_K"].shift(1) <= p.groupby("symbol")["STOCH_D"].shift(1))
    ).astype(int)

    ma20 = g["adj_close"].transform(lambda x: x.rolling(20, min_periods=20).mean())
    sd20 = g["adj_close"].transform(lambda x: x.rolling(20, min_periods=20).std())
    lower = ma20 - 2 * sd20
    upper = ma20 + 2 * sd20
    p["BB_PCTB20"] = (adj - lower) / (upper - lower).replace(0, np.nan)

    direction = np.sign(g["adj_close"].diff())
    obv_delta = p["volume"].fillna(0) * direction
    p["OBV"] = obv_delta.groupby(p["symbol"]).cumsum()
    p["OBV_SLOPE20"] = p.groupby("symbol")["OBV"].diff(20)

    body = (p["close"] - p["open"]).abs()
    rng = (p["high"] - p["low"]).replace(0, np.nan)
    upper_wick = p["high"] - p[["open", "close"]].max(axis=1)
    lower_wick = p[["open", "close"]].min(axis=1) - p["low"]
    p["CANDLE_HAMMER"] = (
        (lower_wick >= 2 * body)
        & (upper_wick <= body)
        & (body / rng <= 0.40)
    ).astype(int)

    prev_open = g["open"].shift(1)
    prev_close = g["close"].shift(1)
    p["CANDLE_BULL_ENGULF"] = (
        (prev_close < prev_open)
        & (p["close"] > p["open"])
        & (p["open"] <= prev_close)
        & (p["close"] >= prev_open)
    ).astype(int)

    p["RSI_SLOPE3"] = p.groupby("symbol")["RSI14"].diff(3)
    p["month"] = p["date"].dt.to_period("M").dt.to_timestamp("M")
    return p.replace([np.inf, -np.inf], np.nan)


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
        "geo_monthly": float(np.expm1(np.mean(np.log1p(x)))),
        "cumulative": float(eq[-1] - 1),
        "positive_month_pct": float(np.mean(x > 0)),
        "worst_month": float(np.min(x)),
        "best_month": float(np.max(x)),
        "max_drawdown_pct": float(np.min(dd)),
    }


def select_m1(df: pd.DataFrame, k: int) -> pd.DataFrame:
    me = (
        df.sort_values(["symbol", "date"])
          .groupby(["symbol", "month"], as_index=False)
          .tail(1)
          .dropna(subset=["MOM_20"])
    )
    parts = []
    for month, g in me.groupby("month", sort=True):
        x = g.sort_values(["MOM_20", "symbol"], ascending=[True, True]).head(k).copy()
        x["m1_rank"] = np.arange(1, len(x) + 1)
        parts.append(x)
    if not parts:
        raise SystemExit("no M1 selections")
    return pd.concat(parts, ignore_index=True)


def build_candidates() -> list[dict]:
    out = [{
        "code": "M1_FIRST_CLOSE", "mode": "BASELINE",
        "days": 1, "threshold": 0,
    }]
    idx = 0
    specs = [
        ("RSI_RECOVERY", [30, 35, 40, 45]),
        ("RSI_CROSS30", [0]),
        ("MACD_CROSS", [0]),
        ("MACD_TURN", [0]),
        ("STOCH_CROSS", [0]),
        ("STOCH_LOW", [0]),
        ("BB_REENTRY", [0]),
        ("OBV_CONFIRM", [0]),
        ("REVERSAL", [0]),
    ]
    for mode, thresholds in specs:
        for threshold, days in itertools.product(thresholds, [3, 5, 10]):
            idx += 1
            out.append({
                "code": f"T{idx:03d}_{mode}_D{days}_{threshold:g}",
                "mode": mode, "days": days, "threshold": threshold,
            })
    idx = 0
    for days, min_sig in itertools.product([3, 5, 10], [2, 3, 4]):
        idx += 1
        out.append({
            "code": f"E{idx:03d}_COMPOSITE_D{days}_N{min_sig}",
            "mode": "COMPOSITE", "days": days, "threshold": min_sig,
        })
    return out


def signal_series(df: pd.DataFrame, mode: str, threshold: float) -> pd.Series:
    g = df.groupby("symbol", sort=False)
    if mode == "RSI_RECOVERY":
        return (df["RSI14"] <= threshold) & (df["RSI_SLOPE3"] > 0)
    if mode == "RSI_CROSS30":
        return (df["RSI14"] > 30) & (g["RSI14"].shift(1) <= 30)
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
        count = (
            (df["RSI_SLOPE3"] > 0).astype(int)
            + (df["MACD_HIST_SLOPE3"] > 0).astype(int)
            + ((df["STOCH_K"] > df["STOCH_D"]) & (df["STOCH_K"] < 50)).astype(int)
            + (df["OBV_SLOPE20"] > 0).astype(int)
            + ((df["CANDLE_HAMMER"] == 1) | (df["CANDLE_BULL_ENGULF"] == 1)).astype(int)
        )
        return count >= int(threshold)
    raise ValueError(mode)


def trade_map(df: pd.DataFrame, selections: pd.DataFrame, candidate: dict, k: int) -> pd.DataFrame:
    g = df.groupby("symbol", sort=False)
    df = df.copy()
    df["signal"] = signal_series(df, candidate["mode"], candidate["threshold"]).fillna(False)

    month_dates = (
        df.sort_values(["symbol", "date"])
          .groupby(["symbol", "month"], sort=False)["date"]
          .apply(list)
          .to_dict()
    )
    prices = df.set_index(["symbol", "date"])["adj_close"].to_dict()

    rows = []
    for s in selections.itertuples(index=False):
        next_month = s.month + pd.offsets.MonthEnd(1)
        dates = month_dates.get((s.symbol, next_month), [])
        if not dates:
            continue

        if candidate["mode"] == "BASELINE":
            entry_date = pd.Timestamp(dates[0])
            exit_date = pd.Timestamp(dates[-1])
        else:
            scan = dates[: min(candidate["days"], max(0, len(dates) - 1))]
            sub = df[(df["symbol"] == s.symbol) & df["date"].isin(scan)].sort_values("date")
            hit = sub[sub["signal"]].head(1)
            if hit.empty:
                rows.append({
                    "month": next_month, "symbol": s.symbol,
                    "entered": False, "stock_return": 0.0,
                    "entry_date": None, "entry_price": None,
                })
                continue
            signal_date = pd.Timestamp(hit.iloc[0]["date"])
            future = [d for d in dates if pd.Timestamp(d) > signal_date]
            if not future:
                rows.append({
                    "month": next_month, "symbol": s.symbol,
                    "entered": False, "stock_return": 0.0,
                    "entry_date": None, "entry_price": None,
                })
                continue
            entry_date = pd.Timestamp(future[0])
            exit_date = pd.Timestamp(dates[-1])

        p0 = prices.get((s.symbol, entry_date))
        p1 = prices.get((s.symbol, exit_date))
        ok = p0 is not None and p1 is not None and np.isfinite(p0) and np.isfinite(p1) and p0 > 0
        rows.append({
            "month": next_month,
            "symbol": s.symbol,
            "entered": bool(ok),
            "stock_return": float(p1 / p0 - 1) if ok else 0.0,
            "entry_date": entry_date,
            "entry_price": float(p0) if ok else None,
            "exit_date": exit_date,
            "exit_price": float(p1) if ok else None,
        })
    return pd.DataFrame(rows)


def monthly(trades: pd.DataFrame, bps: float, k: int) -> pd.DataFrame:
    rows = []
    for month, g in trades.groupby("month", sort=True):
        entered = g[g["entered"]]
        exposure = len(entered) / k
        gross = float(entered["stock_return"].sum() / k)
        turnover = float(exposure)  # round-trip = 1 unit of turnover per entered name
        cost = turnover * bps / 10000.0
        rows.append({
            "month": month,
            "gross_return": gross,
            "turnover": turnover,
            "transaction_cost": cost,
            "net_return": gross - cost,
            "active_names": int(len(entered)),
            "exposure": float(exposure),
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

    rows = []
    trades_by_candidate = {}
    for c in candidates:
        trades = trade_map(df, selections, c, args.k)
        trades_by_candidate[c["code"]] = trades
        for bps in [float(v) for v in args.costs.split(",")]:
            rr = monthly(trades, bps, args.k)
            ser = rr.set_index("month")["net_return"]
            row = {
                "candidate": c["code"], "mode": c["mode"],
                "days": c["days"], "threshold": c["threshold"], "bps": bps,
                "avg_exposure": float(rr["exposure"].mean()) if not rr.empty else 0.0,
                "avg_active_names": float(rr["active_names"].mean()) if not rr.empty else 0.0,
                "average_turnover": float(rr["turnover"].mean()) if not rr.empty else 0.0,
            }
            for label, start, end in [
                ("TRAIN", "2022-10-31", "2023-08-31"),
                ("DEV", "2023-09-30", "2024-08-31"),
                ("OOS", "2024-09-30", "2025-08-31"),
                ("HOLDOUT", "2025-09-30", "2026-08-31"),
            ]:
                p = perf(period(ser, start, end).to_numpy())
                row.update({f"{label}_{k}": v for k, v in p.items()})
            rows.append(row)

    result = pd.DataFrame(rows)
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
    baseline_ref = result[(result["candidate"] == "M1_FIRST_CLOSE") & (result["bps"] == ref)].iloc[0].to_dict()

    summary = {
        "status": "COMPLETED",
        "engine": "luna-m1-intramonth-entry-timing-v1",
        "data_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count": len(candidates),
        "k": args.k,
        "selection_rule": "M1 Top-K recent losers by 20-day adjusted-close momentum at month-end.",
        "entry_rule": "Signal at daily close; enter next trading-day adjusted close; exit at next month-end adjusted close.",
        "periods": {
            "TRAIN": "2022-10-31_to_2023-08-31",
            "DEV": "2023-09-30_to_2024-08-31",
            "OOS": "2024-09-30_to_2025-08-31",
            "HOLDOUT": "2025-09-30_to_2026-08-31",
        },
        "selected_candidate": chosen_ref,
        "timing_baseline": baseline_ref,
        "delta_selected_vs_timing_baseline": {
            "OOS_geo_monthly": float(chosen_ref["OOS_geo_monthly"] - baseline_ref["OOS_geo_monthly"]),
            "HOLDOUT_geo_monthly": float(chosen_ref["HOLDOUT_geo_monthly"] - baseline_ref["HOLDOUT_geo_monthly"]),
            "HOLDOUT_cumulative": float(chosen_ref["HOLDOUT_cumulative"] - baseline_ref["HOLDOUT_cumulative"]),
        },
        "promotion_rule": "No timing rule is promoted unless frozen OOS and HOLDOUT both improve versus the timing baseline and remain positive at 20/40/60 bps.",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    (out / "candidate_catalog.json").write_text(json.dumps(candidates, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
