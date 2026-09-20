#!/usr/bin/env python3
"""LUNA Theory Family Search v1.

Controlled search generated from mechanisms observed in prior LUNA research:
short-term reversal, 52-week position, volatility, drawdown quality,
liquidity, medium/long momentum.

Protocol:
  development -> validation selection -> frozen OOS -> frozen holdout.
Holdout never participates in formula or weight selection.

The search is intentionally hypothesis-family constrained rather than an
unbounded random formula tournament.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd


W = (0.25, 0.50, 0.75, 1.00)
FACTORS = ["MOM_20","MOM_60","MOM_120","VOL_20","MAXDD_60","ADV20","HIGH52_RATIO"]


def geo(x: pd.Series) -> float:
    a = pd.to_numeric(x, errors="coerce").dropna().to_numpy(dtype=float)
    if len(a) == 0 or np.any(a <= -1):
        return -1.0
    return float(np.exp(np.log1p(a).mean()) - 1.0)


def perf(x: pd.Series, initial: float = 30000.0) -> dict:
    a = pd.to_numeric(x, errors="coerce").dropna().to_numpy(dtype=float)
    if len(a) == 0:
        return {
            "months": 0, "geometric_monthly_return": -1.0,
            "cumulative_return": -1.0, "positive_month_pct": 0.0,
            "months_ge_7pct": 0, "max_drawdown_pct": None,
            "final_baht": None,
        }
    eq = initial
    peak = initial
    mdd = 0.0
    pos = 0
    for r in a:
        eq *= 1.0 + r
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1.0)
        pos += int(r > 0)
    return {
        "months": int(len(a)),
        "geometric_monthly_return": geo(pd.Series(a)),
        "cumulative_return": float(eq / initial - 1.0),
        "positive_month_pct": float(pos / len(a)),
        "months_ge_7pct": int((a >= 0.07).sum()),
        "max_drawdown_pct": float(mdd),
        "final_baht": float(eq),
    }


def make_catalog() -> list[dict]:
    out = []
    def add(fid: str, family: str, terms: dict[str, float], interaction: str = "linear"):
        out.append({
            "formula_id": fid,
            "family": family,
            "terms": terms,
            "interaction": interaction,
        })

    add("TF_REV1", "REV1_CORE", {"MOM_20": -1.0})

    for w in W:
        add(f"TF_REV1_LV_{w:.2f}", "REV1_LOWVOL", {"MOM_20": -1.0, "VOL_20": -w})
        add(f"TF_REV1_H52_{w:.2f}", "REV1_HIGH52", {"MOM_20": -1.0, "HIGH52_RATIO": w})
        add(f"TF_REV1_LIQ_{w:.2f}", "REV1_LIQUIDITY", {"MOM_20": -1.0, "ADV20": w})
        add(f"TF_REV1_DD_{w:.2f}", "REV1_DRAWDOWN", {"MOM_20": -1.0, "MAXDD_60": w})

    for a, b in itertools.product(W, W):
        add(
            f"TF_REV1_H52_LV_{a:.2f}_{b:.2f}",
            "REV1_HIGH52_LOWVOL",
            {"MOM_20": -1.0, "HIGH52_RATIO": a, "VOL_20": -b},
        )
        add(
            f"TF_REV1_DD_LV_{a:.2f}_{b:.2f}",
            "REV1_DRAWDOWN_LOWVOL",
            {"MOM_20": -1.0, "MAXDD_60": a, "VOL_20": -b},
        )
        add(
            f"TF_REV1_H52_LIQ_{a:.2f}_{b:.2f}",
            "REV1_HIGH52_LIQUIDITY",
            {"MOM_20": -1.0, "HIGH52_RATIO": a, "ADV20": b},
        )

    for a, b in itertools.product(W, W):
        add(
            f"TF_MOM6_H52_LV_{a:.2f}_{b:.2f}",
            "MOM6_HIGH52_LOWVOL",
            {"MOM_60": 1.0, "HIGH52_RATIO": a, "VOL_20": -b},
        )
        add(
            f"TF_MOM12_H52_LV_{a:.2f}_{b:.2f}",
            "MOM12_HIGH52_LOWVOL",
            {"MOM_120": 1.0, "HIGH52_RATIO": a, "VOL_20": -b},
        )
        add(
            f"TF_MOM6_DD_LV_{a:.2f}_{b:.2f}",
            "MOM6_DRAWDOWN_LOWVOL",
            {"MOM_60": 1.0, "MAXDD_60": a, "VOL_20": -b},
        )

    # Controlled nonlinear interaction: core reversal is amplified when the
    # conditioning factor is favorable. This tests mechanism interaction rather
    # than merely adding another linear factor.
    for w in W:
        add(
            f"TF_REV1_X_LV_{w:.2f}",
            "REV1_X_LOWVOL",
            {"MOM_20": -1.0, "VOL_20": -w},
            interaction="reversal_x_lowvol_rank_gate",
        )
        add(
            f"TF_REV1_X_H52_{w:.2f}",
            "REV1_X_HIGH52",
            {"MOM_20": -1.0, "HIGH52_RATIO": w},
            interaction="reversal_x_high52_rank_gate",
        )

    # Keep catalog deterministic and duplicate-free.
    seen = set()
    uniq = []
    for x in out:
        if x["formula_id"] not in seen:
            uniq.append(x)
            seen.add(x["formula_id"])
    return uniq


def cross_rank(g: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    r = g[cols].rank(pct=True, method="average")
    return r


def portfolio_return(g: pd.DataFrame, formula: dict, k: int, prev: set[str], cost_bps: float) -> tuple[float, float, set[str]]:
    cols = formula["terms"]
    valid = np.ones(len(g), dtype=bool)
    score = np.zeros(len(g), dtype=float)

    # All terms are ranks; unavailable terms exclude a symbol for this formula.
    for f, w in cols.items():
        v = g[f].to_numpy(dtype=float)
        ok = np.isfinite(v)
        valid &= ok
        score += np.nan_to_num(v, nan=0.0) * float(w)

    idx = np.flatnonzero(valid)
    if len(idx) < k:
        return 0.0, 1.0 if prev else 0.0, set()

    order = idx[np.argsort(-score[idx], kind="mergesort")[:k]]
    chosen = g.iloc[order]
    cur = set(chosen["symbol"].astype(str))
    overlap = len(cur & prev)
    turnover = 1.0 if not prev else 1.0 - overlap / k
    gross = float(chosen["fwd1m"].mean())
    return gross - turnover * cost_bps / 10000.0, turnover, cur


def run_formula(snap: pd.DataFrame, months: list, formula: dict, k: int, cost_bps: float) -> pd.DataFrame:
    rows = []
    prev: set[str] = set()
    for month in months:
        g = snap[snap["month"] == month].copy()
        ranked = cross_rank(g, FACTORS)
        for f in FACTORS:
            g[f] = ranked[f].to_numpy()
        net, turnover, prev = portfolio_return(g, formula, k, prev, cost_bps)
        gross = net + turnover * cost_bps / 10000.0
        rows.append({
            "month": str(month),
            "gross_return": gross,
            "turnover": turnover,
            "net_return": net,
        })
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--holdout-months", type=int, default=12)
    ap.add_argument("--top-n", type=int, default=25)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.input)
    req = {"date","symbol","adj_close","MOM_20","MOM_60","MOM_120","VOL_20","MAXDD_60","ADV20"}
    missing = sorted(req - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["date"] = pd.to_datetime(df["date"], errors="raise")
    df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")

    # 52-week position is derived from the already point-in-time adjusted close.
    d = df.sort_values(["symbol","date"]).copy()
    roll = d.groupby("symbol")["adj_close"].rolling(252, min_periods=200).max().reset_index(level=0, drop=True)
    d["HIGH52_RATIO"] = d["adj_close"] / roll

    d["month"] = d["date"].dt.to_period("M")
    snap = (
        d.sort_values(["symbol","date"])
         .groupby(["symbol","month"], as_index=False)
         .tail(1)
         .sort_values(["month","symbol"])
         .reset_index(drop=True)
    )

    price_map = {(r.symbol, r.month): r.adj_close for r in snap.itertuples()}
    fwd = []
    for r in snap.itertuples():
        px = price_map.get((r.symbol, r.month + 1), np.nan)
        fwd.append(px / r.adj_close - 1.0 if np.isfinite(px) and np.isfinite(r.adj_close) and r.adj_close else np.nan)
    snap["fwd1m"] = fwd

    for f in FACTORS:
        snap[f] = pd.to_numeric(snap[f], errors="coerce")

    # Require enough names and a valid forward month.
    groups = []
    for month, g in snap.groupby("month", sort=True):
        g = g.dropna(subset=["fwd1m"]).copy()
        if len(g) >= args.k:
            groups.append((month, g))

    if len(groups) <= args.holdout_months + 24:
        raise SystemExit("not enough monthly observations")

    months = [m for m, _ in groups]
    snap = pd.concat([g for _, g in groups], ignore_index=True)

    catalog = make_catalog()
    (out / "formula_catalog.json").write_text(json.dumps(catalog, indent=2), encoding="utf-8")

    # Evaluate all hypotheses once so all later windows use identical portfolio construction.
    all_returns = {}
    all_turnover = {}
    for formula in catalog:
        fr = run_formula(snap, months, formula, args.k, args.cost_bps)
        all_returns[formula["formula_id"]] = fr
        all_turnover[formula["formula_id"]] = fr["turnover"]

    holdout_start = len(months) - args.holdout_months
    development_end = holdout_start - 12
    validation_start = max(0, int(development_end * 0.65))

    ranking_rows = []
    for formula in catalog:
        fr = all_returns[formula["formula_id"]]
        train = fr.iloc[:validation_start]["net_return"]
        val = fr.iloc[validation_start:development_end]["net_return"]
        ranking_rows.append({
            "formula_id": formula["formula_id"],
            "family": formula["family"],
            "interaction": formula["interaction"],
            "train_geo": geo(train),
            "validation_geo": geo(val),
            "validation_positive_pct": float((val > 0).mean()),
            "validation_max_drawdown": perf(val)["max_drawdown_pct"],
        })
    ranking = pd.DataFrame(ranking_rows).sort_values(
        ["validation_geo","validation_positive_pct"],
        ascending=[False, False]
    ).reset_index(drop=True)
    ranking["validation_rank"] = np.arange(1, len(ranking) + 1)
    ranking.to_csv(out / "validation_ranking.csv", index=False)

    frozen_ids = ranking.head(args.top_n)["formula_id"].tolist()

    frozen_rows = []
    for fid in frozen_ids + ["TF_REV1"]:
        fr = all_returns[fid]
        oos = fr.iloc[development_end:holdout_start]["net_return"]
        hold = fr.iloc[holdout_start:]["net_return"]
        r = ranking.loc[ranking["formula_id"] == fid].iloc[0] if fid in set(ranking["formula_id"]) else None
        frozen_rows.append({
            "formula_id": fid,
            "family": r["family"] if r is not None else "M1_proxy",
            "validation_rank": int(r["validation_rank"]) if r is not None else None,
            "validation_geo": float(r["validation_geo"]) if r is not None else None,
            "oos_geo": geo(oos),
            "oos_cumulative": float(np.prod(1.0 + oos.to_numpy(dtype=float)) - 1.0),
            "oos_positive_pct": float((oos > 0).mean()),
            "holdout_geo": geo(hold),
            "holdout_cumulative": float(np.prod(1.0 + hold.to_numpy(dtype=float)) - 1.0),
            "holdout_positive_pct": float((hold > 0).mean()),
            "holdout_max_drawdown": perf(hold)["max_drawdown_pct"],
        })
    frozen = pd.DataFrame(frozen_rows)
    frozen.to_csv(out / "frozen_oos_holdout.csv", index=False)

    # Stress the validation-selected top 10 on transaction costs and K.
    stress_rows = []
    selected10 = frozen_ids[:10]
    for fid in selected10 + ["TF_REV1"]:
        base_formula = next(x for x in catalog if x["formula_id"] == fid)
        for k in (10, 20, 50):
            for bps in (0, 20, 45, 60):
                fr = run_formula(snap, months, base_formula, k, bps)
                hold = fr.iloc[holdout_start:]["net_return"]
                stress_rows.append({
                    "formula_id": fid,
                    "k": k,
                    "cost_bps": bps,
                    **perf(hold),
                })
    pd.DataFrame(stress_rows).to_csv(out / "holdout_stress.csv", index=False)

    summary = {
        "status": "COMPLETED",
        "engine": "luna-theory-family-search-v1",
        "dataset_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "formula_count": len(catalog),
        "families": sorted({x["family"] for x in catalog}),
        "period_start": str(months[0]),
        "period_end": str(months[-1]),
        "development_months": int(development_end),
        "validation_months": int(development_end - validation_start),
        "oos_months": int(holdout_start - development_end),
        "holdout_months": int(args.holdout_months),
        "top_n_frozen": int(args.top_n),
        "k": int(args.k),
        "cost_bps": float(args.cost_bps),
        "target_geometric_monthly": 0.07,
        "top_validation": ranking.head(15).to_dict(orient="records"),
        "frozen_oos_holdout": frozen.to_dict(orient="records"),
        "guards": {
            "validation_is_used_for_formula_selection": True,
            "oos_is_frozen": True,
            "holdout_is_excluded_from_selection": True,
            "forward_return_requires_next_calendar_month": True,
            "search_space_is_theory_family_constrained": True,
            "m1_proxy_locked": "TF_REV1",
        },
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
