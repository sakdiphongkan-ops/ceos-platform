#!/usr/bin/env python3
"""LUNA M1 RSI Advanced Timing Lab v1.

Purpose: isolate RSI-specific hypotheses from the Yuanta RSI framework:
- RSI 14 standard
- RSI 7 / 9 faster settings
- RSI 21 slower setting
- RSI 50 bullish-regime filter
- oversold <30 recovery and super-oversold <15 recovery
- RSI 30 "Oversold Turning" confirmed by improving MACD histogram
- bullish-divergence proxy: negative 20-day price momentum while 20-day RSI change is positive

M1 stock selection remains locked first: bottom K by 20-day momentum at month-end.
The RSI rule only gates exposure; blocked names stay in cash.
Candidate selection uses TRAIN+DEV only; OOS/HOLDOUT are frozen.
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


def rsi(s: pd.Series, n: int) -> pd.Series:
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
    need = {
        "date","symbol","open","high","low","close","volume","adj_close"
    }
    missing = sorted(need - set(p.columns))
    if missing:
        raise SystemExit(f"daily input missing columns: {missing}")

    for c in need - {"date","symbol"}:
        p[c] = pd.to_numeric(p[c], errors="coerce")
    p["symbol"] = p["symbol"].astype(str).str.upper().str.strip()
    p = p.sort_values(["symbol","date"]).drop_duplicates(["symbol","date"]).reset_index(drop=True)
    g = p.groupby("symbol", sort=False)
    adj = p["adj_close"].where(p["adj_close"].notna(), p["close"])

    p["MOM20"] = g[adj.name].pct_change(20) if adj.name in p.columns else g["adj_close"].pct_change(20)
    if adj.name not in p.columns:
        p["adj"] = adj
        g = p.groupby("symbol", sort=False)
        p["MOM20"] = g["adj"].pct_change(20)
        price_col = "adj"
    else:
        price_col = adj.name

    for n in [7, 9, 14, 21]:
        p[f"RSI{n}"] = g[price_col].apply(lambda x, n=n: rsi(x, n)).reset_index(level=0, drop=True)

    e12 = g[price_col].apply(lambda x: ema(x, 12)).reset_index(level=0, drop=True)
    e26 = g[price_col].apply(lambda x: ema(x, 26)).reset_index(level=0, drop=True)
    p["MACD"] = e12 - e26
    p["MACD_SIGNAL"] = p.groupby("symbol")["MACD"].transform(lambda x: ema(x, 9))
    p["MACD_HIST"] = p["MACD"] - p["MACD_SIGNAL"]
    p["MACD_HIST_SLOPE3"] = p.groupby("symbol")["MACD_HIST"].diff(3)

    p["RSI14_SLOPE3"] = p.groupby("symbol")["RSI14"].diff(3)
    p["RSI7_SLOPE3"] = p.groupby("symbol")["RSI7"].diff(3)
    p["RSI9_SLOPE3"] = p.groupby("symbol")["RSI9"].diff(3)
    p["RSI21_SLOPE3"] = p.groupby("symbol")["RSI21"].diff(3)

    prev30 = p.groupby("symbol")["RSI14"].shift(1)
    p["RSI14_CROSS30"] = ((p["RSI14"] > 30) & (prev30 <= 30)).astype(int)
    p["RSI14_CROSS50"] = ((p["RSI14"] > 50) & (p.groupby("symbol")["RSI14"].shift(1) <= 50)).astype(int)

    p["PRICE_MOM20"] = p["MOM20"]
    p["RSI14_DELTA20"] = p.groupby("symbol")["RSI14"].diff(20)
    p["RSI_BULL_DIV_PROXY"] = ((p["PRICE_MOM20"] < 0) & (p["RSI14_DELTA20"] > 0)).astype(int)

    p["RSI14_OVERSOLD30"] = (p["RSI14"] < 30).astype(int)
    p["RSI14_SUPER_OVERSOLD15"] = (p["RSI14"] < 15).astype(int)

    # "Oversold Turning" proxy from the Yuanta/StockRadars formulation:
    # RSI has crossed back above 30 while negative MACD histogram is improving.
    p["RSI_OVERSOLD_TURNING"] = (
        (p["RSI14_CROSS30"] == 1)
        & (p["MACD_HIST"] < 0)
        & (p["MACD_HIST_SLOPE3"] > 0)
    ).astype(int)

    # Contextual midpoint confirmation: RSI > 50 and MACD above signal.
    p["RSI_BULL_REGIME"] = (
        (p["RSI14"] > 50) & (p["MACD"] > p["MACD_SIGNAL"])
    ).astype(int)

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
        parts.append(
            g.sort_values(["MOM20","symbol"], ascending=[True,True])
             .head(k)
             .copy()
        )
    return pd.concat(parts, ignore_index=True)


def signal(df: pd.DataFrame, mode: str, threshold: float | None = None) -> pd.Series:
    if mode == "BASELINE":
        return pd.Series(True, index=df.index)
    if mode == "RSI7_RECOVERY":
        return (df["RSI7"] <= 35) & (df["RSI7_SLOPE3"] > 0)
    if mode == "RSI9_RECOVERY":
        return (df["RSI9"] <= 35) & (df["RSI9_SLOPE3"] > 0)
    if mode == "RSI14_RECOVERY":
        return (df["RSI14"] <= float(threshold)) & (df["RSI14_SLOPE3"] > 0)
    if mode == "RSI21_RECOVERY":
        return (df["RSI21"] <= 35) & (df["RSI21_SLOPE3"] > 0)
    if mode == "RSI50_REGIME":
        return (df["RSI14"] > 50) & (df["MACD"] > df["MACD_SIGNAL"])
    if mode == "RSI_CROSS50":
        return df["RSI14_CROSS50"] == 1
    if mode == "RSI_SUPER15":
        return (df["RSI14"] <= 15) & (df["RSI14_SLOPE3"] > 0)
    if mode == "RSI_DIV_PROXY":
        return (df["RSI_BULL_DIV_PROXY"] == 1) & (df["RSI14_SLOPE3"] > 0)
    if mode == "OVERSOLD_TURNING":
        return df["RSI_OVERSOLD_TURNING"] == 1
    raise ValueError(mode)


def compute_monthly(selected: pd.DataFrame, bps: float, k: int) -> pd.DataFrame:
    out = []
    prev = {}
    for month, g in selected.groupby("month", sort=True):
        w = g["gate"].astype(float) / k
        cur = {s: float(x) for s,x in zip(g["symbol"], w) if x > 0}
        syms = set(prev) | set(cur)
        turnover = 0.5 * sum(abs(cur.get(s,0)-prev.get(s,0)) for s in syms)
        gross = float(np.nansum(g["gate"].astype(float) / k * g["fwd_month"]))
        net = gross - turnover * bps / 10000.0
        out.append({
            "month": month, "gross_return": gross, "net_return": net,
            "turnover": turnover, "active_names": int(w.sum()*k),
            "exposure": float(w.sum()),
        })
        prev = cur
    return pd.DataFrame(out)


def attach_forward(df: pd.DataFrame) -> pd.DataFrame:
    me = (
        df.sort_values(["symbol","date"])
          .groupby(["symbol","month"], as_index=False)
          .tail(1)[["symbol","month", "adj_close"]]
          .sort_values(["symbol","month"])
    )
    me["next_month"] = me.groupby("symbol")["month"].shift(-1)
    me["next_close"] = me.groupby("symbol")["adj_close"].shift(-1)
    me["fwd_month"] = np.where(
        me["next_month"].eq(me["month"] + pd.offsets.MonthEnd(1)),
        me["next_close"] / me["adj_close"] - 1, np.nan
    )
    cols = ["symbol","month","fwd_month"]
    return df.merge(me[cols], on=["symbol","month"], how="left")


def period(s: pd.Series, start: str, end: str) -> pd.Series:
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
    df = attach_forward(load(args.input))
    sel = select_m1(df, args.k)

    candidates = [
        {"code":"M1_BASELINE","mode":"BASELINE","threshold":0},
        {"code":"RSI7_RECOVERY","mode":"RSI7_RECOVERY","threshold":35},
        {"code":"RSI9_RECOVERY","mode":"RSI9_RECOVERY","threshold":35},
        {"code":"RSI14_RECOVERY30","mode":"RSI14_RECOVERY","threshold":30},
        {"code":"RSI14_RECOVERY35","mode":"RSI14_RECOVERY","threshold":35},
        {"code":"RSI14_RECOVERY40","mode":"RSI14_RECOVERY","threshold":40},
        {"code":"RSI21_RECOVERY35","mode":"RSI21_RECOVERY","threshold":35},
        {"code":"RSI50_REGIME","mode":"RSI50_REGIME","threshold":0},
        {"code":"RSI_CROSS50","mode":"RSI_CROSS50","threshold":0},
        {"code":"RSI_SUPER15","mode":"RSI_SUPER15","threshold":0},
        {"code":"RSI_DIV_PROXY","mode":"RSI_DIV_PROXY","threshold":0},
        {"code":"OVERSOLD_TURNING","mode":"OVERSOLD_TURNING","threshold":0},
    ]

    rows = []
    for c in candidates:
        x = sel.copy()
        x["gate"] = signal(x, c["mode"], c["threshold"]).fillna(False)
        for bps in [float(v) for v in args.costs.split(",")]:
            rr = compute_monthly(x[["month","symbol","gate","fwd_month"]], bps, args.k)
            ser = rr.set_index("month")["net_return"]
            row = {"candidate":c["code"],"bps":bps}
            for label,start,end in [
                ("TRAIN","2022-10-31","2023-08-31"),
                ("DEV","2023-09-30","2024-08-31"),
                ("OOS","2024-09-30","2025-08-31"),
                ("HOLDOUT","2025-09-30","2026-08-31"),
            ]:
                row.update({f"{label}_{k}":v for k,v in perf(period(ser,start,end).to_numpy()).items()})
            row["avg_exposure"] = float(rr["exposure"].mean())
            row["avg_active_names"] = float(rr["active_names"].mean())
            row["average_turnover"] = float(rr["turnover"].mean())
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
        (nt*np.log1p(a["TRAIN_geo_monthly"].clip(lower=-.999999)) +
         nd*np.log1p(a["DEV_geo_monthly"].clip(lower=-.999999))) / (nt+nd)
    )
    rank["stress_train_dev_geo"] = np.expm1(
        (nt*np.log1p(b["TRAIN_geo_monthly"].clip(lower=-.999999)) +
         nd*np.log1p(b["DEV_geo_monthly"].clip(lower=-.999999))) / (nt+nd)
    )
    rank["min_geo"] = rank[["train_dev_geo","stress_train_dev_geo"]].min(axis=1)
    rank["dev_dd"] = a["DEV_max_drawdown_pct"]
    rank["robust_score"] = rank["min_geo"] - 0.25 * rank["dev_dd"].abs()
    rank["candidate"] = rank.index
    rank = rank.sort_values(["robust_score","train_dev_geo"], ascending=[False,False])
    rank.to_csv(out/"robust_ranking.csv")

    chosen = rank.index[0]
    chosen_ref = result[(result.candidate == chosen)&(result.bps == ref)].iloc[0].to_dict()
    base_ref = result[(result.candidate == "M1_BASELINE")&(result.bps == ref)].iloc[0].to_dict()

    summary = {
        "status":"COMPLETED",
        "engine":"luna-m1-rsi-advanced-timing-v1",
        "data_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count":len(candidates),
        "k":args.k,
        "source_hypotheses":{
            "rsi_14_standard":True,
            "rsi_7_9_fast":True,
            "rsi_21_slow":True,
            "rsi_50_midline":True,
            "bullish_divergence_proxy":True,
            "oversold_turning_rsi30_plus_macd_improving":True,
        },
        "selected_candidate":chosen_ref,
        "m1_baseline":base_ref,
        "delta_selected_vs_m1":{
            "OOS_geo_monthly":float(chosen_ref["OOS_geo_monthly"]-base_ref["OOS_geo_monthly"]),
            "HOLDOUT_geo_monthly":float(chosen_ref["HOLDOUT_geo_monthly"]-base_ref["HOLDOUT_geo_monthly"]),
            "HOLDOUT_cumulative":float(chosen_ref["HOLDOUT_cumulative"]-base_ref["HOLDOUT_cumulative"]),
        },
        "promotion_rule":"Promote only when frozen OOS and HOLDOUT both improve versus M1 and remain positive under 20/40/60 bps stress.",
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2,default=str),encoding="utf-8")
    (out/"candidate_catalog.json").write_text(json.dumps(candidates,indent=2),encoding="utf-8")


if __name__ == "__main__":
    main()
