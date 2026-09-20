#!/usr/bin/env python3
"""LUNA Formula Evolution Lab v1.

Purpose
-------
Evolve promising legacy LUNA rules together with new factor combinations instead
of repeatedly selecting a single best backtest. The engine:

1) builds a point-in-time monthly snapshot from the daily factor dataset;
2) seeds the search with historical LUNA ideas + simple factor hypotheses;
3) mutates those formulas for several generations;
4) selects using TRAIN + DEV only;
5) evaluates frozen finalists on untouched OOS + HOLDOUT;
6) stress-tests K, holding horizon, cost, rebalance anchor, and simple regime overlays;
7) records every tested formula and its lineage for auditability.

The search is deliberately broad but not magical: proprietary/undisclosed
institutional formulas cannot be recovered unless their observable inputs or
described methodology are available in the data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

DEFAULT_FEATURES = [
    "MOM_5", "MOM_10", "MOM_20", "MOM_40", "MOM_60", "MOM_120", "MOM_252",
    "REL_MOM", "VOL_10", "VOL_20", "BETA", "MAXDD_60", "ATR_PCT",
    "ADV20", "AMOUNT", "ILLIQ_20", "RSI14", "DIST_MA20", "DIST_MA60",
    "DIST_HIGH_252", "BREAKOUT20", "BREAKOUT55", "SKEW_20", "SKEW_60",
    "PE", "PBV", "EV_EBITDA", "FCF_YIELD", "EARNINGS_YIELD", "DIV_YIELD",
    "ROE", "ROA", "ROIC", "GPM", "NPM", "CFO_MARGIN", "REV_G", "EPS_G",
    "NI_G", "FCF_G", "ASSET_G", "CAPEX_G", "INVESTMENT_RATE", "DIV_G",
    "PAYOUT", "BUYBACK", "DE", "NET_DEBT_EBITDA", "INTEREST_COVER",
    "CURRENT_RATIO", "QUALITY_SCORE", "VALUE_QUALITY", "MOM_BLEND",
    "CONSERVATIVE_SCORE", "SAFETY_SCORE", "GROWTH_QUALITY", "INV_QUALITY",
]

@dataclass(frozen=True)
class Formula:
    id: str
    parents: tuple[str, ...]
    terms: tuple[tuple[str, float], ...]
    note: str = ""

def stable_hash(s: str) -> int:
    return int(hashlib.sha256(s.encode("utf-8")).hexdigest()[:16], 16)

def normalize_terms(terms: Iterable[tuple[str, float]]) -> tuple[tuple[str, float], ...]:
    d: dict[str, float] = {}
    for f, w in terms:
        d[f] = d.get(f, 0.0) + float(w)
    d = {f: w for f, w in d.items() if abs(w) > 1e-9}
    if not d:
        return tuple()
    den = sum(abs(x) for x in d.values())
    return tuple(sorted((f, w / den) for f, w in d.items()))

def formula_id(terms: tuple[tuple[str, float], ...]) -> str:
    raw = "|".join(f"{f}:{w:.8f}" for f, w in terms)
    return "EV_" + hashlib.sha256(raw.encode()).hexdigest()[:12]

def geo(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0 or np.any(x <= -1):
        return -1.0
    return float(np.exp(np.log1p(x).mean()) - 1.0)

def stats(x: np.ndarray) -> dict:
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return {
            "months": 0, "geo_monthly": -1.0, "cumulative": -1.0,
            "positive_month_pct": 0.0, "max_drawdown": 1.0,
            "worst_month": None, "best_month": None,
            "avg_turnover": None,
        }
    eq = np.cumprod(1.0 + x)
    peak = np.maximum.accumulate(eq)
    dd = 1.0 - eq / peak
    return {
        "months": int(len(x)),
        "geo_monthly": geo(x),
        "cumulative": float(eq[-1] - 1.0),
        "positive_month_pct": float((x > 0).mean()),
        "max_drawdown": float(dd.max()),
        "worst_month": float(x.min()),
        "best_month": float(x.max()),
        "avg_turnover": None,
    }

def calendar_add(month: pd.Timestamp, n: int) -> pd.Timestamp:
    return month + pd.offsets.MonthEnd(n)

def prepare_monthly(path: str, features: list[str]) -> tuple[pd.DataFrame, list[str]]:
    df = pd.read_csv(path)
    if "date" not in df.columns or "symbol" not in df.columns or "adj_close" not in df.columns:
        raise SystemExit("input requires date, symbol, adj_close")
    df["date"] = pd.to_datetime(df["date"], errors="raise")
    df["month_end"] = df["date"].dt.to_period("M").dt.to_timestamp("M")
    df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")

    available = []
    for f in features:
        if f not in df.columns:
            continue
        coverage = pd.to_numeric(df[f], errors="coerce").notna().mean()
        if coverage >= 0.20:
            df[f] = pd.to_numeric(df[f], errors="coerce")
            available.append(f)

    monthly = (
        df.sort_values(["symbol", "date"])
          .groupby(["symbol", "month_end"], as_index=False)
          .tail(1)
          .sort_values(["month_end", "symbol"])
          .reset_index(drop=True)
    )

    # Strict h-month forward returns from monthly snapshot.
    monthly["fwd_1m"] = np.nan
    monthly["fwd_2m"] = np.nan
    monthly["fwd_3m"] = np.nan
    monthly["fwd_6m"] = np.nan
    monthly["fwd_12m"] = np.nan

    maps: dict[tuple[str, pd.Timestamp], float] = {}
    for row in monthly.itertuples(index=False):
        maps[(row.symbol, row.month_end)] = float(row.adj_close) if np.isfinite(row.adj_close) else np.nan

    for i, row in monthly.iterrows():
        px = float(row.adj_close) if np.isfinite(row.adj_close) else np.nan
        if not np.isfinite(px) or px <= 0:
            continue
        for h in (1, 2, 3, 6, 12):
            target = calendar_add(row.month_end, h)
            nxt = maps.get((row.symbol, target), np.nan)
            if np.isfinite(nxt):
                monthly.at[i, f"fwd_{h}m"] = nxt / px - 1.0

    # Cross-sectional ranks computed only within the month.
    for f in available:
        monthly[f"__rank"] = monthly.groupby("month_end")[f].rank(pct=True, method="average")

    return monthly, available

def seed_formulas(available: list[str]) -> list[Formula]:
    def mk(label: str, terms: list[tuple[str, float]], note: str) -> Formula | None:
        terms2 = normalize_terms([(f, w) for f, w in terms if f in available])
        if not terms2:
            return None
        return Formula(formula_id(terms2), tuple(), terms2, f"legacy:{label}; {note}")

    seeds: list[Formula] = []
    candidates = [
        ("M1_REV1_K20", [("MOM_20", -1.0)], "legacy M1-style 1M reversal"),
        ("M2_REV2_K20", [("MOM_40", -1.0)], "2M reversal"),
        ("REV3_K20", [("MOM_60", -1.0)], "3M reversal"),
        ("REV6_K20", [("MOM_120", -1.0)], "6M reversal"),
        ("MOM1_K20", [("MOM_20", 1.0)], "1M momentum"),
        ("MOM6_K20", [("MOM_120", 1.0)], "6M momentum"),
        ("MOM12_K20", [("MOM_252", 1.0)], "12M momentum"),
        ("HIGH52_K20", [("DIST_HIGH_252", -1.0)], "closer to 52W high"),
        ("LOWVOL_K20", [("VOL_20", -1.0)], "low volatility"),
        ("LOWATR_K20", [("ATR_PCT", -1.0)], "low ATR"),
        ("HIGHAMT_K20", [("AMOUNT", 1.0)], "high liquidity"),
        ("LOWILLIQ_K20", [("ILLIQ_20", -1.0)], "low illiquidity"),
        ("REV1_LOWVOL", [("MOM_20", -0.65), ("VOL_20", -0.35)], "reversal + low vol"),
        ("REV1_HIGH52", [("MOM_20", -0.65), ("DIST_HIGH_252", -0.35)], "reversal + high52"),
        ("MOM6_HIGH52_LOWVOL", [("MOM_120", 0.45), ("DIST_HIGH_252", -0.25), ("VOL_20", -0.30)], "legacy S46-like"),
        ("MOM12_HIGH52_LOWVOL", [("MOM_252", 0.45), ("DIST_HIGH_252", -0.25), ("VOL_20", -0.30)], "legacy S48-like"),
        ("REV1_HIGHVOL", [("MOM_20", -0.65), ("VOL_20", 0.35)], "reversal + high vol"),
        ("HIGH52_LOWVOL", [("DIST_HIGH_252", -0.60), ("VOL_20", -0.40)], "trend + defensive"),
        ("MOM_REL_LOWVOL", [("REL_MOM", 0.60), ("VOL_20", -0.40)], "relative momentum + low vol"),
        ("MOM_BREAKOUT", [("MOM_60", 0.55), ("BREAKOUT55", 0.45)], "medium momentum + breakout"),
        ("MEANREV_RSI_LOW", [("RSI14", -0.40), ("MOM_20", -0.60)], "oversold reversal"),
        ("QUALITY_LOWVOL", [("QUALITY_SCORE", 0.60), ("VOL_20", -0.40)], "quality + defensive"),
        ("VALUE_QUALITY_MOM", [("VALUE_QUALITY", 0.40), ("QUALITY_SCORE", 0.30), ("MOM_60", 0.30)], "value-quality + momentum"),
        ("SAFETY_MOM", [("SAFETY_SCORE", 0.55), ("MOM_120", 0.45)], "safety + long momentum"),
        ("GROWTH_QUALITY_MOM", [("GROWTH_QUALITY", 0.55), ("MOM_60", 0.45)], "growth-quality + momentum"),
    ]
    for label, terms, note in candidates:
        f = mk(label, terms, note)
        if f:
            seeds.append(f)
    # Factor/tail probes: both directions are hypotheses, not assumptions.
    for f in available:
        if f in {"symbol", "date"}:
            continue
        for sign in (-1.0, 1.0):
            terms = normalize_terms([(f, sign)])
            seeds.append(Formula(formula_id(terms), tuple(), terms, f"probe:{f}:{sign:+.0f}"))
    uniq = {f.id: f for f in seeds}
    return list(uniq.values())

def mutate(parent: Formula, available: list[str], idx: int, salt: str) -> Formula:
    terms = dict(parent.terms)
    seed = stable_hash(f"{salt}|{parent.id}|{idx}")
    rng = np.random.default_rng(seed)
    factors = list(terms)

    if rng.random() < 0.50 and len(factors) < 4:
        choices = [f for f in available if f not in terms]
        if choices:
            f = choices[int(rng.integers(0, len(choices)))]
            terms[f] = float(rng.choice([-1, 1])) * float(rng.uniform(0.15, 0.70))
    elif rng.random() < 0.80 and factors:
        f = factors[int(rng.integers(0, len(factors)))]
        terms[f] *= float(rng.uniform(0.45, 1.80))
        if abs(terms[f]) < 0.05:
            del terms[f]
    else:
        if factors:
            f = factors[int(rng.integers(0, len(factors)))]
            terms[f] *= -1.0

    if rng.random() < 0.35 and len(terms) > 1:
        f = list(terms)[int(rng.integers(0, len(terms)))]
        del terms[f]

    terms2 = normalize_terms(terms.items())
    if not terms2:
        terms2 = parent.terms
    return Formula(
        id=formula_id(terms2),
        parents=(parent.id,),
        terms=terms2,
        note="mutation",
    )

def evaluate_formula(
    monthly: pd.DataFrame,
    formula: Formula,
    horizon: int,
    k: int,
    cost_bps: float,
    start: str | None = None,
    end: str | None = None,
    anchor: int = 0,
) -> dict:
    if horizon not in (1, 2, 3, 6, 12):
        raise ValueError("unsupported horizon")
    fwd_col = f"fwd_{horizon}m"
    x = monthly.copy()
    if start:
        x = x[x["month_end"] >= pd.Timestamp(start)]
    if end:
        x = x[x["month_end"] <= pd.Timestamp(end)]
    if x.empty:
        return {"months": 0, "geo_monthly": -1.0, "cumulative": -1.0, "positive_month_pct": 0.0,
                "max_drawdown": 1.0, "turnover": np.nan, "months_ge_7pct": 0}

    months = sorted(pd.to_datetime(x["month_end"]).unique())
    chosen_rets: list[float] = []
    turns: list[float] = []
    previous: set[str] = set()

    weight_map = dict(formula.terms)
    rank_cols = {f: f"{f}__rank" for f, _ in formula.terms}

    for mi, month in enumerate(months):
        month_idx = mi
        if (month_idx - anchor) % horizon != 0:
            continue
        g = x[x["month_end"] == month].copy()
        g["score"] = 0.0
        for f, w in formula.terms:
            rc = rank_cols[f]
            g["score"] += w * g[rc]
        g = g.dropna(subset=["score", fwd_col])
        if len(g) < k:
            continue
        g = g.sort_values(["score", "symbol"], ascending=[False, True]).head(k)
        cur = set(g["symbol"])
        overlap = len(cur & previous)
        turnover = 1.0 if not previous else 1.0 - overlap / float(k)
        net = float(g[fwd_col].mean()) - turnover * cost_bps / 10000.0
        chosen_rets.append(net)
        turns.append(turnover)
        previous = cur

    s = np.asarray(chosen_rets, dtype=float)
    out = stats(s)
    out["avg_turnover"] = float(np.mean(turns)) if turns else np.nan
    out["months_ge_7pct"] = int((s >= 0.07).sum()) if len(s) else 0
    return out

def regime_overlay(
    monthly: pd.DataFrame,
    formula: Formula,
    horizon: int,
    k: int,
    cost_bps: float,
    start: str,
    end: str,
    mode: str,
) -> dict:
    base = evaluate_formula(monthly, formula, horizon, k, cost_bps, start, end)
    x = monthly[(monthly["month_end"] >= pd.Timestamp(start)) & (monthly["month_end"] <= pd.Timestamp(end))].copy()
    if x.empty:
        return base

    breadth = x.groupby("month_end")["MOM_20"].apply(lambda s: float((s > 0).mean()))
    vol = x.groupby("month_end")["VOL_20"].median()
    vol_thr = vol.shift(1).rolling(12, min_periods=6).median()
    state = pd.Series("ON", index=breadth.index)
    state[breadth < 0.25] = "OFF"
    if mode == "VOL_GATED":
        state[vol > vol_thr] = "OFF"
    elif mode == "BREADTH_AND_VOL":
        state[(breadth < 0.35) | (vol > vol_thr)] = "OFF"

    # Re-run selected months and apply 50% exposure in OFF; cash receives 0%.
    fwd_col = f"fwd_{horizon}m"
    months = sorted(x["month_end"].unique())
    previous: set[str] = set()
    rets = []
    for mi, month in enumerate(months):
        if mi % horizon != 0:
            continue
        g = x[x["month_end"] == month].copy().dropna(subset=[fwd_col])
        for f, w in formula.terms:
            g["score"] = g.get("score", 0.0) + w * g[f"{f}__rank"]
        if len(g) < k:
            continue
        g = g.sort_values(["score", "symbol"], ascending=[False, True]).head(k)
        cur = set(g["symbol"])
        turnover = 1.0 if not previous else 1.0 - len(cur & previous) / float(k)
        base_ret = float(g[fwd_col].mean()) - turnover * cost_bps / 10000.0
        exposure = 1.0 if state.get(month, "ON") == "ON" else 0.5
        if mode == "CASH_GATED" and state.get(month, "ON") == "OFF":
            exposure = 0.0
        rets.append(base_ret * exposure)
        previous = cur
    return stats(np.asarray(rets, dtype=float))

def score_for_evolution(train: dict, dev: dict) -> float:
    if train["months"] < 12 or dev["months"] < 6:
        return -999.0
    # Reward geometric compounding and consistency, penalize drawdown.
    return (
        0.45 * dev["geo_monthly"]
        + 0.30 * train["geo_monthly"]
        + 0.15 * dev["positive_month_pct"]
        + 0.10 * train["positive_month_pct"]
        - 0.20 * dev["max_drawdown"]
    )

def scenario_grid() -> list[tuple[int, int, float]]:
    return [(k, h, c) for k in (5, 10, 20, 50) for h in (1, 2, 3) for c in (0, 20, 45, 60)]

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--generations", type=int, default=3)
    ap.add_argument("--initial-random", type=int, default=1000)
    ap.add_argument("--mutations-per-generation", type=int, default=1200)
    ap.add_argument("--survivors", type=int, default=40)
    ap.add_argument("--finalists", type=int, default=80)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    monthly, available = prepare_monthly(args.input, DEFAULT_FEATURES)
    if len(available) < 4:
        raise SystemExit(f"Too few usable features: {available}")

    # Fixed temporal split. Final OOS/HOLDOUT are not used during evolution.
    splits = {
        "TRAIN": ("2018-01-31", "2021-12-31"),
        "DEV": ("2022-01-31", "2023-12-31"),
        "OOS": ("2024-01-31", "2024-12-31"),
        "HOLDOUT": ("2025-01-31", "2025-12-31"),
    }

    seeds = seed_formulas(available)

    # deterministic initial random population
    rng = np.random.default_rng(20260920)
    population = list(seeds)
    for i in range(args.initial_random):
        n = int(rng.integers(2, 5))
        fs = rng.choice(available, size=n, replace=False)
        raw = rng.uniform(0.15, 1.0, size=n) * rng.choice([-1.0, 1.0], size=n)
        terms = normalize_terms(zip(fs.tolist(), raw.tolist()))
        population.append(Formula(formula_id(terms), tuple(), terms, "random_seed"))

    population = list({f.id: f for f in population}.values())
    evolution_ledger = []

    for gen in range(args.generations):
        evaluated = []
        for f in population:
            tr = evaluate_formula(monthly, f, 1, 20, 20, *splits["TRAIN"])
            dv = evaluate_formula(monthly, f, 1, 20, 20, *splits["DEV"])
            score = score_for_evolution(tr, dv)
            evaluated.append({
                "generation": gen,
                "formula_id": f.id,
                "parents": list(f.parents),
                "terms": list(f.terms),
                "score": score,
                "train": tr,
                "dev": dv,
            })
        evaluated.sort(key=lambda z: z["score"], reverse=True)
        evolution_ledger.extend(evaluated)

        keep = evaluated[: args.survivors]
        survivors = [next(f for f in population if f.id == r["formula_id"]) for r in keep]

        children: list[Formula] = []
        for i in range(args.mutations_per_generation):
            p = survivors[i % len(survivors)]
            children.append(mutate(p, available, i, f"gen{gen}"))
        # Cross-breed top parents
        for i in range(min(args.mutations_per_generation // 4, len(survivors) * 4)):
            a = survivors[i % len(survivors)]
            b = survivors[(i * 7 + 3) % len(survivors)]
            d = dict(a.terms)
            for f, w in b.terms:
                d[f] = 0.5 * d.get(f, 0.0) + 0.5 * w
            terms = normalize_terms(d.items())
            if terms:
                children.append(Formula(formula_id(terms), (a.id, b.id), terms, "crossover"))
        population = list({f.id: f for f in (survivors + children)}.values())

    # Final frozen candidates are chosen using TRAIN+DEV only.
    latest = [x for x in evolution_ledger if x["generation"] == args.generations - 1]
    latest.sort(key=lambda x: x["score"], reverse=True)
    finalists_meta = latest[: args.finalists]
    formula_map = {f.id: f for f in population}
    for x in finalists_meta:
        if x["formula_id"] not in formula_map:
            formula_map[x["formula_id"]] = next((f for f in seeds if f.id == x["formula_id"]), None)

    final_rows = []
    for item in finalists_meta:
        f = formula_map[item["formula_id"]]
        if f is None:
            continue
        row = {
            "formula_id": f.id,
            "parents": list(f.parents),
            "terms": list(f.terms),
            "dev_score": item["score"],
        }
        for split_name in ("OOS", "HOLDOUT"):
            row[split_name] = evaluate_formula(monthly, f, 1, 20, 20, *splits[split_name])
        final_rows.append(row)

        # Scenario stress on the untouched OOS and HOLDOUT.
        for k, h, cost in scenario_grid():
            for split_name in ("OOS", "HOLDOUT"):
                s0, s1 = splits[split_name]
                m = evaluate_formula(monthly, f, h, k, cost, s0, s1)
                final_rows.append({
                    "formula_id": f.id,
                    "scenario": "BASE",
                    "split": split_name,
                    "k": k,
                    "horizon_months": h,
                    "cost_bps": cost,
                    **m,
                })
                for mode in ("BREADTH_GATED", "CASH_GATED", "BREADTH_AND_VOL"):
                    if h in (1, 2, 3):
                        ov = regime_overlay(monthly, f, h, k, cost, s0, s1, mode)
                        final_rows.append({
                            "formula_id": f.id,
                            "scenario": mode,
                            "split": split_name,
                            "k": k,
                            "horizon_months": h,
                            "cost_bps": cost,
                            **ov,
                        })

    Path(out / "evolution_ledger.json").write_text(
        json.dumps(evolution_ledger, indent=2, default=str),
        encoding="utf-8",
    )
    pd.DataFrame([
        {**x, "train_geo": x["train"]["geo_monthly"], "dev_geo": x["dev"]["geo_monthly"]}
        for x in evolution_ledger
    ]).drop(columns=["train", "dev"], errors="ignore").to_csv(
        out / "evolution_ledger.csv", index=False
    )
    pd.DataFrame(final_rows).to_json(
        out / "final_scenario_results.jsonl", orient="records", lines=True
    )

    # Research queue for currently unavailable factor families.
    research_queue = [
        {"family": "PEAD", "requires": ["available_at", "EPS surprise or standardized unexpected earnings"]},
        {"family": "SUE", "requires": ["quarterly earnings history", "point-in-time announcement dates"]},
        {"family": "Value", "requires": ["PE", "PBV", "FCF_YIELD", "EARNINGS_YIELD"]},
        {"family": "Profitability", "requires": ["ROE", "ROIC", "CFO_MARGIN", "NPM"]},
        {"family": "Investment", "requires": ["ASSET_G", "CAPEX_G", "INVESTMENT_RATE"]},
        {"family": "Quality", "requires": ["ROIC", "INTEREST_COVER", "CURRENT_RATIO", "DE"]},
        {"family": "Trading/Liquidity", "requires": ["AMOUNT", "ADV20", "ILLIQ_20", "TURNOVER"]},
    ]
    missing_families = [q for q in research_queue if any(x not in available for x in q["requires"])]

    summary = {
        "status": "COMPLETED",
        "engine": "luna-formula-evolution-lab-v1",
        "dataset_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "rows": int(len(monthly)),
        "symbols": int(monthly["symbol"].nunique()),
        "months": int(monthly["month_end"].nunique()),
        "available_features": available,
        "population_initial": len(population),
        "generations": args.generations,
        "initial_random": args.initial_random,
        "mutations_per_generation": args.mutations_per_generation,
        "survivors": args.survivors,
        "finalists": len(finalists_meta),
        "selection_uses_only": "TRAIN+DEV",
        "blind_periods": ["OOS", "HOLDOUT"],
        "scenario_count_per_formula": len(scenario_grid()) * 2 * 4,
        "research_queue": missing_families,
        "target_hurdle": {
            "geometric_monthly_return": 0.07,
            "interpretation": "research hurdle, not a guarantee and not an automatic promotion rule",
        },
        "anti_overfit_note": (
            "Final OOS/HOLDOUT are not used in evolution. All scenario stress results "
            "are reported after freezing finalists. Repeated search remains subject to "
            "multiple-testing and data-mining risk."
        ),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    (out / "formula_catalog.json").write_text(
        json.dumps(
            [{"id": f.id, "parents": list(f.parents), "terms": list(f.terms), "note": f.note}
             for f in sorted({**{f.id: f for f in seeds}, **formula_map}.values(), key=lambda z: z.id)],
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
