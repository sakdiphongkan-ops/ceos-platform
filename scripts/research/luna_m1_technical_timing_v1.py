#!/usr/bin/env python3
"""LUNA M1 Technical Timing Tournament v1.

M1 selection is locked first: top-K recent losers by MOM_20 at month-end.
Technical indicators only control exposure to those already-selected names.

Families tested:
- RSI recovery / oversold
- MACD histogram turn / bullish crossover
- Stochastic recovery
- Bollinger position/re-entry
- candlestick reversal
- ADX / trend-strength safety
- moving-average trend safety
- support/breakout pattern context
- deterministic multi-signal ensembles

No technical signal is computed from future data.
Selection is frozen on TRAIN+DEV. OOS and HOLDOUT are descriptive only.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Candidate:
    code: str
    family: str
    min_signals: int
    rsi_max: float
    macd_mode: str
    stoch_mode: str
    bb_mode: str
    candle: bool
    trend_mode: str
    pattern_mode: str
    k: int = 20


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
            "best_month": None, "max_drawdown_pct": None
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


def make_candidates(k: int) -> list[Candidate]:
    out = [
        Candidate("M1_BASELINE", "BASELINE", 0, 0, "NONE", "NONE", "NONE", False, "NONE", "NONE", k)
    ]
    idx = 0

    # Single-family rules: isolates individual technical mechanisms.
    single_specs = [
        ("RSI", [30, 35, 40, 45], ["NONE"]),
        ("MACD", [35], ["SLOPE3", "CROSS5", "BULL"]),
        ("STOCH", [35], ["NONE"]),
        ("BB", [35], ["NONE"]),
        ("CANDLE", [35], ["NONE"]),
        ("TREND", [35], ["NONE"]),
        ("PATTERN", [35], ["NONE"]),
    ]

    for rsi_max in [30, 35, 40, 45]:
        idx += 1
        out.append(Candidate(f"T{idx:03d}_RSI_{rsi_max}", "RSI", 1, rsi_max, "NONE", "NONE", "NONE", False, "NONE", "NONE", k))
    for mode in ["SLOPE3", "CROSS5", "BULL"]:
        idx += 1
        out.append(Candidate(f"T{idx:03d}_MACD_{mode}", "MACD", 1, 0, mode, "NONE", "NONE", False, "NONE", "NONE", k))
    for mode in ["CROSS5", "KD_LOW", "OVERSOLD"]:
        idx += 1
        out.append(Candidate(f"T{idx:03d}_STOCH_{mode}", "STOCH", 1, 0, "NONE", mode, "NONE", False, "NONE", "NONE", k))
    for mode in ["LOW_RISING", "REENTRY", "LOW_BAND"]:
        idx += 1
        out.append(Candidate(f"T{idx:03d}_BB_{mode}", "BB", 1, 0, "NONE", "NONE", mode, False, "NONE", "NONE", k))
    for candle in [True, False]:
        if candle:
            idx += 1
            out.append(Candidate(f"T{idx:03d}_CANDLE5", "CANDLE", 1, 0, "NONE", "NONE", "NONE", True, "NONE", "NONE", k))
    for mode in ["NOT_DEEP", "EMA50", "ADX_LOW"]:
        idx += 1
        out.append(Candidate(f"T{idx:03d}_TREND_{mode}", "TREND", 1, 0, "NONE", "NONE", "NONE", False, mode, "NONE", k))
    for mode in ["SUPPORT", "NO_BREAKDOWN", "BREAKOUT20", "REVERSAL_PATTERN", "OBV_CONFIRM", "OBV_DIVERGENCE"]:
        idx += 1
        family = "OBV" if mode.startswith("OBV_") else "PATTERN"
        out.append(Candidate(f"T{idx:03d}_{family}_{mode}", family, 1, 0, "NONE", "NONE", "NONE", False, "NONE", mode, k))

    # Predefined ensembles: one theory at a time, then controlled combinations.
    combos = []
    for rsi_max, macd, stoch, bb, candle, trend, pattern, min_s in itertools.product(
        [35, 40], ["SLOPE3", "CROSS5"], ["CROSS5", "KD_LOW"],
        ["LOW_RISING", "REENTRY"], [False, True],
        ["NOT_DEEP", "ADX_LOW"], ["SUPPORT", "REVERSAL_PATTERN"], [2, 3]
    ):
        combos.append((rsi_max, macd, stoch, bb, candle, trend, pattern, min_s))
    # deterministic cap to keep the search interpretable and reproducible
    for j, spec in enumerate(combos[::4], 1):
        rsi_max, macd, stoch, bb, candle, trend, pattern, min_s = spec
        out.append(Candidate(
            f"E{j:03d}_R{rsi_max}_{macd}_{stoch}_{bb}_C{int(candle)}_{trend}_{pattern}_N{min_s}",
            "ENSEMBLE", min_s, rsi_max, macd, stoch, bb, candle, trend, pattern, k
        ))
    return out


def load(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["month"])
    required = {
        "month","symbol","MOM_20","RSI14","RSI_SLOPE3","RSI_RECOVERY30_5D",
        "MACD","MACD_SIGNAL","MACD_HIST","MACD_HIST_SLOPE3","MACD_CROSS_UP_5D",
        "STOCH_K","STOCH_D","STOCH_CROSS_UP_5D","BB_PCTB20","BB_BANDWIDTH20",
        "CANDLE_HAMMER","CANDLE_BULL_ENGULF","BULL_REVERSAL_5D",
        "EMA20","EMA50","DIST_MA60","ADX14","PLUS_DI14","MINUS_DI14",
        "SUPPORT_DISTANCE20","RESISTANCE_DISTANCE20","BREAKOUT20","BREAKOUT55",
        "fwd_month",
    }
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"technical panel missing columns: {missing}")
    for c in required - {"month","symbol"}:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.sort_values(["month","symbol"]).drop_duplicates(["month","symbol"]).reset_index(drop=True)


def base_selection(df: pd.DataFrame, k: int) -> pd.DataFrame:
    pieces = []
    for month, g in df.groupby("month", sort=True):
        x = g.dropna(subset=["MOM_20","fwd_month"]).copy()
        if x.empty:
            continue
        x = x.sort_values(["MOM_20","symbol"], ascending=[True,True]).head(k).copy()
        x["m1_rank"] = np.arange(1, len(x)+1)
        pieces.append(x)
    if not pieces:
        raise SystemExit("no monthly M1 selections")
    return pd.concat(pieces, ignore_index=True)


def signal_frame(x: pd.DataFrame, c: Candidate) -> pd.DataFrame:
    y = x.copy()

    sigs = []
    if c.rsi_max:
        sigs.append((y["RSI14"] <= c.rsi_max) & (y["RSI_SLOPE3"] > 0))
    if c.macd_mode != "NONE":
        if c.macd_mode == "SLOPE3":
            sigs.append((y["MACD_HIST_SLOPE3"] > 0) & (y["MACD"] < 0))
        elif c.macd_mode == "CROSS5":
            sigs.append(y["MACD_CROSS_UP_5D"] >= 1)
        else:
            sigs.append((y["MACD"] > y["MACD_SIGNAL"]) & (y["MACD_HIST_SLOPE3"] > 0))

    if c.stoch_mode != "NONE":
        if c.stoch_mode == "CROSS5":
            sigs.append(y["STOCH_CROSS_UP_5D"] >= 1)
        elif c.stoch_mode == "KD_LOW":
            sigs.append((y["STOCH_K"] > y["STOCH_D"]) & (y["STOCH_K"] < 50))
        else:
            sigs.append(y["STOCH_K"] < 20)

    if c.bb_mode != "NONE":
        if c.bb_mode == "LOW_RISING":
            sigs.append((y["BB_PCTB20"] < 0.40) & (y.groupby("symbol")["BB_PCTB20"].diff() > 0))
        elif c.bb_mode == "REENTRY":
            sigs.append((y["BB_PCTB20"] > 0) & (y.groupby("symbol")["BB_PCTB20"].shift(1) <= 0))
        else:
            sigs.append(y["BB_PCTB20"] < 0.20)

    if c.candle:
        sigs.append(y["BULL_REVERSAL_5D"] >= 1)

    if c.trend_mode != "NONE":
        if c.trend_mode == "NOT_DEEP":
            sigs.append(y["DIST_MA60"] > -0.20)
        elif c.trend_mode == "EMA50":
            sigs.append(y["EMA20"] >= y["EMA50"])
        else:
            sigs.append((y["ADX14"] < 30) | (y["PLUS_DI14"] >= y["MINUS_DI14"]))

    if c.pattern_mode != "NONE":
        if c.pattern_mode == "SUPPORT":
            sigs.append((y["SUPPORT_DISTANCE20"] < 0.05) & (y.groupby("symbol")["fwd_month"].transform("size") > 0))
        elif c.pattern_mode == "NO_BREAKDOWN":
            sigs.append(y["BREAKOUT20"] > -0.05)
        elif c.pattern_mode == "BREAKOUT20":
            sigs.append(y["BREAKOUT20"] > 0)
        elif c.pattern_mode == "OBV_CONFIRM":
            sigs.append(y["OBV_SLOPE20"] > 0)
        elif c.pattern_mode == "OBV_DIVERGENCE":
            sigs.append((y["OBV_SLOPE20"] > 0) & (y["MOM_20"] < 0))
        else:
            sigs.append(y["BULL_REVERSAL_5D"] >= 1)

    if not sigs:
        y["gate"] = True
        y["signal_count"] = 0
    else:
        arr = np.column_stack([s.fillna(False).to_numpy(dtype=bool) for s in sigs])
        y["signal_count"] = arr.sum(axis=1)
        y["gate"] = y["signal_count"] >= max(1, min(c.min_signals, arr.shape[1]))
    return y


def compute_returns(selected: pd.DataFrame, cost_bps: float) -> pd.DataFrame:
    rows = []
    prev_weights: dict[str,float] = {}
    k = 20
    for month, g in selected.groupby("month", sort=True):
        g = g.copy()
        g["w"] = g["gate"].astype(float) / k
        current = {s: float(w) for s,w in zip(g["symbol"], g["w"]) if w > 0}
        all_symbols = set(prev_weights) | set(current)
        turnover = 0.5 * sum(abs(current.get(s,0.0) - prev_weights.get(s,0.0)) for s in all_symbols)
        ret = float(np.nansum(g["w"] * g["fwd_month"]))
        net = ret - turnover * cost_bps / 10000.0
        rows.append({
            "month": month, "gross_return": ret, "turnover": turnover,
            "transaction_cost": turnover * cost_bps / 10000.0,
            "net_return": net, "active_names": int(sum(w > 0 for w in current.values())),
            "exposure": float(sum(current.values())),
        })
        prev_weights = current
    return pd.DataFrame(rows)


def evaluate(s: pd.Series) -> dict:
    x = s.dropna().to_numpy(dtype=float)
    return perf(x)


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
    df = load(args.input)
    selected = base_selection(df, args.k)
    candidates = make_candidates(args.k)

    rows = []
    catalogs = []
    monthly_panels = {}

    for c in candidates:
        z = signal_frame(selected, c)
        catalogs.append(c.__dict__)
        for bps in [float(x) for x in args.costs.split(",")]:
            rr = compute_returns(z[["month","symbol","fwd_month","gate"]], bps)
            ser = rr.set_index("month")["net_return"]
            row = {"candidate": c.code, "family": c.family, "bps": bps}
            for label, start, end in [
                ("TRAIN", "2022-10-31", "2023-08-31"),
                ("DEV", "2023-09-30", "2024-08-31"),
                ("OOS", "2024-09-30", "2025-08-31"),
                ("HOLDOUT", "2025-09-30", "2026-08-31"),
            ]:
                p = evaluate(period(ser, start, end))
                row.update({f"{label}_{k}": v for k,v in p.items()})
            row["avg_exposure"] = float(rr["exposure"].mean())
            row["avg_active_names"] = float(rr["active_names"].mean())
            row["average_turnover"] = float(rr["turnover"].mean())
            rows.append(row)
            if bps == float(args.costs.split(",")[0]):
                monthly_panels[c.code] = rr

    result = pd.DataFrame(rows)
    result.to_csv(out / "candidate_results.csv", index=False)
    (out / "candidate_catalog.json").write_text(json.dumps(catalogs, indent=2), encoding="utf-8")

    ref = float(args.costs.split(",")[0])
    stress = float(args.costs.split(",")[-1])
    refdf = result[result.bps == ref].set_index("candidate")
    stressdf = result[result.bps == stress].set_index("candidate")
    ranking = pd.DataFrame(index=refdf.index)
    ranking["train_dev_geo"] = (
        (refdf["TRAIN_geo_monthly"] + refdf["DEV_geo_monthly"]) / 2
    )
    ranking["stress_train_dev_geo"] = stressdf["TRAIN_geo_monthly"].combine(
        stressdf["DEV_geo_monthly"], lambda a,b: (a+b)/2
    )
    ranking["min_geo"] = ranking[["train_dev_geo","stress_train_dev_geo"]].min(axis=1)
    ranking["dev_drawdown"] = refdf["DEV_max_drawdown_pct"]
    ranking["robust_score"] = ranking["min_geo"] - 0.25 * ranking["dev_drawdown"].abs()
    ranking["candidate"] = ranking.index
    ranking = ranking.sort_values(["robust_score","train_dev_geo"], ascending=[False,False])
    ranking.to_csv(out / "robust_ranking.csv")

    chosen = str(ranking.index[0])
    chosen_ref = result[(result.candidate == chosen) & (result.bps == ref)].iloc[0].to_dict()
    m1_ref = result[(result.candidate == "M1_BASELINE") & (result.bps == ref)].iloc[0].to_dict()

    summary = {
        "status":"COMPLETED",
        "engine":"luna-m1-technical-timing-v1",
        "data_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "candidate_count":len(candidates),
        "k":args.k,
        "selection_rule":"M1 top-K is locked first; technical layer only gates exposure. Candidate selection uses TRAIN+DEV only.",
        "periods":{
            "TRAIN":"2022-10-31_to_2023-08-31",
            "DEV":"2023-09-30_to_2024-08-31",
            "OOS":"2024-09-30_to_2025-08-31",
            "HOLDOUT":"2025-09-30_to_2026-08-31"
        },
        "selected_candidate":chosen_ref,
        "m1_baseline":m1_ref,
        "delta_selected_vs_m1":{
            "OOS_geo_monthly":float(chosen_ref["OOS_geo_monthly"]-m1_ref["OOS_geo_monthly"]),
            "HOLDOUT_geo_monthly":float(chosen_ref["HOLDOUT_geo_monthly"]-m1_ref["HOLDOUT_geo_monthly"]),
            "HOLDOUT_cumulative":float(chosen_ref["HOLDOUT_cumulative"]-m1_ref["HOLDOUT_cumulative"]),
        },
        "technical_families":[
            "RSI","MACD","Stochastic","Bollinger Bands","candlestick reversal",
            "ADX/DMI","moving-average trend","support/breakout pattern","multi-signal ensemble"
        ],
        "promotion_rule":"No technical gate is promoted unless frozen OOS/HOLDOUT improves versus M1 and remains positive under cost stress."
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
