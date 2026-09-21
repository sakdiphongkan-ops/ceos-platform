#!/usr/bin/env python3
"""LUNA M1 RSI Pivot-Divergence Timing Lab v2.

Fixes the main weakness of v1:
- v1 used a rolling-low proxy that could repeatedly fire without a true
  lower-low / higher-RSI-low pair.
- v2 detects two confirmed price pivot lows.
- The second pivot must make a lower low while RSI at that pivot makes a
  higher low by a configurable RSI gap.
- A pivot is only actionable after the right-side confirmation bars have
  elapsed; entry is the next trading day after optional confirmation.
- M1 selection and month-end exit are unchanged.
- Candidate selection uses TRAIN+DEV only; OOS/HOLDOUT stay frozen.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd

TRAIN = ("2022-10-31", "2023-08-31")
DEV = ("2023-09-30", "2024-08-31")
OOS = ("2024-09-30", "2025-08-31")
HOLDOUT = ("2025-09-30", "2026-08-31")


def rsi(s: pd.Series, n: int) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0.0)
    dn = -d.clip(upper=0.0)
    au = up.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0.0, np.nan)
    out = 100.0 - 100.0 / (1.0 + rs)
    return out.where(ad.ne(0.0), 100.0)


def perf(x: np.ndarray) -> dict:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return {
            "months": 0,
            "geo_monthly": -1.0,
            "cumulative": -1.0,
            "positive_month_pct": 0.0,
            "worst_month": None,
            "best_month": None,
            "max_drawdown_pct": None,
        }
    eq = np.cumprod(1.0 + x)
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1.0
    return {
        "months": int(len(x)),
        "geo_monthly": float(np.expm1(np.mean(np.log1p(x)))),
        "cumulative": float(eq[-1] - 1.0),
        "positive_month_pct": float(np.mean(x > 0)),
        "worst_month": float(np.min(x)),
        "best_month": float(np.max(x)),
        "max_drawdown_pct": float(np.min(dd)),
    }


def period(s: pd.Series, start: str, end: str) -> pd.Series:
    idx = pd.to_datetime(s.index)
    return s[(idx >= pd.Timestamp(start)) & (idx <= pd.Timestamp(end))]


def load(path: str, rsi_periods: list[int]) -> pd.DataFrame:
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
    p["_px"] = p["adj_close"].where(p["adj_close"].notna(), p["close"])
    g = p.groupby("symbol", sort=False)
    p["MOM20"] = g["_px"].pct_change(20)

    for n in rsi_periods:
        p[f"RSI{n}"] = (
            g["_px"].apply(lambda x: rsi(x, n))
            .reset_index(level=0, drop=True)
        )

    # Causal candle confirmations.
    body = (p["close"] - p["open"]).abs()
    rng = (p["high"] - p["low"]).replace(0.0, np.nan)
    upper = p["high"] - p[["open", "close"]].max(axis=1)
    lower = p[["open", "close"]].min(axis=1) - p["low"]
    p["HAMMER"] = (
        (lower >= 2.0 * body)
        & (upper <= body)
        & ((body / rng) <= 0.40)
    ).astype(int)

    prev_open = g["open"].shift(1)
    prev_close = g["close"].shift(1)
    p["BULL_ENGULF"] = (
        (prev_close < prev_open)
        & (p["close"] > p["open"])
        & (p["open"] <= prev_close)
        & (p["close"] >= prev_open)
    ).astype(int)
    p["REVERSAL"] = ((p["HAMMER"] == 1) | (p["BULL_ENGULF"] == 1)).astype(int)

    # MACD histogram slope as an optional post-divergence confirmation.
    ema12 = g["_px"].transform(lambda x: x.ewm(span=12, adjust=False, min_periods=12).mean())
    ema26 = g["_px"].transform(lambda x: x.ewm(span=26, adjust=False, min_periods=26).mean())
    p["MACD"] = ema12 - ema26
    p["MACD_SIGNAL"] = p.groupby("symbol")["MACD"].transform(
        lambda x: x.ewm(span=9, adjust=False, min_periods=9).mean()
    )
    p["MACD_HIST"] = p["MACD"] - p["MACD_SIGNAL"]
    p["MACD_HIST_SLOPE3"] = p.groupby("symbol")["MACD_HIST"].diff(3)

    # ADX(14), calculated only from data through each observation.
    up_move = g["high"].diff()
    down_move = -g["low"].diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0.0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0.0)
    prev_c = g["close"].shift(1)
    tr = pd.concat(
        [
            p["high"] - p["low"],
            (p["high"] - prev_c).abs(),
            (p["low"] - prev_c).abs(),
        ],
        axis=1,
    ).max(axis=1)
    tr14 = tr.groupby(p["symbol"]).transform(
        lambda x: x.rolling(14, min_periods=14).sum()
    )
    plus14 = plus_dm.groupby(p["symbol"]).transform(
        lambda x: x.rolling(14, min_periods=14).sum()
    )
    minus14 = minus_dm.groupby(p["symbol"]).transform(
        lambda x: x.rolling(14, min_periods=14).sum()
    )
    plus_di = 100.0 * plus14 / tr14.replace(0.0, np.nan)
    minus_di = 100.0 * minus14 / tr14.replace(0.0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0.0, np.nan)
    p["ADX14"] = dx.groupby(p["symbol"]).transform(
        lambda x: x.rolling(14, min_periods=14).mean()
    )

    p["month"] = p["date"].dt.to_period("M").dt.to_timestamp("M")
    return p.replace([np.inf, -np.inf], np.nan)


def select_m1(df: pd.DataFrame, k: int) -> pd.DataFrame:
    me = (
        df.sort_values(["symbol", "date"])
        .groupby(["symbol", "month"], as_index=False)
        .tail(1)
        .dropna(subset=["MOM20"])
    )
    parts = []
    for month, g in me.groupby("month", sort=True):
        x = g.sort_values(["MOM20", "symbol"], ascending=[True, True]).head(k).copy()
        x["rank"] = np.arange(1, len(x) + 1)
        parts.append(x[["month", "symbol", "rank"]])
    if not parts:
        raise SystemExit("no M1 selections")
    return pd.concat(parts, ignore_index=True)


def build_pivots(df: pd.DataFrame, n: int, left: int, right: int) -> dict[str, pd.DataFrame]:
    """Return confirmed price pivot lows keyed by symbol.

    Pivot at i is known only at i+right. The returned frame therefore includes
    pivot_date and confirmed_date separately, preserving causality.
    """
    rows = []
    win = left + right + 1
    for symbol, w in df.groupby("symbol", sort=False):
        w = w.sort_values("date").reset_index(drop=True)
        low = w["low"].to_numpy(dtype=float)
        rr = w[f"RSI{n}"].to_numpy(dtype=float)
        if len(w) < win:
            continue
        s_low = pd.Series(low)
        mn = s_low.rolling(win, center=True, min_periods=win).min().to_numpy()
        cnt = s_low.rolling(win, center=True, min_periods=win).apply(
            lambda x: np.sum(np.isclose(x, np.nanmin(x), rtol=0.0, atol=1e-12)),
            raw=True,
        ).to_numpy()
        mask = (
            np.isfinite(low)
            & np.isfinite(rr)
            & np.isfinite(mn)
            & (low == mn)
            & (cnt == 1)
        )
        idx = np.flatnonzero(mask)
        for i in idx:
            c = int(i + right)
            if c >= len(w):
                continue
            rows.append(
                {
                    "symbol": symbol,
                    "pivot_i": int(i),
                    "pivot_date": w.iloc[i]["date"],
                    "confirmed_i": c,
                    "confirmed_date": w.iloc[c]["date"],
                    "pivot_low": float(low[i]),
                    "pivot_rsi": float(rr[i]),
                    "pivot_high": float(w.iloc[i]["high"]),
                }
            )
    if not rows:
        return {}
    return {
        key: g.reset_index(drop=True)
        for key, g in pd.DataFrame(rows).groupby("symbol", sort=False)
    }


def find_divergence_signal(
    pivots: pd.DataFrame,
    month_days: pd.Series,
    c: dict,
) -> pd.Timestamp | None:
    if pivots.empty:
        return None
    piv = pivots.sort_values("pivot_i").reset_index(drop=True)
    max_gap = int(c["max_gap"])
    price_tol = float(c["price_tol"])
    rsi_gap = float(c["rsi_gap"])
    start = pd.Timestamp(month_days.iloc[0])
    end = pd.Timestamp(month_days.iloc[-1])

    # Search earliest second pivot whose confirmation and optional confirmation
    # sequence occur inside the forward month.
    for j in range(1, len(piv)):
        p2 = piv.iloc[j]
        conf2 = pd.Timestamp(p2["confirmed_date"])
        if conf2 < start or conf2 > end:
            continue
        prior = piv[piv["pivot_i"] < p2["pivot_i"]]
        prior = prior[
            (p2["pivot_i"] - prior["pivot_i"] <= max_gap)
            & (prior["pivot_low"] > 0)
            & np.isfinite(prior["pivot_rsi"])
        ]
        if prior.empty:
            continue
        p1 = prior.iloc[-1]
        # Optional strictness: price2 must be a lower low by at least price_tol
        # and RSI2 a higher low by at least rsi_gap.
        if not (p2["pivot_low"] <= p1["pivot_low"] * (1.0 - price_tol)):
            continue
        if not (p2["pivot_rsi"] >= p1["pivot_rsi"] + rsi_gap):
            continue

        days = [pd.Timestamp(x) for x in month_days]
        confirm_window = int(c["confirm_days"])
        try:
            base_idx = days.index(conf2)
        except ValueError:
            continue
        for off in range(0, confirm_window + 1):
            ii = base_idx + off
            if ii >= len(days):
                break
            return_day = days[ii]
            return return_day
    return None


def confirmation_date(
    w: pd.DataFrame,
    signal_day: pd.Timestamp,
    c: dict,
) -> pd.Timestamp | None:
    days = list(pd.to_datetime(w["date"]))
    if signal_day not in days:
        return None
    i = days.index(signal_day)
    limit = min(len(days) - 1, i + int(c["confirm_days"]))
    sub = w.iloc[i : limit + 1].copy()
    if c.get("adx_max") is not None:
        sub = sub[sub["ADX14"] <= float(c["adx_max"])]
    mode = c["confirm"]

    if mode == "NONE":
        hit = sub.head(1)
    elif mode == "HAMMER":
        hit = sub[sub["HAMMER"] == 1]
    elif mode == "BULL_ENGULF":
        hit = sub[sub["BULL_ENGULF"] == 1]
    elif mode == "REVERSAL":
        hit = sub[sub["REVERSAL"] == 1]
    elif mode == "RSI_RECLAIM":
        rcol = f"RSI{c['rsi_period']}"
        rp = sub[rcol].shift(1)
        hit = sub[(sub[rcol] > c["rsi_reclaim"]) & (rp <= c["rsi_reclaim"])]
    elif mode == "MACD_HIST_UP":
        hit = sub[sub["MACD_HIST_SLOPE3"] > 0]
    else:
        raise ValueError(f"unknown confirmation mode: {mode}")
    if hit.empty:
        return None
    return pd.Timestamp(hit.iloc[0]["date"])


def baseline_monthly(
    df: pd.DataFrame, sel: pd.DataFrame, bps: float, k: int
) -> pd.DataFrame:
    groups = {
        key: g.sort_values("date").reset_index(drop=True)
        for key, g in df.groupby(["symbol", "month"], sort=False)
    }
    rows = []
    for s in sel.itertuples(index=False):
        nm = pd.Timestamp(s.month) + pd.offsets.MonthEnd(1)
        w = groups.get((s.symbol, nm))
        if w is None or w.empty:
            continue
        p0 = float(w.iloc[0]["_px"])
        p1 = float(w.iloc[-1]["_px"])
        gross = p1 / p0 - 1.0 if p0 > 0 and np.isfinite(p0) and np.isfinite(p1) else 0.0
        rows.append({"month": nm, "gross": gross, "entered": 1})
    rr = pd.DataFrame(rows)
    if rr.empty:
        return pd.DataFrame(columns=["month", "net_return", "gross_return", "cost", "exposure"])
    m = rr.groupby("month").agg(gross_return=("gross", "mean"), entered=("entered", "sum"))
    m["exposure"] = m["entered"] / float(k)
    # bps is explicitly treated as round-trip cost per entered slot.
    m["cost"] = m["exposure"] * float(bps) / 10000.0
    m["net_return"] = m["gross_return"] - m["cost"]
    return m.reset_index()


def candidate_monthly(
    df: pd.DataFrame,
    sel: pd.DataFrame,
    pivots_by_n: dict[tuple[int, int, int], dict[str, pd.DataFrame]],
    c: dict,
    bps: float,
    k: int,
) -> pd.DataFrame:
    groups = {
        key: g.sort_values("date").reset_index(drop=True)
        for key, g in df.groupby(["symbol", "month"], sort=False)
    }
    rows = []
    pivot_key = (int(c["rsi_period"]), int(c["left"]), int(c["right"]))
    pivots = pivots_by_n.get(pivot_key, {})

    for s in sel.itertuples(index=False):
        nm = pd.Timestamp(s.month) + pd.offsets.MonthEnd(1)
        w = groups.get((s.symbol, nm))
        if w is None or w.empty:
            continue
        pv = pivots.get(s.symbol)
        if pv is None:
            rows.append({"month": nm, "gross": 0.0, "entered": 0})
            continue
        div_day = find_divergence_signal(pv, w["date"], c)
        if div_day is None:
            rows.append({"month": nm, "gross": 0.0, "entered": 0})
            continue
        conf_day = confirmation_date(w, div_day, c)
        if conf_day is None:
            rows.append({"month": nm, "gross": 0.0, "entered": 0})
            continue
        days = list(pd.to_datetime(w["date"]))
        ci = days.index(conf_day)
        if ci + 1 >= len(days):
            rows.append({"month": nm, "gross": 0.0, "entered": 0})
            continue
        entry_i = ci + 1
        p0 = float(w.iloc[entry_i]["_px"])
        p1 = float(w.iloc[-1]["_px"])
        if p0 <= 0 or not np.isfinite(p0) or not np.isfinite(p1):
            rows.append({"month": nm, "gross": 0.0, "entered": 0})
            continue
        rows.append(
            {
                "month": nm,
                "gross": p1 / p0 - 1.0,
                "entered": 1,
            }
        )

    rr = pd.DataFrame(rows)
    if rr.empty:
        return pd.DataFrame(columns=["month", "net_return", "gross_return", "cost", "exposure"])
    m = rr.groupby("month").agg(gross_return=("gross", "mean"), entered=("entered", "sum"))
    m["exposure"] = m["entered"] / float(k)
    m["cost"] = m["exposure"] * float(bps) / 10000.0
    m["net_return"] = m["gross_return"] - m["cost"]
    return m.reset_index()


def evaluate(
    rr: pd.DataFrame,
    candidate: dict,
    bps: float,
) -> dict:
    if rr.empty:
        ser = pd.Series(dtype=float)
    else:
        ser = rr.set_index("month")["net_return"]
    row = {"candidate": candidate["code"], "bps": float(bps), **candidate}
    for label, bounds in {
        "TRAIN": TRAIN,
        "DEV": DEV,
        "OOS": OOS,
        "HOLDOUT": HOLDOUT,
    }.items():
        row.update({f"{label}_{k}": v for k, v in perf(period(ser, *bounds).to_numpy()).items()})
    row["avg_exposure"] = float(rr["exposure"].mean()) if not rr.empty else 0.0
    row["avg_active"] = float(rr["entered"].mean()) if not rr.empty else 0.0
    return row


def robust_rank(df: pd.DataFrame, ref_bps: float, stress_bps: float) -> pd.DataFrame:
    a = df[np.isclose(df["bps"], ref_bps)].set_index("candidate")
    b = df[np.isclose(df["bps"], stress_bps)].set_index("candidate")
    n1 = a["TRAIN_months"].replace(0, np.nan)
    n2 = a["DEV_months"].replace(0, np.nan)
    out = pd.DataFrame(index=a.index)
    out["train_dev_geo"] = np.expm1(
        (
            n1 * np.log1p(a["TRAIN_geo_monthly"].clip(-0.999999, None))
            + n2 * np.log1p(a["DEV_geo_monthly"].clip(-0.999999, None))
        ) / (n1 + n2)
    )
    out["stress_train_dev_geo"] = np.expm1(
        (
            n1 * np.log1p(b["TRAIN_geo_monthly"].clip(-0.999999, None))
            + n2 * np.log1p(b["DEV_geo_monthly"].clip(-0.999999, None))
        ) / (n1 + n2)
    )
    out["min_geo"] = out[["train_dev_geo", "stress_train_dev_geo"]].min(axis=1)
    out["dev_dd_penalty"] = a["DEV_max_drawdown_pct"].abs().fillna(1.0)
    # Penalize drawdown but keep the score dominated by return.
    out["robust_score"] = out["min_geo"] - 0.20 * out["dev_dd_penalty"]
    out["candidate"] = out.index
    return out.sort_values(["robust_score", "train_dev_geo"], ascending=[False, False])


def stage1() -> list[dict]:
    out = []
    idx = 0
    for rsi_n, left, right, max_gap, price_tol, rsi_gap in itertools.product(
        [5, 7, 9, 14],
        [2, 3],
        [2, 3],
        [15, 25, 35],
        [0.0, 0.01, 0.03],
        [2.0, 4.0, 6.0],
    ):
        idx += 1
        out.append(
            {
                "code": f"S1_{idx:04d}",
                "rsi_period": rsi_n,
                "left": left,
                "right": right,
                "max_gap": max_gap,
                "price_tol": price_tol,
                "rsi_gap": rsi_gap,
                "confirm": "NONE",
                "confirm_days": 0,
                "adx_max": None,
            }
        )
    return out


def stage2_expand(top: list[dict]) -> list[dict]:
    out = []
    idx = 0
    for base in top:
        for confirm, days in itertools.product(
            ["NONE", "HAMMER", "BULL_ENGULF", "REVERSAL", "RSI_RECLAIM", "MACD_HIST_UP"],
            [0, 3, 5],
        ):
            if confirm == "NONE" and days != 0:
                continue
            for adx in [None, 20, 25, 30]:
                idx += 1
                out.append(
                    {
                        **base,
                        "code": f"S2_{idx:04d}_{base['code']}_{confirm}_D{days}_A{adx if adx is not None else 'NA'}",
                        "confirm": confirm,
                        "confirm_days": days,
                        "adx_max": adx,
                        "rsi_reclaim": 30,
                    }
                )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--costs", default="20,40,60")
    ap.add_argument("--top-stage1", type=int, default=16)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    s1 = stage1()
    rsi_periods = sorted({c["rsi_period"] for c in s1})
    df = load(args.input, rsi_periods)
    sel = select_m1(df, args.k)

    # Precompute pivots for every Stage-1 combination used later.
    pivot_keys = sorted({(c["rsi_period"], c["left"], c["right"]) for c in s1})
    pivots_by_n = {
        key: build_pivots(df, *key)
        for key in pivot_keys
    }

    costs = [float(v) for v in args.costs.split(",")]
    all_rows = []
    for c in s1:
        for bps in costs:
            rr = candidate_monthly(df, sel, pivots_by_n, c, bps, args.k)
            all_rows.append(evaluate(rr, c, bps))
    stage1_df = pd.DataFrame(all_rows)

    rank1 = robust_rank(stage1_df, min(costs), max(costs))
    rank1.to_csv(out / "stage1_ranking.csv", index=False)
    top_codes = list(rank1.head(args.top_stage1).index)
    top = [c for c in s1 if c["code"] in top_codes]

    s2 = stage2_expand(top)
    stage2_rows = []
    for c in s2:
        # Stage-2 changes only timing confirmation/regime filtering; pivot definition
        # remains frozen from the top TRAIN+DEV candidates.
        key = (int(c["rsi_period"]), int(c["left"]), int(c["right"]))
        for bps in costs:
            rr = candidate_monthly(df, sel, pivots_by_n, c, bps, args.k)
            stage2_rows.append(evaluate(rr, c, bps))
    stage2_df = pd.DataFrame(stage2_rows)
    rank2 = robust_rank(stage2_df, min(costs), max(costs))
    rank2.to_csv(out / "stage2_ranking.csv", index=False)

    # Baselines at identical cost assumptions.
    base_rows = []
    for bps in costs:
        rr = baseline_monthly(df, sel, bps, args.k)
        base_rows.append(
            {
                "candidate": "M1_FIRST_CLOSE",
                "bps": bps,
                **{
                    f"{label}_{k}": v
                    for label, bounds in {
                        "TRAIN": TRAIN, "DEV": DEV, "OOS": OOS, "HOLDOUT": HOLDOUT
                    }.items()
                    for k, v in perf(period(
                        rr.set_index("month")["net_return"], *bounds
                    ).to_numpy()).items()
                },
            }
        )
    base_df = pd.DataFrame(base_rows)

    # Recreate v1 rolling proxy in this apples-to-apples engine.
    proxy = {
        "code": "V1_ROLLING_PROXY",
        "rsi_period": 14,
        "left": 0,
        "right": 0,
        "max_gap": 0,
        "price_tol": 0.0,
        "rsi_gap": 5.0,
        "confirm": "NONE",
        "confirm_days": 0,
        "adx_max": None,
        "rsi_reclaim": 30,
    }
    # Proxy baseline is evaluated with the old conceptual rolling-low rule.
    def proxy_monthly(bps: float) -> pd.DataFrame:
        groups = {
            key: g.sort_values("date").reset_index(drop=True)
            for key, g in df.groupby(["symbol", "month"], sort=False)
        }
        rows = []
        for s in sel.itertuples(index=False):
            nm = pd.Timestamp(s.month) + pd.offsets.MonthEnd(1)
            w = groups.get((s.symbol, nm))
            if w is None or w.empty:
                continue
            r = w["RSI14"]
            pl = w["low"].rolling(20, min_periods=20).min()
            rl = r.rolling(20, min_periods=20).min()
            hit = (w["low"] <= pl * 1.005) & (r >= rl + 5)
            if not hit.any():
                rows.append({"month": nm, "gross": 0.0, "entered": 0})
                continue
            i = int(np.flatnonzero(hit.to_numpy())[0])
            if i + 1 >= len(w):
                rows.append({"month": nm, "gross": 0.0, "entered": 0})
                continue
            p0 = float(w.iloc[i + 1]["_px"])
            p1 = float(w.iloc[-1]["_px"])
            gross = p1 / p0 - 1.0 if p0 > 0 and np.isfinite(p0) and np.isfinite(p1) else 0.0
            rows.append({"month": nm, "gross": gross, "entered": 1})
        rr = pd.DataFrame(rows)
        if rr.empty:
            return pd.DataFrame(columns=["month", "net_return", "gross_return", "cost", "exposure"])
        m = rr.groupby("month").agg(gross_return=("gross", "mean"), entered=("entered", "sum"))
        m["exposure"] = m["entered"] / float(args.k)
        m["cost"] = m["exposure"] * bps / 10000.0
        m["net_return"] = m["gross_return"] - m["cost"]
        return m.reset_index()

    proxy_rows = []
    for bps in costs:
        rr = proxy_monthly(bps)
        proxy_rows.append(
            {
                "candidate": "V1_ROLLING_PROXY",
                "bps": bps,
                **{
                    f"{label}_{k}": v
                    for label, bounds in {
                        "TRAIN": TRAIN, "DEV": DEV, "OOS": OOS, "HOLDOUT": HOLDOUT
                    }.items()
                    for k, v in perf(period(rr.set_index("month")["net_return"], *bounds).to_numpy()).items()
                },
            }
        )
    proxy_df = pd.DataFrame(proxy_rows)

    chosen = rank2.iloc[0]
    chosen_code = str(chosen["candidate"])
    chosen_ref = stage2_df[
        (stage2_df["candidate"] == chosen_code) & np.isclose(stage2_df["bps"], min(costs))
    ].iloc[0]
    base_ref = base_df[np.isclose(base_df["bps"], min(costs))].iloc[0]
    proxy_ref = proxy_df[np.isclose(proxy_df["bps"], min(costs))].iloc[0]

    summary = {
        "status": "COMPLETED",
        "engine": "luna-m1-rsi-pivot-divergence-v2",
        "data_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count_stage1": len(s1),
        "candidate_count_stage2": len(s2),
        "k": args.k,
        "causal_definition": {
            "price_pivot": "unique local low using left/right bars",
            "pivot_availability": "second pivot is usable only after right confirmation bars",
            "divergence": "second pivot lower price low + higher RSI low vs prior pivot",
            "confirmation": "optional candle/RSI/MACD confirmation on or after pivot confirmation",
            "entry": "next trading day after confirmation",
            "exit": "forward-month last traded close",
        },
        "selection_rule": "TRAIN+DEV only; OOS and HOLDOUT are frozen",
        "cost_rule": "bps is round-trip cost per entered portfolio slot; identical across all candidates and baselines",
        "selected_candidate": chosen_ref.to_dict(),
        "m1_baseline": base_ref.to_dict(),
        "v1_rolling_proxy": proxy_ref.to_dict(),
        "delta_selected_vs_m1": {
            "OOS_geo_monthly": float(chosen_ref["OOS_geo_monthly"] - base_ref["OOS_geo_monthly"]),
            "HOLDOUT_geo_monthly": float(chosen_ref["HOLDOUT_geo_monthly"] - base_ref["HOLDOUT_geo_monthly"]),
            "HOLDOUT_cumulative": float(chosen_ref["HOLDOUT_cumulative"] - base_ref["HOLDOUT_cumulative"]),
        },
        "delta_pivot_vs_v1_proxy": {
            "OOS_geo_monthly": float(chosen_ref["OOS_geo_monthly"] - proxy_ref["OOS_geo_monthly"]),
            "HOLDOUT_geo_monthly": float(chosen_ref["HOLDOUT_geo_monthly"] - proxy_ref["HOLDOUT_geo_monthly"]),
        },
        "promotion_rule": (
            "Do not promote from TRAIN+DEV. Require frozen OOS and HOLDOUT improvement "
            "versus M1 baseline, plus positive performance under all configured cost levels."
        ),
    }

    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    stage1_df.to_csv(out / "stage1_results.csv", index=False)
    stage2_df.to_csv(out / "stage2_results.csv", index=False)
    base_df.to_csv(out / "baselines.csv", index=False)
    proxy_df.to_csv(out / "v1_proxy.csv", index=False)
    (out / "stage1_catalog.json").write_text(json.dumps(s1, indent=2), encoding="utf-8")
    (out / "stage2_catalog.json").write_text(json.dumps(s2, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
