#!/usr/bin/env python3
"""LUNA M1 RSI Optimizer v2.

Purpose
-------
Find a causal RSI configuration that improves the locked M1 "20 recent losers"
strategy when RSI is used only as a daily entry/exit timing layer.

Guardrails
----------
- M1 stock selection is frozen at month-end using MOM_20; RSI never changes the
  selected universe.
- All RSI features use data available on or before the signal day.
- Entry is the next trading day after a valid signal/confirmation.
- Exit is the next trading day after an RSI exit signal, otherwise month-end.
- Candidate selection uses TRAIN+DEV only.
- OOS and HOLDOUT are frozen evaluation periods.
- Costs are applied identically to baseline and candidates as round-trip bps.
- Stage 1 searches RSI period/threshold/entry family.
- Stage 2 expands the best TRAIN+DEV candidates across confirmation, ADX,
  divergence gap/window and RSI exit rules.

This is a research candidate generator; promotion into production M1 requires
frozen OOS + HOLDOUT improvement and cost stress.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd


TRAIN = ("2022-10-31", "2023-08-31")
DEV = ("2023-09-30", "2024-08-31")
OOS = ("2024-09-30", "2025-08-31")
HOLDOUT = ("2025-09-30", "2026-08-31")


def rsi_np(s: pd.Series, n: int) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0.0)
    dn = -d.clip(upper=0.0)
    au = up.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0.0, np.nan)
    out = 100.0 - 100.0 / (1.0 + rs)
    return out.where(ad.ne(0.0), 100.0)


def geo(x: pd.Series | np.ndarray) -> float:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0 or np.any(x <= -1):
        return -1.0
    return float(np.expm1(np.mean(np.log1p(x))))


def perf(x: pd.Series | np.ndarray) -> dict:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return {
            "months": 0, "geo_monthly": -1.0, "cumulative": -1.0,
            "positive_month_pct": 0.0, "max_drawdown_pct": None,
            "worst_month": None, "best_month": None,
        }
    eq = np.cumprod(1.0 + x)
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1.0
    return {
        "months": int(len(x)),
        "geo_monthly": geo(x),
        "cumulative": float(eq[-1] - 1.0),
        "positive_month_pct": float(np.mean(x > 0)),
        "max_drawdown_pct": float(np.min(dd)),
        "worst_month": float(np.min(x)),
        "best_month": float(np.max(x)),
    }


def period(s: pd.Series, start: str, end: str) -> pd.Series:
    idx = pd.to_datetime(s.index)
    return s[(idx >= pd.Timestamp(start)) & (idx <= pd.Timestamp(end))]


@dataclass(frozen=True)
class Candidate:
    code: str
    rsi_period: int
    oversold: int
    entry_mode: str
    confirm: str = "NONE"
    confirm_days: int = 0
    adx_max: int | None = None
    div_window: int = 20
    div_gap: int = 5
    exit_mode: str = "MONTH_END"
    exit_level: int | None = None


def load_daily(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "symbol", "open", "high", "low", "close", "volume", "adj_close"}
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
    df["_px"] = df["adj_close"].where(df["adj_close"].notna(), df["close"])
    df["month"] = df["date"].dt.to_period("M").dt.to_timestamp("M")
    df["MOM20"] = df.groupby("symbol")["_px"].pct_change(20)
    # Causal candle features.
    body = (df["close"] - df["open"]).abs()
    rng = (df["high"] - df["low"]).replace(0.0, np.nan)
    upper = df["high"] - df[["open", "close"]].max(axis=1)
    lower = df[["open", "close"]].min(axis=1) - df["low"]
    df["HAMMER"] = (
        (lower >= 2.0 * body) &
        (upper <= body) &
        ((body / rng) <= 0.40)
    ).astype(int)
    prev_open = df.groupby("symbol")["open"].shift(1)
    prev_close = df.groupby("symbol")["close"].shift(1)
    df["ENGULF"] = (
        (prev_close < prev_open) &
        (df["close"] > df["open"]) &
        (df["open"] <= prev_close) &
        (df["close"] >= prev_open)
    ).astype(int)
    df["REVERSAL"] = ((df["HAMMER"] == 1) | (df["ENGULF"] == 1)).astype(int)

    # Causal ADX(14).
    up_move = df.groupby("symbol")["high"].diff()
    down_move = -df.groupby("symbol")["low"].diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0.0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0.0)
    prev_c = df.groupby("symbol")["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_c).abs(),
        (df["low"] - prev_c).abs(),
    ], axis=1).max(axis=1)
    tr14 = tr.groupby(df["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum())
    plus14 = plus_dm.groupby(df["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum())
    minus14 = minus_dm.groupby(df["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).sum())
    plus_di = 100.0 * plus14 / tr14.replace(0.0, np.nan)
    minus_di = 100.0 * minus14 / tr14.replace(0.0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0.0, np.nan)
    df["ADX14"] = dx.groupby(df["symbol"]).transform(lambda x: x.rolling(14, min_periods=14).mean())

    return df.replace([np.inf, -np.inf], np.nan)


def build_rsi_features(df: pd.DataFrame, periods: list[int]) -> pd.DataFrame:
    df = df.copy()
    g = df.groupby("symbol", sort=False)
    for n in periods:
        col = f"RSI{n}"
        df[col] = g["_px"].apply(lambda x: rsi_np(x, n)).reset_index(level=0, drop=True)
        df[f"{col}_PREV"] = g[col].shift(1)
        df[f"{col}_SLOPE3"] = g[col].diff(3)
        df[f"{col}_LOW10"] = g[col].transform(lambda x: x.rolling(10, min_periods=10).min())
        df[f"{col}_LOW20"] = g[col].transform(lambda x: x.rolling(20, min_periods=20).min())
    df["PRICE_LOW10"] = g["low"].transform(lambda x: x.rolling(10, min_periods=10).min())
    df["PRICE_LOW20"] = g["low"].transform(lambda x: x.rolling(20, min_periods=20).min())
    return df


def month_end_selection(df: pd.DataFrame, k: int) -> pd.DataFrame:
    end = (
        df.sort_values(["symbol", "date"])
          .groupby(["symbol", "month"], as_index=False)
          .tail(1)
          .dropna(subset=["MOM20"])
    )
    pieces = []
    for month, g in end.groupby("month", sort=True):
        x = g.sort_values(["MOM20", "symbol"], ascending=[True, True]).head(k).copy()
        x["rank"] = np.arange(1, len(x) + 1)
        pieces.append(x[["month", "symbol", "rank"]])
    if not pieces:
        raise SystemExit("no M1 month-end selections")
    return pd.concat(pieces, ignore_index=True)


def signal_hit(w: pd.DataFrame, c: Candidate) -> pd.Series:
    r = w[f"RSI{c.rsi_period}"]
    rp = w[f"RSI{c.rsi_period}_PREV"]
    if c.entry_mode == "CROSS_UP":
        sig = (r > c.oversold) & (rp <= c.oversold)
    elif c.entry_mode == "RISING_OVERSOLD":
        sig = (r <= c.oversold) & (w[f"RSI{c.rsi_period}_SLOPE3"] > 0)
    elif c.entry_mode == "RECLAIM_3":
        lo = w[f"RSI{c.rsi_period}"].rolling(3, min_periods=1).min()
        sig = (lo <= c.oversold) & (r > c.oversold)
    elif c.entry_mode == "RECLAIM_5":
        lo = w[f"RSI{c.rsi_period}"].rolling(5, min_periods=1).min()
        sig = (lo <= c.oversold) & (r > c.oversold)
    elif c.entry_mode == "DIVERGENCE":
        pw = f"PRICE_LOW{c.div_window}"
        rw = f"RSI{c.rsi_period}_LOW{c.div_window}"
        sig = (
            (w["low"] <= w[pw] * 1.005) &
            (r >= w[rw] + c.div_gap)
        )
    else:
        raise ValueError(c.entry_mode)
    return sig.fillna(False)


def confirmation_hit(w: pd.DataFrame, start_i: int, c: Candidate) -> int | None:
    end_i = min(len(w) - 1, start_i + max(0, c.confirm_days))
    for j in range(start_i, end_i + 1):
        if c.confirm == "NONE":
            ok = True
        elif c.confirm == "HAMMER":
            ok = bool(w.iloc[j]["HAMMER"] == 1)
        elif c.confirm == "ENGULF":
            ok = bool(w.iloc[j]["ENGULF"] == 1)
        elif c.confirm == "REVERSAL":
            ok = bool(w.iloc[j]["REVERSAL"] == 1)
        else:
            ok = False
        if not ok:
            continue
        if c.adx_max is not None:
            adx = w.iloc[j]["ADX14"]
            if not np.isfinite(adx) or adx > c.adx_max:
                continue
        return j
    return None


def find_entry_exit(w: pd.DataFrame, c: Candidate) -> tuple[int | None, int | None]:
    if w.empty:
        return None, None
    sig = signal_hit(w, c).to_numpy(dtype=bool)
    hit_ix = np.flatnonzero(sig)
    entry_i = None
    for i in hit_ix:
        conf_i = confirmation_hit(w, int(i), c)
        if conf_i is None:
            continue
        # Always enter the next trading day after confirmation.
        if conf_i + 1 < len(w):
            entry_i = conf_i + 1
            break
    if entry_i is None:
        return None, None

    exit_i = len(w) - 1
    if c.exit_mode == "RSI_DOWN":
        r = w[f"RSI{c.rsi_period}"].to_numpy(dtype=float)
        lvl = float(c.exit_level)
        prev = np.roll(r, 1)
        cross = (prev >= lvl) & (r < lvl)
        cross[:1] = False
        candidates = np.flatnonzero(cross & (np.arange(len(w)) > entry_i))
        if len(candidates):
            exit_i = min(int(candidates[0] + 1), len(w) - 1)
    return entry_i, exit_i


def evaluate_candidate(
    df: pd.DataFrame,
    selections: pd.DataFrame,
    c: Candidate,
    k: int,
    costs: list[float],
) -> dict:
    rows = []
    grouped = {key: g for key, g in df.groupby(["symbol", "month"], sort=False)}
    for s in selections.itertuples(index=False):
        next_month = pd.Timestamp(s.month) + pd.offsets.MonthEnd(1)
        w = grouped.get((s.symbol, next_month))
        if w is None or w.empty:
            continue
        w = w.sort_values("date").reset_index(drop=True)
        if c.entry_mode == "DIVERGENCE" and c.div_window not in (10, 20):
            raise ValueError("unsupported divergence window")
        ei, xi = find_entry_exit(w, c)
        if ei is None:
            stock_ret = 0.0
            entered = 0
        else:
            p0 = float(w.iloc[ei]["_px"])
            p1 = float(w.iloc[xi]["_px"])
            stock_ret = p1 / p0 - 1.0 if p0 > 0 and np.isfinite(p0) and np.isfinite(p1) else 0.0
            entered = 1
        rows.append({
            "month": next_month,
            "symbol": s.symbol,
            "rank": int(s.rank),
            "entered": int(entered),
            "stock_return": float(stock_ret),
        })

    trades = pd.DataFrame(rows)
    if trades.empty:
        return {"candidate": c.code, "candidate_cfg": asdict(c), "cost_rows": []}

    out = {"candidate": c.code, "candidate_cfg": asdict(c), "cost_rows": []}
    for bps in costs:
        mrows = []
        for month, g in trades.groupby("month", sort=True):
            gross = float(g["stock_return"].sum() / k)
            active = int(g["entered"].sum())
            # Per entered name, charge a round trip: buy + sell.
            cost = (active / float(k)) * (2.0 * bps / 10000.0)
            mrows.append((month, gross - cost, gross, cost, active / float(k)))
        rr = pd.DataFrame(
            mrows,
            columns=["month", "net_return", "gross_return", "transaction_cost", "exposure"],
        ).set_index("month")
        item = {"bps": float(bps)}
        for label, (st, en) in {
            "TRAIN": TRAIN, "DEV": DEV, "OOS": OOS, "HOLDOUT": HOLDOUT
        }.items():
            item[label] = perf(period(rr["net_return"], st, en))
        item["avg_exposure"] = float(rr["exposure"].mean()) if len(rr) else 0.0
        item["total_cost"] = float(rr["transaction_cost"].sum()) if len(rr) else 0.0
        out["cost_rows"].append(item)
    return out


def flatten_results(results: list[dict]) -> pd.DataFrame:
    rows = []
    for x in results:
        base = {"candidate": x["candidate"], **x["candidate_cfg"]}
        for item in x["cost_rows"]:
            row = dict(base)
            row["bps"] = item["bps"]
            for label in ("TRAIN", "DEV", "OOS", "HOLDOUT"):
                for k, v in item[label].items():
                    row[f"{label}_{k}"] = v
            row["avg_exposure"] = item["avg_exposure"]
            row["total_cost"] = item["total_cost"]
            rows.append(row)
    return pd.DataFrame(rows)


def score_train_dev(df: pd.DataFrame, stress_bps: float, ref_bps: float) -> pd.DataFrame:
    a = df[df.bps == ref_bps].set_index("candidate")
    b = df[df.bps == stress_bps].set_index("candidate")
    n1 = a["TRAIN_months"].astype(float)
    n2 = a["DEV_months"].astype(float)
    rank = pd.DataFrame(index=a.index)
    rank["train_dev_geo"] = np.expm1(
        (n1 * np.log1p(a["TRAIN_geo_monthly"].clip(-0.999999, None)) +
         n2 * np.log1p(a["DEV_geo_monthly"].clip(-0.999999, None))) / (n1 + n2)
    )
    rank["stress_train_dev_geo"] = np.expm1(
        (n1 * np.log1p(b["TRAIN_geo_monthly"].clip(-0.999999, None)) +
         n2 * np.log1p(b["DEV_geo_monthly"].clip(-0.999999, None))) / (n1 + n2)
    )
    rank["min_geo"] = rank[["train_dev_geo", "stress_train_dev_geo"]].min(axis=1)
    rank["dev_dd"] = a["DEV_max_drawdown_pct"].abs()
    rank["robust_score"] = rank["min_geo"] - 0.25 * rank["dev_dd"]
    rank["candidate"] = rank.index
    return rank.sort_values(["robust_score", "train_dev_geo"], ascending=[False, False])


def stage1_candidates() -> list[Candidate]:
    out = []
    idx = 0
    for n, os, mode in itertools.product(
        [5, 7, 9, 14, 18, 21],
        [20, 25, 30, 35, 40],
        ["CROSS_UP", "RISING_OVERSOLD", "RECLAIM_3", "RECLAIM_5", "DIVERGENCE"],
    ):
        idx += 1
        out.append(Candidate(f"S1_{idx:03d}", n, os, mode))
    return out


def stage2_expand(top: list[Candidate]) -> list[Candidate]:
    out = []
    for base in top:
        confirms = ["NONE"] if base.entry_mode != "DIVERGENCE" else ["NONE", "HAMMER", "ENGULF", "REVERSAL"]
        for confirm, days, adx, exit_mode, lvl in itertools.product(
            confirms,
            [0, 5, 10],
            [None, 20, 25, 30],
            ["MONTH_END", "RSI_DOWN"],
            [None, 60, 65, 70, 75],
        ):
            if confirm == "NONE" and days != 0:
                continue
            if exit_mode == "MONTH_END" and lvl is not None:
                continue
            if exit_mode == "RSI_DOWN" and lvl is None:
                continue
            windows = [20] if base.entry_mode != "DIVERGENCE" else [10, 20]
            gaps = [5] if base.entry_mode != "DIVERGENCE" else [3, 5, 7]
            for dw, dg in itertools.product(windows, gaps):
                code = (
                    f"S2_{base.code}_{confirm}_D{days}_A{adx if adx is not None else 'NA'}"
                    f"_{exit_mode}_{lvl if lvl is not None else 'NA'}_W{dw}_G{dg}"
                )
                out.append(Candidate(
                    code, base.rsi_period, base.oversold, base.entry_mode,
                    confirm, days, adx, dw, dg, exit_mode, lvl
                ))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--costs", default="20,40,60")
    ap.add_argument("--top-stage1", type=int, default=12)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    df = load_daily(args.input)

    s1 = stage1_candidates()
    rsi_periods = sorted({c.rsi_period for c in s1})
    df = build_rsi_features(df, rsi_periods)
    selections = month_end_selection(df, args.k)

    # Baseline uses no RSI: enter first trading day of the next month and exit month-end.
    base = Candidate("M1_NO_RSI", 14, 30, "CROSS_UP")
    # Special baseline is evaluated directly to avoid requiring a signal.
    def baseline_result() -> dict:
        rows = []
        grouped = {key: g for key, g in df.groupby(["symbol", "month"], sort=False)}
        for s in selections.itertuples(index=False):
            nm = pd.Timestamp(s.month) + pd.offsets.MonthEnd(1)
            w = grouped.get((s.symbol, nm))
            if w is None or w.empty:
                continue
            w = w.sort_values("date").reset_index(drop=True)
            p0 = float(w.iloc[0]["_px"])
            p1 = float(w.iloc[-1]["_px"])
            ret = p1 / p0 - 1.0 if p0 > 0 and np.isfinite(p0) and np.isfinite(p1) else 0.0
            rows.append({"month": nm, "ret": ret})
        rr = pd.DataFrame(rows)
        result = []
        for bps in [float(x) for x in args.costs.split(",")]:
            m = rr.groupby("month")["ret"].mean().to_frame("net_return") if not rr.empty else pd.DataFrame()
            if not m.empty:
                # All 20 slots are entered and exited.
                m["net_return"] = m["net_return"] - 2.0 * bps / 10000.0
            item = {"bps": bps}
            for label, (st, en) in {"TRAIN": TRAIN, "DEV": DEV, "OOS": OOS, "HOLDOUT": HOLDOUT}.items():
                item[label] = perf(period(m["net_return"], st, en)) if not m.empty else perf([])
            result.append(item)
        return {"candidate": "M1_NO_RSI", "candidate_cfg": {"mode": "baseline"}, "cost_rows": result}

    baseline = baseline_result()
    stage1_results = [evaluate_candidate(df, selections, c, args.k, [float(x) for x in args.costs.split(",")]) for c in s1]
    flat1 = flatten_results(stage1_results)
    rank1 = score_train_dev(flat1, max(map(float, args.costs.split(","))), min(map(float, args.costs.split(","))))
    top = [next(c for c in s1 if c.code == code) for code in rank1.head(args.top_stage1).index]

    s2 = stage2_expand(top)
    stage2_results = [evaluate_candidate(df, selections, c, args.k, [float(x) for x in args.costs.split(",")]) for c in s2]
    flat2 = flatten_results(stage2_results)
    rank2 = score_train_dev(flat2, max(map(float, args.costs.split(","))), min(map(float, args.costs.split(","))))
    chosen = str(rank2.index[0])

    all_flat = pd.concat([flat1, flat2], ignore_index=True)
    all_flat.to_csv(out / "candidate_results.csv", index=False)
    rank1.to_csv(out / "stage1_ranking.csv")
    rank2.to_csv(out / "stage2_ranking.csv")
    (out / "stage1_catalog.json").write_text(json.dumps([asdict(c) for c in s1], indent=2), encoding="utf-8")
    (out / "stage2_catalog.json").write_text(json.dumps([asdict(c) for c in s2], indent=2), encoding="utf-8")

    chosen_row = all_flat[(all_flat.candidate == chosen) & (all_flat.bps == float(min(map(float, args.costs.split(",")))))]
    hold = chosen_row.iloc[0].to_dict() if not chosen_row.empty else {}
    base_ref = next((x for x in baseline["cost_rows"] if x["bps"] == float(min(map(float, args.costs.split(","))))), {})
    summary = {
        "status": "COMPLETED",
        "engine": "luna-m1-rsi-optimizer-v2",
        "dataset_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "selection": "top-K M1 recent losers by MOM20 at month-end; RSI only controls timing",
        "candidate_count_stage1": len(s1),
        "candidate_count_stage2": len(s2),
        "candidate_count_total": len(s1) + len(s2),
        "top_stage1": args.top_stage1,
        "selected_candidate_train_dev": hold,
        "baseline_m1": base_ref,
        "promotion_rule": "Do not promote unless selected candidate improves frozen OOS and HOLDOUT over M1 baseline and remains better at 60 bps.",
        "periods": {"TRAIN": TRAIN, "DEV": DEV, "OOS": OOS, "HOLDOUT": HOLDOUT},
        "cost_model": "round-trip cost: 2 * bps per entered name, applied identically to baseline/candidates",
        "leakage_guard": "features and signals are causal; selection occurs before forward month; entry is next day after signal/confirmation; TRAIN+DEV only for candidate selection",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
