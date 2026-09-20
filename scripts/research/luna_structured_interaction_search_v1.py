#!/usr/bin/env python3
"""Structured interaction search for LUNA.

Uses point-in-time daily factors, samples only the final trading date of each
calendar month, ranks stocks cross-sectionally, and evaluates 20-trading-day
forward returns with turnover-aware costs.

Design:
- locked M1-style reversal benchmark: LOW MOM_20, K=20
- 2,000 deterministic structured hypotheses
- formula families: weighted sums, pair products, min/max, agreement,
  disagreement, and gated signals
- 35-month train -> 12-month validation -> 12-month blind holdout
- top 50 by train -> top 10 by validation -> holdout
- holdout is never used for formula selection
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

BASE_FEATURES = [
    "MOM_5", "MOM_10", "MOM_20", "MOM_60", "MOM_120", "REL_MOM",
    "VOL_10", "VOL_20", "MAXDD_60", "ATR_PCT",
    "ADV20", "AMOUNT", "RSI14", "DIST_MA20", "DIST_MA60",
    "BREAKOUT20", "BREAKOUT55", "SKEW_20", "SKEW_60",
    "QUALITY_SCORE", "VALUE_QUALITY", "MOM_BLEND", "CONSERVATIVE_SCORE",
    "SAFETY_SCORE", "GROWTH_QUALITY", "INV_QUALITY",
    "EARNINGS_YIELD", "FCF_YIELD", "DIV_YIELD", "ROIC", "ROE",
    "ROA", "GPM", "NPM", "CFO_MARGIN", "REV_G", "EPS_G", "FCF_G",
    "DE", "NET_DEBT_EBITDA", "INTEREST_COVER", "CURRENT_RATIO",
]

def geo(vals: np.ndarray) -> float:
    x = vals[np.isfinite(vals)]
    if len(x) == 0 or np.any(x <= -1):
        return -1.0
    return float(np.exp(np.log1p(x).mean()) - 1.0)

def stats(vals: np.ndarray) -> dict[str, float | int | None]:
    x = np.asarray(vals, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return {
            "months": 0,
            "geometric_monthly_return": -1.0,
            "cumulative_return": -1.0,
            "positive_month_pct": 0.0,
            "months_ge_7pct": 0,
            "max_drawdown_pct": None,
            "final_capital_baht": 30000.0,
        }
    eq = 30000.0 * np.cumprod(1.0 + x)
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1.0
    return {
        "months": int(len(x)),
        "geometric_monthly_return": geo(x),
        "cumulative_return": float(eq[-1] / 30000.0 - 1.0),
        "positive_month_pct": float((x > 0).mean()),
        "months_ge_7pct": int((x >= 0.07).sum()),
        "max_drawdown_pct": float(dd.min()),
        "final_capital_baht": float(eq[-1]),
    }

def build_formulas(features: list[str], count: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(kind: str, args: dict[str, Any]) -> None:
        if len(out) >= count:
            return
        key = kind + "|" + json.dumps(args, sort_keys=True, separators=(",", ":"))
        if key in seen:
            return
        seen.add(key)
        out.append({"id": f"G{len(out):04d}", "kind": kind, **args})

    # Locked M1-style reversal benchmark.
    add("M1", {"features": ["MOM_20"], "orientations": [1]})

    orientations = [0, 1]  # 0 = high-is-better, 1 = low-is-better
    weights = [0.20, 0.35, 0.50, 0.65, 0.80]
    patterns = [
        [0.50, 0.30, 0.20],
        [0.60, 0.25, 0.15],
        [0.40, 0.40, 0.20],
        [0.20, 0.30, 0.50],
        [0.70, 0.20, 0.10],
        [1 / 3, 1 / 3, 1 / 3],
    ]

    # Keep the feature space manageable and interpretable.
    core = features[:24]

    for a, b in itertools.combinations(core, 2):
        for oa, ob, w in itertools.product(orientations, orientations, weights):
            add("SUM2", {"features": [a, b], "orientations": [oa, ob], "weights": [w, 1.0 - w]})
            if len(out) >= count:
                return out

    for a, b, c in itertools.combinations(core[:18], 3):
        for oa, ob, oc, p in itertools.product(orientations, orientations, orientations, patterns):
            add("SUM3", {"features": [a, b, c], "orientations": [oa, ob, oc], "weights": p})
            if len(out) >= count:
                return out

    ops = ["PROD", "MIN", "MAX", "AGREE", "DISAGREE"]
    for a, b in itertools.combinations(core, 2):
        for oa, ob, op in itertools.product(orientations, orientations, ops):
            add(op, {"features": [a, b], "orientations": [oa, ob]})
            if len(out) >= count:
                return out

    gates = [0.70, 0.80, 0.90]
    for gate, score in itertools.permutations(core[:16], 2):
        for og, os, t in itertools.product(orientations, orientations, gates):
            add("GATE", {"features": [gate, score], "orientations": [og, os], "threshold": t})
            if len(out) >= count:
                return out

    if len(out) < count:
        raise SystemExit(f"Formula generator produced only {len(out)} < requested {count}")
    return out

def eval_formula(formula: dict[str, Any], rank: np.ndarray, fmap: dict[str, int]) -> np.ndarray:
    kind = formula["kind"]
    features = formula["features"]

    def oriented(name: str, orientation: int) -> np.ndarray:
        x = rank[:, fmap[name]]
        return 1.0 - x if orientation else x

    if kind == "M1":
        return oriented("MOM_20", 1)
    if kind in {"SUM2", "SUM3"}:
        return sum(
            w * oriented(f, o)
            for f, o, w in zip(formula["features"], formula["orientations"], formula["weights"])
        )
    a = oriented(features[0], formula["orientations"][0])
    b = oriented(features[1], formula["orientations"][1])
    if kind == "PROD":
        return a * b
    if kind == "MIN":
        return np.minimum(a, b)
    if kind == "MAX":
        return np.maximum(a, b)
    if kind == "AGREE":
        return 1.0 - np.abs(a - b)
    if kind == "DISAGREE":
        return np.abs(a - b)
    if kind == "GATE":
        return np.where(a >= float(formula["threshold"]), b, 0.0)
    raise ValueError(kind)

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--formula-count", type=int, default=2000)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--train-months", type=int, default=35)
    ap.add_argument("--validation-months", type=int, default=12)
    ap.add_argument("--holdout-months", type=int, default=12)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    raw = pd.read_csv(args.input)
    required = {"date", "symbol", "fwd_return_20d"}
    missing = sorted(required - set(raw.columns))
    if missing:
        raise SystemExit(f"Missing required columns: {missing}")

    raw["date"] = pd.to_datetime(raw["date"], errors="raise")
    raw["symbol"] = raw["symbol"].astype(str).str.strip().str.upper()
    raw["fwd_return_20d"] = pd.to_numeric(raw["fwd_return_20d"], errors="coerce")

    coverage = {}
    available = []
    for f in BASE_FEATURES:
        if f not in raw.columns:
            continue
        c = float(pd.to_numeric(raw[f], errors="coerce").notna().mean())
        coverage[f] = c
        if c >= 0.20:
            available.append(f)

    if "MOM_20" not in available:
        raise SystemExit("MOM_20 is required for the locked M1 benchmark")
    if len(available) < 3:
        raise SystemExit(f"Need >=3 factors; available={available}")

    # One cross-section per calendar month: use the last trading date in that month.
    raw["month"] = raw["date"].dt.to_period("M")
    last_day = raw.groupby("month")["date"].transform("max")
    df = raw.loc[raw["date"].eq(last_day), ["date", "symbol", "fwd_return_20d", *available]].copy()
    df = df.replace([np.inf, -np.inf], np.nan)
    df = df.dropna(subset=["fwd_return_20d"]).sort_values(["date", "symbol"]).reset_index(drop=True)

    # Drop rows with missing factor values only when a formula uses those factors.
    months = sorted(df["date"].unique())
    if len(months) < args.train_months + args.validation_months + args.holdout_months:
        raise SystemExit("Not enough monthly observations for train/validation/holdout")

    rank_frames: list[np.ndarray] = []
    month_rows: list[np.ndarray] = []
    all_symbols = {s: i for i, s in enumerate(sorted(df["symbol"].unique()))}

    for month in months:
        idx = np.flatnonzero(df["date"].to_numpy() == month)
        g = df.iloc[idx]
        ranks = np.column_stack([
            g[f].rank(pct=True, method="average").to_numpy(dtype=float)
            for f in available
        ])
        good = np.isfinite(ranks).all(axis=1)
        idx = idx[good]
        ranks = ranks[good]
        if len(idx) >= args.k:
            month_rows.append(idx)
            rank_frames.append(ranks)

    months = [months[i] for i in range(len(months)) if i < len(month_rows)]
    if not rank_frames:
        raise SystemExit("No usable monthly cross-sections")
    # The loop above preserves the original order; trim to the number actually retained.
    months = months[: len(rank_frames)]

    formulas = build_formulas(available, args.formula_count)
    (out / "formula_catalog.json").write_text(json.dumps(formulas, indent=2), encoding="utf-8")

    n_formulas = len(formulas)
    n_months = len(rank_frames)
    gross = np.full((n_formulas, n_months), np.nan, dtype=float)
    turnover = np.full((n_formulas, n_months), np.nan, dtype=float)
    prev_sets: list[set[str] | None] = [None] * n_formulas

    factor_map = {f: i for i, f in enumerate(available)}
    fwd = df["fwd_return_20d"].to_numpy(dtype=float)
    symbols = df["symbol"].to_numpy()

    for mi, (idx, rank) in enumerate(zip(month_rows, rank_frames)):
        y = fwd[idx]
        syms = symbols[idx]
        for fi, formula in enumerate(formulas):
            score = eval_formula(formula, rank, factor_map)
            top = np.argpartition(-score, args.k - 1)[: args.k]
            current = set(syms[top].tolist())
            prev = prev_sets[fi]
            tr = 1.0 if prev is None else 1.0 - len(current & prev) / float(args.k)
            gross[fi, mi] = float(np.mean(y[top]))
            turnover[fi, mi] = tr
            prev_sets[fi] = current

    net = gross - turnover * (args.cost_bps / 10000.0)
    train_end = args.train_months
    valid_end = train_end + args.validation_months
    hold_start = valid_end

    train_rows = []
    for fi, formula in enumerate(formulas):
        train = net[fi, :train_end]
        train_rows.append({
            "fi": fi,
            "formula_id": formula["id"],
            "train_geo": geo(train),
            "train_positive": float((train > 0).mean()),
        })
    train_rows.sort(key=lambda x: (-x["train_geo"], -x["train_positive"], x["formula_id"]))
    top50 = train_rows[:50]

    validation_rows = []
    for r in top50:
        val = net[r["fi"], train_end:valid_end]
        validation_rows.append({
            **r,
            "validation_geo": geo(val),
            "validation_positive": float((val > 0).mean()),
            "validation_cumulative": float(np.prod(1 + val) - 1),
        })
    validation_rows.sort(key=lambda x: (-x["validation_geo"], -x["validation_positive"], x["formula_id"]))
    top10 = validation_rows[:10]

    def stress(fi: int) -> dict[str, Any]:
        out_stats = {}
        for bps in (0.0, 20.0, 45.0):
            x = gross[fi, hold_start:] - turnover[fi, hold_start:] * bps / 10000.0
            out_stats[str(int(bps)) + "bps"] = stats(x)
        return out_stats

    final = []
    for r in top10:
        h = net[r["fi"], hold_start:]
        final.append({
            **r,
            "holdout": stats(h),
            "holdout_months_ge_7pct": int((h >= 0.07).sum()),
            "holdout_cost_stress": stress(r["fi"]),
            "formula": formulas[r["fi"]],
        })

    m1 = next(x for x in final if x["formula_id"] == "G0000") if any(
        x["formula_id"] == "G0000" for x in final
    ) else None
    if m1 is None:
        m1_fi = next(r["fi"] for r in train_rows if r["formula_id"] == "G0000")
        m1 = {
            "formula_id": "G0000",
            "train_geo": geo(net[m1_fi, :train_end]),
            "validation": stats(net[m1_fi, train_end:valid_end]),
            "holdout": stats(net[m1_fi, hold_start:]),
            "holdout_months_ge_7pct": int((net[m1_fi, hold_start:] >= 0.07).sum()),
            "holdout_cost_stress": stress(m1_fi),
            "formula": formulas[m1_fi],
        }

    summary = {
        "status": "COMPLETED",
        "engine": "luna-structured-interaction-2000-v1",
        "dataset_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "rows_monthly": int(len(df)),
        "months": int(n_months),
        "period": [str(months[0]), str(months[-1])],
        "formula_count": n_formulas,
        "k": args.k,
        "cost_bps": args.cost_bps,
        "features_used": available,
        "factor_coverage": coverage,
        "split": {
            "train_months": args.train_months,
            "validation_months": args.validation_months,
            "holdout_months": args.holdout_months,
            "selection": "top50 by train -> top10 by validation -> blind holdout",
        },
        "holdout_candidates_ge_7pct": int(sum(x["holdout"]["geometric_monthly_return"] >= 0.07 for x in final)),
        "top10_holdout": final,
        "m1_benchmark": m1,
        "research_warning": (
            "This expansion uses Mendeley SET history and 20-trading-day forward returns. "
            "It is a discovery dataset, not an Apple-to-Apple replacement for the Supabase "
            "M1 925-universe benchmark. Any candidate must be revalidated on the canonical "
            "Supabase dataset before promotion."
        ),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=str))

if __name__ == "__main__":
    main()
