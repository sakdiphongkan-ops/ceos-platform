#!/usr/bin/env python3
"""Build daily technical-timing features for LUNA.

This module is deliberately separate from the canonical M1 factor builder.
It adds only price/volume-derived technical features used by the M1 timing lab.
No forward data is used in feature construction.
"""
from __future__ import annotations

import argparse
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
    au = up.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(ad.ne(0), 100.0)


def true_range(g: pd.DataFrame) -> pd.Series:
    prev = g["close"].shift(1)
    return pd.concat([
        g["high"] - g["low"],
        (g["high"] - prev).abs(),
        (g["low"] - prev).abs(),
    ], axis=1).max(axis=1)


def make_features(p: pd.DataFrame) -> pd.DataFrame:
    p = p.copy()
    p["date"] = pd.to_datetime(p["date"])
    p["symbol"] = p["symbol"].astype(str).str.upper().str.strip()

    for c in ["open", "high", "low", "close", "volume", "amount", "adj_close"]:
        if c in p.columns:
            p[c] = pd.to_numeric(p[c], errors="coerce")

    price = "adj_close" if "adj_close" in p.columns and p["adj_close"].notna().any() else "close"
    if "amount" not in p.columns:
        p["amount"] = p["close"] * p["volume"]

    p = p.sort_values(["symbol", "date"]).drop_duplicates(["symbol", "date"]).reset_index(drop=True)
    g = p.groupby("symbol", group_keys=False)

    ret1 = g[price].pct_change()
    p["MOM_20"] = g[price].pct_change(20)
    p["MOM_60"] = g[price].pct_change(60)
    p["RSI14"] = g[price].apply(rsi).reset_index(level=0, drop=True)

    e12 = g[price].apply(lambda x: ema(x, 12)).reset_index(level=0, drop=True)
    e26 = g[price].apply(lambda x: ema(x, 26)).reset_index(level=0, drop=True)
    p["EMA12"] = e12
    p["EMA20"] = g[price].apply(lambda x: ema(x, 20)).reset_index(level=0, drop=True)
    p["EMA50"] = g[price].apply(lambda x: ema(x, 50)).reset_index(level=0, drop=True)
    p["EMA60"] = g[price].apply(lambda x: ema(x, 60)).reset_index(level=0, drop=True)

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
    p["STOCH_D"] = p.groupby("symbol")["STOCH_K"].transform(lambda x: x.rolling(3, min_periods=3).mean())
    p["STOCH_CROSS_UP"] = (
        (p["STOCH_K"] > p["STOCH_D"]) &
        (p.groupby("symbol")["STOCH_K"].shift(1) <= p.groupby("symbol")["STOCH_D"].shift(1))
    ).astype(int)

    tr = g.apply(true_range).reset_index(level=0, drop=True)
    atr14 = tr.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).mean())
    p["ATR14"] = atr14
    p["ATR_PCT"] = atr14 / p["close"]

    up_move = p.groupby("symbol")["high"].diff()
    down_move = -p.groupby("symbol")["low"].diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0.0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0.0)
    tr14 = tr.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum())
    plus_di = 100 * plus_dm.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum()) / tr14.replace(0, np.nan)
    minus_di = 100 * minus_dm.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum()) / tr14.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    p["PLUS_DI14"] = plus_di
    p["MINUS_DI14"] = minus_di
    p["ADX14"] = dx.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).mean())

    ma20 = g[price].transform(lambda x: x.rolling(20, min_periods=20).mean())
    sd20 = g[price].transform(lambda x: x.rolling(20, min_periods=20).std())
    upper = ma20 + 2 * sd20
    lower = ma20 - 2 * sd20
    p["BB_PCTB20"] = (p[price] - lower) / (upper - lower).replace(0, np.nan)
    p["BB_BANDWIDTH20"] = (upper - lower) / ma20.replace(0, np.nan)

    direction = np.sign(g[price].diff())
    obv_delta = p["volume"].fillna(0) * direction
    p["OBV"] = obv_delta.groupby(p["symbol"]).cumsum()
    p["OBV_EMA20"] = p.groupby("symbol")["OBV"].transform(lambda x: ema(x, 20))
    p["OBV_SLOPE20"] = p.groupby("symbol")["OBV"].diff(20)

    p["DIST_MA20"] = p[price] / ma20 - 1
    p["DIST_MA60"] = p[price] / p["EMA60"] - 1
    p["BREAKOUT20"] = p[price] / g[price].shift(1).transform(lambda x: x.rolling(20, min_periods=20).max()) - 1
    p["BREAKOUT55"] = p[price] / g[price].shift(1).transform(lambda x: x.rolling(55, min_periods=55).max()) - 1

    # Simple, reproducible reversal candles — features, not standalone trading rules.
    body = (p["close"] - p["open"]).abs()
    rng = (p["high"] - p["low"]).replace(0, np.nan)
    upper_wick = p["high"] - p[["open", "close"]].max(axis=1)
    lower_wick = p[["open", "close"]].min(axis=1) - p["low"]
    p["CANDLE_DOJI"] = (body <= 0.10 * rng).astype(int)
    p["CANDLE_HAMMER"] = ((lower_wick >= 2 * body) & (upper_wick <= body) & (body / rng <= 0.40)).astype(int)
    prev_open = g["open"].shift(1)
    prev_close = g["close"].shift(1)
    p["CANDLE_BULL_ENGULF"] = (
        (prev_close < prev_open) &
        (p["close"] > p["open"]) &
        (p["open"] <= prev_close) &
        (p["close"] >= prev_open)
    ).astype(int)

    # Pattern-style location features.
    low20 = g["low"].transform(lambda x: x.rolling(20, min_periods=20).min())
    high20 = g["high"].transform(lambda x: x.rolling(20, min_periods=20).max())
    p["SUPPORT_DISTANCE20"] = p["close"] / low20 - 1
    p["RESISTANCE_DISTANCE20"] = p["close"] / high20 - 1
    p["BULL_REVERSAL_ANY"] = (
        (p["CANDLE_HAMMER"] == 1) |
        (p["CANDLE_BULL_ENGULF"] == 1)
    ).astype(int)

    p["RSI_SLOPE3"] = p.groupby("symbol")["RSI14"].diff(3)
    p["RSI_RECOVERY30"] = (
        (p["RSI14"] > 30) &
        (p.groupby("symbol")["RSI14"].shift(1) <= 30)
    ).astype(int)
    p["TECH_BULL_COUNT"] = (
        (p["RSI_SLOPE3"] > 0).astype(int) +
        (p["MACD_HIST_SLOPE3"] > 0).astype(int) +
        (p["STOCH_K"] > p["STOCH_D"]).astype(int) +
        (p["BB_PCTB20"].diff() > 0).astype(int) +
        p["BULL_REVERSAL_ANY"]
    )

    # Point-in-time forward month return, used only as the evaluation target.
    month = p["date"].dt.to_period("M")
    p["month"] = month.dt.to_timestamp("M")
    month_close = (
        p.sort_values(["symbol", "date"])
         .groupby(["symbol", "month"], as_index=False)
         .tail(1)[["symbol", "month", price]]
         .rename(columns={price: "month_close"})
    )
    month_close["next_month"] = month_close.groupby("symbol")["month"].shift(-1)
    month_close["next_close"] = month_close.groupby("symbol")["month_close"].shift(-1)
    month_close["fwd_month"] = np.where(
        month_close["next_month"].eq(month_close["month"] + pd.offsets.MonthEnd(1)),
        month_close["next_close"] / month_close["month_close"] - 1,
        np.nan,
    )

    # Attach only the month-end technical observation to the monthly evaluation panel.
    p["decision_month"] = p["month"]
    m_end = (
        p.sort_values(["symbol", "date"])
         .groupby(["symbol", "month"], as_index=False)
         .tail(1)
    )
    m_end = m_end.merge(month_close[["symbol", "month", "fwd_month"]], on=["symbol", "month"], how="left")

    keep = [
        "date","symbol","month","adj_close","open","high","low","close","volume","amount",
        "MOM_20","MOM_60","RSI14","RSI_SLOPE3","RSI_RECOVERY30",
        "EMA20","EMA50","EMA60","MACD","MACD_SIGNAL","MACD_HIST","MACD_HIST_SLOPE3","MACD_CROSS_UP",
        "STOCH_K","STOCH_D","STOCH_CROSS_UP","ATR14","ATR_PCT","PLUS_DI14","MINUS_DI14","ADX14",
        "BB_PCTB20","BB_BANDWIDTH20","OBV","OBV_EMA20","OBV_SLOPE20",
        "DIST_MA20","DIST_MA60","BREAKOUT20","BREAKOUT55",
        "CANDLE_DOJI","CANDLE_HAMMER","CANDLE_BULL_ENGULF","BULL_REVERSAL_ANY",
        "SUPPORT_DISTANCE20","RESISTANCE_DISTANCE20","TECH_BULL_COUNT","fwd_month"
    ]
    out = m_end[[c for c in keep if c in m_end.columns]].replace([np.inf,-np.inf], np.nan)
    return out.sort_values(["month","symbol"]).reset_index(drop=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    p = pd.read_csv(args.prices)
    need = {"date","symbol","open","high","low","close","volume"}
    if not need.issubset(p.columns):
        raise SystemExit(f"prices missing {sorted(need-set(p.columns))}")
    out = make_features(p)
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(path, index=False)
    manifest = {
        "feature_version":"luna-technical-timing-v1",
        "rows":int(len(out)),
        "symbols":int(out["symbol"].nunique()),
        "months":int(out["month"].nunique()),
        "start":str(out["month"].min()),
        "end":str(out["month"].max()),
        "forward_return":"next_calendar_month_end_close / current_month_end_close - 1",
        "no_future_features":True,
    }
    path.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
