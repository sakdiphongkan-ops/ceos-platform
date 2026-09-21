#!/usr/bin/env python3
"""LUNA factor-source tournament v1.

Apple-to-apple comparison of:
- technical-only
- fundamental-only
- hybrid technical + fundamental

Each available track uses the same universe, seed, formula count, K, costs,
nested walk-forward split, and frozen holdout. Tracks with unavailable PIT
fundamentals are reported UNAVAILABLE rather than silently substituting zeros.

The tournament never compares a full-period winner. It reports development,
outer-OOS, frozen-holdout, and generalization-gap evidence for each track.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import luna_failure_driven_search_v1 as engine


TECHNICAL = [
    "REV21","MOM_5","MOM_10","MOM_20","MOM_40","MOM_60","MOM_120","MOM_252",
    "REL_MOM","VOL_10","VOL_20","MAXDD_60","ATR_PCT","ADV20","AMOUNT",
    "ILLIQ_20","BREAKOUT20","BREAKOUT55","RSI14","DIST_MA20","DIST_MA60",
    "DIST_HIGH_252","SKEW_20","SKEW_60"
]

FUNDAMENTAL = [
    "PE","PBV","EV_EBITDA","FCF_YIELD","EARNINGS_YIELD","DIV_YIELD",
    "ROE","ROA","ROIC","GPM","NPM","CFO_MARGIN","REV_G","EPS_G","NI_G","FCF_G",
    "ASSET_G","CAPEX_G","INVESTMENT_RATE","DIV_G","PAYOUT","BUYBACK","DE",
    "NET_DEBT_EBITDA","INTEREST_COVER","CURRENT_RATIO","TURNOVER",
    "QUALITY_SCORE","VALUE_QUALITY","CONSERVATIVE_SCORE","SAFETY_SCORE",
    "GROWTH_QUALITY","INV_QUALITY"
]


def run_track(
    d: pd.DataFrame,
    mode: str,
    seed: int,
    formula_count: int,
    k: int,
    cost_bps: float,
    lookback: int,
    inner_train: int,
    inner_valid: int,
    holdout_months: int,
    min_history: int,
    interaction_strength: float,
    gate_threshold: float,
    gate_penalty: float,
    diversity_penalty: float,
) -> dict:
    coverage = {f: float(d[f].notna().mean()) for f in TECHNICAL + FUNDAMENTAL}

    if mode == "technical":
        requested = TECHNICAL
    elif mode == "fundamental":
        requested = FUNDAMENTAL
    elif mode == "hybrid":
        requested = TECHNICAL + FUNDAMENTAL
    else:
        raise ValueError(mode)

    factors = [f for f in requested if coverage.get(f, 0.0) >= 0.50]
    missing = [f for f in requested if f not in factors]

    if mode == "fundamental" and len(factors) == 0:
        return {
            "status": "UNAVAILABLE",
            "mode": mode,
            "reason": "No fundamental factors reach the 50% coverage threshold in the PIT panel.",
            "coverage": {f: coverage.get(f, 0.0) for f in FUNDAMENTAL},
        }
    if mode == "hybrid" and len([f for f in factors if f in FUNDAMENTAL]) == 0:
        return {
            "status": "UNAVAILABLE",
            "mode": mode,
            "reason": "No PIT fundamental factor reaches the 50% coverage threshold; hybrid track is not silently reduced to technical-only.",
            "coverage": {f: coverage.get(f, 0.0) for f in FUNDAMENTAL},
        }
    if "REV21" not in factors:
        return {
            "status": "UNAVAILABLE",
            "mode": mode,
            "reason": "REV21 benchmark-proxy factor unavailable.",
        }

    args = SimpleNamespace(
        interaction_strength=interaction_strength,
        gate_threshold=gate_threshold,
        gate_penalty=gate_penalty,
    )
    engine.ARGS = args

    x = d[["symbol","month_end","adj_close","fwd1",*factors]].copy()
    x = x.sort_values(["month_end","symbol"]).drop_duplicates(
        ["month_end","symbol"]
    ).reset_index(drop=True)

    months = sorted(x["month_end"].dropna().unique().tolist())
    if len(months) < holdout_months + lookback + inner_valid + 3:
        return {
            "status": "UNAVAILABLE",
            "mode": mode,
            "reason": "Insufficient monthly history for the locked tournament split.",
            "months_available": len(months),
        }

    rows = {m: x.index[x["month_end"].eq(m)].to_numpy() for m in months}
    ranks = engine.rank_matrix(x, factors)
    formulas = engine.make_catalog(formula_count, seed, factors)

    candidates = {}
    for fml in formulas:
        candidates[fml["id"]] = engine.formula_returns(
            x, months, rows, ranks, fml, k, cost_bps
        )

    holdout = months[-holdout_months:]
    development = months[:-holdout_months]
    outer_ledger = []

    for j, m in enumerate(development):
        prior = development[max(0, j - lookback):j]
        if len(prior) < inner_train + inner_valid:
            continue
        train = prior[-(inner_train + inner_valid):-inner_valid]
        valid = prior[-inner_valid:]
        best, _ = engine.select_best(
            candidates, train, valid, min_history, diversity_penalty
        )
        if best is None or m not in candidates[best[4]].index:
            continue
        fid = best[4]
        realized = candidates[fid].loc[m]
        outer_ledger.append({
            "month_end": m,
            "formula_id": fid,
            "realized_return": float(realized.net_return),
            "valid_geo": float(best[1]),
            "valid_pos": float(best[2]),
            "valid_dd": float(best[3]),
        })

    prior = development[-lookback:]
    train = prior[-(inner_train + inner_valid):-inner_valid]
    valid = prior[-inner_valid:]
    final_best, board = engine.select_best(
        candidates, train, valid, min_history, diversity_penalty
    )
    if final_best is None:
        return {
            "status": "UNAVAILABLE",
            "mode": mode,
            "reason": "No candidate survived locked nested selection.",
            "factors": factors,
        }

    final_id = final_best[4]
    final_fr = candidates[final_id]

    train_stats = engine.stats(final_fr.reindex(train).dropna().net_return)
    valid_stats = engine.stats(final_fr.reindex(valid).dropna().net_return)
    oos_stats = engine.stats(
        pd.Series([r["realized_return"] for r in outer_ledger])
    )
    holdout_stats = engine.stats(final_fr.reindex(holdout).dropna().net_return)

    generalization = {
        "validation_to_holdout_geo_gap": (
            float(valid_stats["geo"] - holdout_stats["geo"])
            if valid_stats["months"] and holdout_stats["months"] else None
        ),
        "oos_to_holdout_geo_gap": (
            float(oos_stats["geo"] - holdout_stats["geo"])
            if oos_stats["months"] and holdout_stats["months"] else None
        ),
    }

    fundamental_used = bool(set(factors) & set(FUNDAMENTAL))
    return {
        "status": "COMPLETED",
        "mode": mode,
        "seed": seed,
        "formula_count": formula_count,
        "k": k,
        "cost_bps": cost_bps,
        "factors": factors,
        "missing_requested_factors": missing,
        "fundamental_factor_count": len(set(factors) & set(FUNDAMENTAL)),
        "technical_factor_count": len(set(factors) & set(TECHNICAL)),
        "fundamental_factors_used": fundamental_used,
        "final_formula": next(f for f in formulas if f["id"] == final_id),
        "final_selection": list(final_best[:4]),
        "train": train_stats,
        "validation": valid_stats,
        "outer_oos": oos_stats,
        "frozen_holdout": holdout_stats,
        "generalization_gap": generalization,
        "selection_board_top20": [
            {
                "objective": float(r[0]),
                "valid_geo": float(r[1]),
                "valid_pos": float(r[2]),
                "valid_dd": float(r[3]),
                "formula_id": r[4],
            }
            for r in board[:20]
        ],
        "holdout_rule": "final formula fixed before frozen holdout; no holdout selection",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--benchmark", required=False)
    ap.add_argument("--output", required=True)
    ap.add_argument("--formula-count", type=int, default=5000)
    ap.add_argument("--seed", type=int, default=20260921)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20)
    ap.add_argument("--lookback-months", type=int, default=24)
    ap.add_argument("--inner-train-months", type=int, default=12)
    ap.add_argument("--inner-valid-months", type=int, default=6)
    ap.add_argument("--outer-holdout-months", type=int, default=12)
    ap.add_argument("--min-history-months", type=int, default=9)
    ap.add_argument("--interaction-strength", type=float, default=0.50)
    ap.add_argument("--gate-threshold", type=float, default=0.55)
    ap.add_argument("--gate-penalty", type=float, default=0.10)
    ap.add_argument("--diversity-penalty", type=float, default=0.10)
    args = ap.parse_args()

    d = pd.read_csv(args.input)
    d["month_end"] = pd.to_datetime(d["month_end"])
    d["symbol"] = d["symbol"].astype(str)
    for c in set(TECHNICAL + FUNDAMENTAL + ["adj_close","fwd1"]):
        if c in d.columns:
            d[c] = pd.to_numeric(d[c], errors="coerce")

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    tracks = []
    for mode in ["technical", "fundamental", "hybrid"]:
        result = run_track(
            d=d,
            mode=mode,
            seed=args.seed,
            formula_count=args.formula_count,
            k=args.k,
            cost_bps=args.cost_bps,
            lookback=args.lookback_months,
            inner_train=args.inner_train_months,
            inner_valid=args.inner_valid_months,
            holdout_months=args.outer_holdout_months,
            min_history=args.min_history_months,
            interaction_strength=args.interaction_strength,
            gate_threshold=args.gate_threshold,
            gate_penalty=args.gate_penalty,
            diversity_penalty=args.diversity_penalty,
        )
        tracks.append(result)

    completed = [x for x in tracks if x["status"] == "COMPLETED"]

    # Descriptive only: no global winner/ranking is emitted. The purpose is to
    # expose evidence and overfit diagnostics under identical experimental rules.
    result = {
        "status": "COMPLETED",
        "engine": "luna-factor-source-tournament-v1",
        "experimental_contract": {
            "same_seed": args.seed,
            "same_formula_count": args.formula_count,
            "same_k": args.k,
            "same_cost_bps": args.cost_bps,
            "same_walk_forward": {
                "lookback_months": args.lookback_months,
                "inner_train_months": args.inner_train_months,
                "inner_valid_months": args.inner_valid_months,
                "outer_holdout_months": args.outer_holdout_months,
            },
            "same_frozen_holdout": True,
            "formula_reselection_per_track": True,
            "holdout_used_for_selection": False,
        },
        "benchmark": str(args.benchmark) if args.benchmark else None,
        "tracks": tracks,
        "interpretation_guard": (
            "Descriptive experiment only. No track is declared a winner, and "
            "UNAVAILABLE fundamentals are never replaced by technical factors."
        ),
        "available_track_count": len(completed),
    }

    (out / "factor-source-tournament.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
