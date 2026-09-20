#!/usr/bin/env python3
"""LUNA M1 RSI divergence + candlestick confirmation lab v1.

Inspired by SET Investnow's RSI reversal framework:
- Bullish divergence: price weakens while RSI does not make a corresponding lower low.
- Confirmation: wait for a bullish reversal candle (Hammer / Bullish Engulfing).
- Enter only after confirmation at the next trading day's adjusted close.

To avoid look-ahead:
- divergence uses only rolling historical windows ending on the observation day;
- confirmation is observed on that day's close;
- entry is the following trading day's adjusted close;
- M1 Top-K is selected from month-end data before the forward month.

Candidate selection is TRAIN+DEV only; OOS/HOLDOUT are frozen.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0)
    dn = -d.clip(upper=0)
    au = up.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(ad.ne(0), 100.0)


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


def load(path: str) -> pd.DataFrame:
    p = pd.read_csv(path, parse_dates=["date"])
    need = {"date","symbol","open","high","low","close","volume","adj_close"}
    missing = sorted(need - set(p.columns))
    if missing:
        raise SystemExit(f"daily input missing columns: {missing}")
    for c in need - {"date","symbol"}:
        p[c] = pd.to_numeric(p[c], errors="coerce")
    p["symbol"] = p["symbol"].astype(str).str.upper().str.strip()
    p = p.sort_values(["symbol","date"]).drop_duplicates(["symbol","date"]).reset_index(drop=True)
    p["_adj"] = p["adj_close"].where(p["adj_close"].notna(), p["close"])

    g = p.groupby("symbol", sort=False)
    p["MOM20"] = g["_adj"].pct_change(20)
    p["RSI14"] = g["_adj"].apply(rsi).reset_index(level=0, drop=True)

    # Historical rolling lows/highs. No future bars are used.
    p["PRICE_LOW20"] = g["low"].transform(lambda x: x.rolling(20, min_periods=20).min())
    p["RSI_LOW20"] = g["RSI14"].transform(lambda x: x.rolling(20, min_periods=20).min())
    p["PRICE_LOW10"] = g["low"].transform(lambda x: x.rolling(10, min_periods=10).min())
    p["RSI_LOW10"] = g["RSI14"].transform(lambda x: x.rolling(10, min_periods=10).min())

    # A causal bullish-divergence proxy:
    # today's price is at/near the historical window low while RSI remains
    # materially above its own historical low.
    p["DIV20_STRONG"] = (
        (p["low"] <= p["PRICE_LOW20"] * 1.005)
        & (p["RSI14"] >= p["RSI_LOW20"] + 5)
    ).astype(int)
    p["DIV10_STRONG"] = (
        (p["low"] <= p["PRICE_LOW10"] * 1.005)
        & (p["RSI14"] >= p["RSI_LOW10"] + 5)
    ).astype(int)

    body = (p["close"] - p["open"]).abs()
    rng = (p["high"] - p["low"]).replace(0, np.nan)
    upper_wick = p["high"] - p[["open","close"]].max(axis=1)
    lower_wick = p[["open","close"]].min(axis=1) - p["low"]
    p["HAMMER"] = (
        (lower_wick >= 2 * body)
        & (upper_wick <= body)
        & (body / rng <= 0.40)
    ).astype(int)

    prev_open = g["open"].shift(1)
    prev_close = g["close"].shift(1)
    p["BULL_ENGULF"] = (
        (prev_close < prev_open)
        & (p["close"] > p["open"])
        & (p["open"] <= prev_close)
        & (p["close"] >= prev_open)
    ).astype(int)
    p["BULL_REVERSAL"] = ((p["HAMMER"] == 1) | (p["BULL_ENGULF"] == 1)).astype(int)

    p["MACD12"] = g["_adj"].apply(lambda x: x.ewm(span=12, adjust=False, min_periods=12).mean()).reset_index(level=0, drop=True)
    e26 = g["_adj"].apply(lambda x: x.ewm(span=26, adjust=False, min_periods=26).mean()).reset_index(level=0, drop=True)
    p["MACD"] = p["MACD12"] - e26
    p["MACD_SIGNAL"] = p.groupby("symbol")["MACD"].transform(
        lambda x: x.ewm(span=9, adjust=False, min_periods=9).mean()
    )
    p["MACD_HIST_SLOPE3"] = p.groupby("symbol")["MACD"].diff(3) - p.groupby("symbol")["MACD_SIGNAL"].diff(3)

    # ADX(14) as a causal regime-strength proxy for testing mean-reversion
    # in weaker-trend environments.
    up_move = p.groupby("symbol")["high"].diff()
    down_move = -p.groupby("symbol")["low"].diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0.0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0.0)
    prev_close = p.groupby("symbol")["close"].shift(1)
    tr = pd.concat([
        p["high"] - p["low"],
        (p["high"] - prev_close).abs(),
        (p["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    tr14 = tr.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum())
    p["PLUS_DI14"] = 100 * plus_dm.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum()) / tr14.replace(0, np.nan)
    p["MINUS_DI14"] = 100 * minus_dm.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum()) / tr14.replace(0, np.nan)
    dx = 100 * (p["PLUS_DI14"] - p["MINUS_DI14"]).abs() / (p["PLUS_DI14"] + p["MINUS_DI14"]).replace(0, np.nan)
    p["ADX14"] = dx.groupby(p["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).mean())

    p["month"] = p["date"].dt.to_period("M").dt.to_timestamp("M")
    return p.replace([np.inf,-np.inf], np.nan)


def select_m1(df: pd.DataFrame, k: int) -> pd.DataFrame:
    me = (
        df.sort_values(["symbol","date"])
          .groupby(["symbol","month"], as_index=False)
          .tail(1)
          .dropna(subset=["MOM20"])
    )
    parts = []
    for month, g in me.groupby("month", sort=True):
        parts.append(g.sort_values(["MOM20","symbol"], ascending=[True,True]).head(k))
    return pd.concat(parts, ignore_index=True)


def build_candidates() -> list[dict]:
    out = [{"code":"M1_FIRST_CLOSE","mode":"BASELINE","lookback":0,"confirm_days":0}]
    idx = 0
    for div_mode, lookback in [("DIV20",20),("DIV10",10)]:
        for conf, days in [
            ("NONE",0),
            ("HAMMER",5),("HAMMER",10),
            ("REVERSAL",5),("REVERSAL",10),
            ("HAMMER_OR_REV",5),("HAMMER_OR_REV",10),
        ]:
            idx += 1
            out.append({
                "code":f"T{idx:03d}_{div_mode}_{conf}_D{days}",
                "mode":div_mode, "lookback":lookback,
                "confirm":conf, "confirm_days":days, "adx_max":None,
            })
        for adx in [20,25,30]:
            idx += 1
            out.append({
                "code":f"T{idx:03d}_{div_mode}_HAMMER_ADX{adx}_D10",
                "mode":div_mode, "lookback":lookback,
                "confirm":"HAMMER", "confirm_days":10, "adx_max":adx,
            })
    return out


def trade_map(
    df: pd.DataFrame,
    selections: pd.DataFrame,
    candidate: dict,
    k: int,
) -> pd.DataFrame:
    month_dates = (
        df.sort_values(["symbol","date"])
          .groupby(["symbol","month"], sort=False)["date"]
          .apply(list)
          .to_dict()
    )
    px = df.set_index(["symbol","date"])["_adj"].to_dict()

    if candidate["mode"] == "BASELINE":
        sig_col = None
    elif candidate["mode"] == "DIV20":
        sig_col = "DIV20_STRONG"
    else:
        sig_col = "DIV10_STRONG"

    rows = []
    for s in selections.itertuples(index=False):
        nm = s.month + pd.offsets.MonthEnd(1)
        dates = month_dates.get((s.symbol,nm),[])
        if not dates:
            continue

        if candidate["mode"] == "BASELINE":
            entry_date = pd.Timestamp(dates[0])
        else:
            first_window = dates[:candidate["confirm_days"] + 1]
            sub = df[(df["symbol"] == s.symbol) & (df["date"].isin(first_window))].sort_values("date")
            div = sub[sub[sig_col] == 1]
            entry_date = None

            for _, drow in div.iterrows():
                start = pd.Timestamp(drow["date"])
                later = [d for d in dates if pd.Timestamp(d) >= start]
                later = later[:candidate["confirm_days"] + 1] if candidate["confirm_days"] else later[:1]
                if not later:
                    continue
                conf_sub = sub[sub["date"].isin(later)]
                if candidate.get("adx_max") is not None:
                    conf_sub = conf_sub[conf_sub["ADX14"] <= candidate["adx_max"]]

                if candidate["confirm"] == "NONE":
                    hit = conf_sub.head(1)
                elif candidate["confirm"] == "HAMMER":
                    hit = conf_sub[conf_sub["HAMMER"] == 1].head(1)
                elif candidate["confirm"] == "REVERSAL":
                    hit = conf_sub[conf_sub["BULL_ENGULF"] == 1].head(1)
                else:
                    hit = conf_sub[conf_sub["BULL_REVERSAL"] == 1].head(1)
                if not hit.empty:
                    signal_date = pd.Timestamp(hit.iloc[0]["date"])
                    future = [d for d in dates if pd.Timestamp(d) > signal_date]
                    if future:
                        entry_date = pd.Timestamp(future[0])
                        break

            if entry_date is None:
                rows.append({
                    "month":nm,"symbol":s.symbol,"entered":False,
                    "stock_return":0.0,"entry_date":None,
                })
                continue

        exit_date = pd.Timestamp(dates[-1])
        p0, p1 = px.get((s.symbol,entry_date)), px.get((s.symbol,exit_date))
        ok = (
            p0 is not None and p1 is not None
            and np.isfinite(p0) and np.isfinite(p1) and p0 > 0
        )
        rows.append({
            "month":nm,
            "symbol":s.symbol,
            "entered":bool(ok),
            "stock_return":float(p1/p0 - 1) if ok else 0.0,
            "entry_date":entry_date,
            "exit_date":exit_date,
        })
    return pd.DataFrame(rows)


def monthly(trades: pd.DataFrame, bps: float, k: int) -> pd.DataFrame:
    rows = []
    for month, g in trades.groupby("month", sort=True):
        active = g[g["entered"]]
        exposure = len(active) / k
        gross = float(active["stock_return"].sum() / k)
        turnover = float(exposure)
        cost = turnover * bps / 10000.0
        rows.append({
            "month":month,
            "gross_return":gross,
            "net_return":gross-cost,
            "turnover":turnover,
            "transaction_cost":cost,
            "active_names":int(len(active)),
            "exposure":float(exposure),
        })
    return pd.DataFrame(rows)


def period(s: pd.Series,start: str,end: str) -> pd.Series:
    idx = pd.to_datetime(s.index)
    return s[(idx >= pd.Timestamp(start)) & (idx <= pd.Timestamp(end))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--costs", default="20,40,60")
    ap.add_argument("--k", type=int, default=20)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    df = load(args.input)
    sel = select_m1(df,args.k)
    candidates = build_candidates()

    rows = []
    for c in candidates:
        trades = trade_map(df,sel,c,args.k)
        for bps in [float(v) for v in args.costs.split(",")]:
            rr = monthly(trades,bps,args.k)
            ser = rr.set_index("month")["net_return"]
            row = {
                "candidate":c["code"],"bps":bps,
                "avg_exposure":float(rr["exposure"].mean()) if not rr.empty else 0,
                "avg_active_names":float(rr["active_names"].mean()) if not rr.empty else 0,
                "average_turnover":float(rr["turnover"].mean()) if not rr.empty else 0,
            }
            for label,start,end in [
                ("TRAIN","2022-10-31","2023-08-31"),
                ("DEV","2023-09-30","2024-08-31"),
                ("OOS","2024-09-30","2025-08-31"),
                ("HOLDOUT","2025-09-30","2026-08-31"),
            ]:
                row.update({f"{label}_{k}":v for k,v in perf(period(ser,start,end).to_numpy()).items()})
            rows.append(row)

    result = pd.DataFrame(rows)
    result.to_csv(out/"candidate_results.csv",index=False)
    ref = float(args.costs.split(",")[0])
    stress = float(args.costs.split(",")[-1])
    a = result[result.bps == ref].set_index("candidate")
    b = result[result.bps == stress].set_index("candidate")
    nt = a["TRAIN_months"].replace(0,np.nan)
    nd = a["DEV_months"].replace(0,np.nan)
    rank = pd.DataFrame(index=a.index)
    rank["train_dev_geo"] = np.expm1(
        (nt*np.log1p(a["TRAIN_geo_monthly"].clip(lower=-.999999))+
         nd*np.log1p(a["DEV_geo_monthly"].clip(lower=-.999999)))/(nt+nd)
    )
    rank["stress_train_dev_geo"] = np.expm1(
        (nt*np.log1p(b["TRAIN_geo_monthly"].clip(lower=-.999999))+
         nd*np.log1p(b["DEV_geo_monthly"].clip(lower=-.999999)))/(nt+nd)
    )
    rank["min_geo"] = rank[["train_dev_geo","stress_train_dev_geo"]].min(axis=1)
    rank["dev_dd"] = a["DEV_max_drawdown_pct"]
    rank["robust_score"] = rank["min_geo"] - .25*rank["dev_dd"].abs()
    rank["candidate"] = rank.index
    rank = rank.sort_values(["robust_score","train_dev_geo"],ascending=[False,False])
    rank.to_csv(out/"robust_ranking.csv")

    chosen = rank.index[0]
    chosen_ref = result[(result.candidate==chosen)&(result.bps==ref)].iloc[0].to_dict()
    base_ref = result[(result.candidate=="M1_FIRST_CLOSE")&(result.bps==ref)].iloc[0].to_dict()

    summary = {
        "status":"COMPLETED",
        "engine":"luna-m1-rsi-divergence-confirmation-v1",
        "data_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count":len(candidates),
        "k":args.k,
        "source":"SET Investnow RSI reversal article, 19 Dec 2024",
        "framework":"Causal bullish divergence proxy followed by bullish candlestick confirmation; next-day entry.",
        "selected_candidate":chosen_ref,
        "m1_baseline":base_ref,
        "delta_selected_vs_m1":{
            "OOS_geo_monthly":float(chosen_ref["OOS_geo_monthly"]-base_ref["OOS_geo_monthly"]),
            "HOLDOUT_geo_monthly":float(chosen_ref["HOLDOUT_geo_monthly"]-base_ref["HOLDOUT_geo_monthly"]),
            "HOLDOUT_cumulative":float(chosen_ref["HOLDOUT_cumulative"]-base_ref["HOLDOUT_cumulative"]),
        },
        "promotion_rule":"Require improvement in frozen OOS and HOLDOUT plus positive 20/40/60 bps stress before promotion.",
        "regime_hypothesis":"Also tests ADX<=20/25/30 to isolate weaker-trend environments for mean-reversion."
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    (out/"candidate_catalog.json").write_text(json.dumps(candidates,indent=2),encoding="utf-8")


if __name__ == "__main__":
    main()
