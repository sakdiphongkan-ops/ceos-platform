#!/usr/bin/env python3
"""LUNA sector/industry neutralization diagnostic v1.

Requires point-in-time metadata. The script refuses to manufacture sector labels:
if a sector column exists but no usable availability timestamp exists, the
diagnostic is reported as UNAVAILABLE.

For available PIT metadata it measures the fixed finalist with:
- raw ranking
- sector-demeaned ranking
- sector-balanced top-K portfolio
and reports OOS/holdout performance. No formula is re-selected.
"""

from __future__ import annotations

import argparse
import json
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


def rank_month(d, col):
    return d.groupby("month_end")[col].rank(pct=True, method="average")


def fixed_score(d, formula):
    s = pd.Series(0.0, index=d.index)
    for f, w in formula["terms"]:
        s = s + rank_month(d, f) * float(w)
    if formula.get("kind") == "interaction" and len(formula["terms"]) >= 2:
        a = rank_month(d, formula["terms"][0][0])
        b = rank_month(d, formula["terms"][1][0])
        s = s + 0.50 * (a - 0.5) * (b - 0.5)
    elif formula.get("kind") == "gated" and len(formula["terms"]) >= 2:
        gate = rank_month(d, formula["terms"][0][0]) > 0.55
        s = s.where(gate, s - 0.10)
    return s


def portfolio(d, months, k, cost_bps, score_col, balanced=False, group_col=None):
    prev = set()
    rows = []
    for m in months:
        g = d.loc[d["month_end"].eq(m)].dropna(subset=[score_col, "fwd1"]).copy()
        if len(g) < k:
            continue

        if balanced and group_col:
            groups = [x for x in g[group_col].dropna().astype(str).unique().tolist()]
            if not groups:
                continue
            base = k // len(groups)
            extra = k - base * len(groups)
            picks = []
            for gi, grp in enumerate(sorted(groups)):
                take = base + (1 if gi < extra else 0)
                if take > 0:
                    picks.append(g[g[group_col].astype(str).eq(grp)].nlargest(take, score_col))
            order = pd.concat(picks, ignore_index=False).nlargest(k, score_col)
        else:
            order = g.nlargest(k, score_col)

        if len(order) < k:
            continue

        cur = set(order["symbol"].astype(str))
        gross = float(order["fwd1"].mean())
        turnover = 1.0 if not prev else 1.0 - len(cur & prev) / float(k)
        cost = turnover * cost_bps / 10000.0
        rows.append({"month_end": m, "net_return": gross - cost, "turnover": turnover})
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
    args = ap.parse_args()

    d = pd.read_csv(args.input)
    d["month_end"] = pd.to_datetime(d["month_end"])
    d["symbol"] = d["symbol"].astype(str)

    sector_candidates = ["sector", "sector_code"]
    industry_candidates = ["industry", "industry_code"]
    sector_col = next((c for c in sector_candidates if c in d.columns), None)
    industry_col = next((c for c in industry_candidates if c in d.columns), None)
    availability_candidates = ["sector_available_at", "industry_available_at", "metadata_available_at"]
    availability_col = next((c for c in availability_candidates if c in d.columns), None)

    summary = json.loads(Path(args.search_summary).read_text(encoding="utf-8"))
    catalog = json.loads(Path(args.formula_catalog).read_text(encoding="utf-8"))
    fid = summary["final_formula"]["id"]
    formula = next(x for x in catalog if x["id"] == fid)

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    if sector_col is None and industry_col is None:
        result = {
            "status": "UNAVAILABLE",
            "engine": "luna-sector-industry-neutralization-v1",
            "formula_id": fid,
            "reason": "No sector or industry metadata column exists in the research panel.",
            "required_contract": "sector/industry classification plus point-in-time availability timestamp",
        }
        (out / "sector-neutralization.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        return

    if availability_col is None:
        result = {
            "status": "UNAVAILABLE",
            "engine": "luna-sector-industry-neutralization-v1",
            "formula_id": fid,
            "reason": "Sector/industry exists but no point-in-time availability timestamp was supplied.",
            "required_contract": "sector/industry classification plus point-in-time availability timestamp",
        }
        (out / "sector-neutralization.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        return

    d[availability_col] = pd.to_datetime(d[availability_col], errors="coerce", utc=True)
    month_ts = d["month_end"].dt.tz_localize("UTC")
    bad = d[availability_col].notna() & (d[availability_col] > month_ts)
    if bad.any():
        raise SystemExit(f"point-in-time sector/industry leakage detected: {int(bad.sum())} rows")

    group_col = sector_col or industry_col
    d["group"] = d[group_col].astype("string")
    for c in d.columns:
        if c not in {"symbol", "month_end", "group", sector_col, industry_col, availability_col}:
            d[c] = pd.to_numeric(d[c], errors="coerce")

    d["raw_score"] = fixed_score(d, formula)

    # Cross-sectionally remove the group mean from the rank score, preserving
    # the fixed formula while making the portfolio less group-concentrated.
    d["group_mean"] = d.groupby(["month_end", "group"])["raw_score"].transform("mean")
    d["neutral_score"] = d["raw_score"] - d["group_mean"]

    months = sorted(d["month_end"].dropna().unique().tolist())
    hold_start = pd.Timestamp(summary["holdout_start"])
    hold_end = pd.Timestamp(summary["holdout_end"])
    holdout = [m for m in months if hold_start <= m <= hold_end]
    development = [m for m in months if m < hold_start]

    raw = portfolio(d, months, args.k, args.cost_bps, "raw_score")
    neutral = portfolio(d, months, args.k, args.cost_bps, "neutral_score")
    balanced = portfolio(d, months, args.k, args.cost_bps, "neutral_score", balanced=True, group_col="group")

    result = {
        "status": "COMPLETED",
        "engine": "luna-sector-industry-neutralization-v1",
        "formula_id": fid,
        "metadata_column": group_col,
        "availability_column": availability_col,
        "groups_full_sample": int(d["group"].nunique(dropna=True)),
        "raw": {
            "oos": stats(raw.reindex(development)["net_return"] if len(raw) else []),
            "holdout": stats(raw.reindex(holdout)["net_return"] if len(raw) else []),
        },
        "neutralized": {
            "oos": stats(neutral.reindex(development)["net_return"] if len(neutral) else []),
            "holdout": stats(neutral.reindex(holdout)["net_return"] if len(neutral) else []),
        },
        "balanced": {
            "oos": stats(balanced.reindex(development)["net_return"] if len(balanced) else []),
            "holdout": stats(balanced.reindex(holdout)["net_return"] if len(balanced) else []),
        },
        "interpretation_guard": "Fixed-formula diagnostic only; neutralization and balancing never re-select the formula.",
    }
    (out / "sector-neutralization.json").write_text(
        json.dumps(result, indent=2, default=str, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps(result, indent=2, default=str, ensure_ascii=False))


if __name__ == "__main__":
    main()
