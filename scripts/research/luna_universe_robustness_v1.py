#!/usr/bin/env python3
"""LUNA universe robustness diagnostic v1.

Evaluates a fixed finalist under liquidity/price/universe perturbations without
re-selecting the formula. Frozen holdout is evaluated only after the formula is
fixed by the search summary.

The "current_survivor_only" scenario is explicitly a survivorship-bias stress
and is not treated as a production-quality universe.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd


def geo(x):
    a = np.asarray(x, dtype=float)
    a = a[np.isfinite(a)]
    if len(a) == 0 or np.any(a <= -1):
        return -1.0
    return float(np.expm1(np.log1p(a).mean()))


def stats(x):
    a = np.asarray(x, dtype=float)
    a = a[np.isfinite(a)]
    if len(a) == 0:
        return {"months": 0, "geo": -1.0, "cum": -1.0, "pos": 0.0, "dd": None}
    eq = np.cumprod(1 + a)
    peak = np.maximum.accumulate(eq)
    return {
        "months": int(len(a)),
        "geo": geo(a),
        "cum": float(eq[-1] - 1),
        "pos": float((a > 0).mean()),
        "dd": float((eq / peak - 1).min()),
    }


def rank_series(d, col, group_col="month_end"):
    return d.groupby(group_col)[col].rank(pct=True, method="average")


def formula_score(d, formula):
    s = pd.Series(0.0, index=d.index)
    for f, w in formula["terms"]:
        if f not in d:
            raise SystemExit(f"missing factor: {f}")
        s = s + rank_series(d, f) * float(w)
    kind = formula.get("kind", "blend")
    if kind == "interaction" and len(formula["terms"]) >= 2:
        a = rank_series(d, formula["terms"][0][0])
        b = rank_series(d, formula["terms"][1][0])
        s = s + 0.50 * (a - 0.5) * (b - 0.5)
    elif kind == "gated" and len(formula["terms"]) >= 2:
        gate = rank_series(d, formula["terms"][0][0]) > 0.55
        s = s.where(gate, s - 0.10)
    return s


def portfolio(d, months, formula, k, cost_bps, scenario, seed=None):
    x = d.copy()
    x["score"] = formula_score(x, formula)
    prev = set()
    rows = []

    rng = np.random.default_rng(seed) if seed is not None else None
    survivor_set = None
    if scenario == "current_survivor_only":
        last_month = max(months)
        survivor_set = set(
            x.loc[x["month_end"].eq(last_month), "symbol"].astype(str)
        )

    for m in months:
        g = x.loc[x["month_end"].eq(m)].copy()
        g = g.dropna(subset=["score", "fwd1"])
        if scenario == "current_survivor_only" and survivor_set is not None:
            g = g[g["symbol"].astype(str).isin(survivor_set)]

        if scenario.startswith("adv_top_"):
            keep_frac = float(scenario.split("_")[-1])
            adv = pd.to_numeric(g.get("ADV20"), errors="coerce")
            if adv.notna().any():
                cutoff = adv.quantile(1.0 - keep_frac)
                g = g[adv >= cutoff]

        if scenario.startswith("price_floor_"):
            floor = float(scenario.split("_")[-1])
            px = pd.to_numeric(g["adj_close"], errors="coerce")
            g = g[px >= floor]

        if scenario.startswith("random_dropout_") and rng is not None:
            keep_frac = float(scenario.split("_")[-1])
            syms = g["symbol"].astype(str).unique()
            n = max(k, int(math.floor(len(syms) * keep_frac))) if len(syms) else 0
            if n and n < len(syms):
                kept = set(rng.choice(syms, size=n, replace=False).tolist())
                g = g[g["symbol"].astype(str).isin(kept)]

        if len(g) < k:
            continue

        order = g.sort_values("score", ascending=False, kind="mergesort").head(k)
        cur = set(order["symbol"].astype(str))
        gross = float(order["fwd1"].mean())
        turnover = 1.0 if not prev else 1.0 - len(cur & prev) / float(k)
        cost = turnover * cost_bps / 10000.0
        rows.append(
            {
                "month_end": m,
                "gross_return": gross,
                "net_return": gross - cost,
                "turnover": turnover,
                "cost": cost,
                "eligible_n": int(len(g)),
            }
        )
        prev = cur

    return pd.DataFrame(rows).set_index("month_end") if rows else pd.DataFrame()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--search-summary", required=True)
    ap.add_argument("--formula-catalog", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20)
    ap.add_argument("--random-replicates", type=int, default=20)
    ap.add_argument("--random-seeds", default="20260931,20260932,20260933")
    args = ap.parse_args()

    d = pd.read_csv(args.input)
    d["month_end"] = pd.to_datetime(d["month_end"])
    d["symbol"] = d["symbol"].astype(str)
    for c in d.columns:
        if c not in {"symbol", "month_end"}:
            d[c] = pd.to_numeric(d[c], errors="coerce")

    summary = json.loads(Path(args.search_summary).read_text(encoding="utf-8"))
    catalog = json.loads(Path(args.formula_catalog).read_text(encoding="utf-8"))
    fid = summary["final_formula"]["id"]
    formula = next(x for x in catalog if x["id"] == fid)

    months = sorted(d["month_end"].dropna().unique().tolist())
    hold_start = pd.Timestamp(summary["holdout_start"])
    hold_end = pd.Timestamp(summary["holdout_end"])
    holdout = [m for m in months if hold_start <= m <= hold_end]

    scenarios = [
        "baseline",
        "adv_top_0.95",
        "adv_top_0.90",
        "adv_top_0.80",
        "price_floor_1",
        "price_floor_5",
        "price_floor_10",
        "current_survivor_only",
    ]

    results = []
    for scenario in scenarios:
        fr = portfolio(d, months, formula, args.k, args.cost_bps, scenario)
        h = fr.reindex(holdout).dropna() if len(fr) else pd.DataFrame()
        oos_months = [m for m in months if m < hold_start]
        o = fr.reindex(oos_months).dropna() if len(fr) else pd.DataFrame()
        results.append({
            "scenario": scenario,
            "full_period": stats(fr["net_return"] if len(fr) else []),
            "development_oos": stats(o["net_return"] if len(o) else []),
            "frozen_holdout": stats(h["net_return"] if len(h) else []),
            "available": bool(len(fr)),
        })

    seeds = [int(x.strip()) for x in args.random_seeds.split(",") if x.strip()]
    random = []
    for seed in seeds[:args.random_replicates]:
        fr = portfolio(d, months, formula, args.k, args.cost_bps, "random_dropout_0.80", seed=seed)
        h = fr.reindex(holdout).dropna() if len(fr) else pd.DataFrame()
        random.append({
            "seed": seed,
            "frozen_holdout": stats(h["net_return"] if len(h) else []),
        })

    result = {
        "status": "COMPLETED",
        "engine": "luna-universe-robustness-v1",
        "formula_id": fid,
        "formula": formula,
        "frozen_holdout_start": str(hold_start.date()),
        "frozen_holdout_end": str(hold_end.date()),
        "scenarios": results,
        "random_dropout": {
            "keep_fraction": 0.80,
            "replicates": random,
            "median_holdout_geo": float(np.median([x["frozen_holdout"]["geo"] for x in random])) if random else None,
            "positive_replicate_fraction": float(np.mean([x["frozen_holdout"]["geo"] > 0 for x in random])) if random else None,
        },
        "survivorship_proxy": {
            "method": "current_survivor_only",
            "warning": "This is an explicit survivorship-bias stress, not an unbiased production universe.",
        },
        "interpretation_guard": "Fixed-formula diagnostic only; no scenario is used to re-select or tune the formula.",
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    (out / "universe-robustness.json").write_text(
        json.dumps(result, indent=2, default=str, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps(result, indent=2, default=str, ensure_ascii=False))


if __name__ == "__main__":
    main()
