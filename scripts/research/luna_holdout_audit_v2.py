#!/usr/bin/env python3
"""Frozen holdout audit for LUNA tournament v3 catalogs.

Formula ranking is performed on training months only. The final holdout is never
used to rank formulas. Factor names are inferred from the catalog, so sparse
factors can be excluded by the upstream tournament without breaking the audit.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def geo(x):
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if len(x) == 0 or np.any(x <= -1):
        return -1.0
    return float(np.expm1(np.log1p(x).mean()))


def evaluate(df, formula, months, k, cost_bps, factors):
    weights = {f: float(w) for f, w in formula["terms"]}
    ranks = {
        f: df.groupby("month_end")[f].rank(
            pct=True, method="average"
        ).to_numpy()
        for f in factors
    }

    out = []
    prev = set()

    for m in months:
        mask = df["month_end"].eq(m).to_numpy()
        ix = np.flatnonzero(mask)
        if len(ix) == 0:
            continue

        score = np.zeros(len(ix), dtype=float)
        finite = np.ones(len(ix), dtype=bool)
        for f, w in weights.items():
            x = ranks[f][ix]
            finite &= np.isfinite(x)
            score += x * w

        fwd = pd.to_numeric(df["fwd1"].iloc[ix], errors="coerce").to_numpy()
        finite &= np.isfinite(fwd)
        if not finite.any():
            continue

        valid_ix = ix[finite]
        valid_score = score[finite]
        valid_fwd = fwd[finite]
        order = np.argsort(-valid_score, kind="mergesort")[:k]
        chosen_ix = valid_ix[order]
        chosen_fwd = valid_fwd[order]

        cur = set(df["symbol"].iloc[chosen_ix].astype(str))
        overlap = len(cur & prev)
        turnover = 1.0 if not prev else 1.0 - overlap / float(k)
        cost = turnover * cost_bps / 10000.0
        gross = float(np.mean(chosen_fwd))
        net = gross - cost

        out.append({
            "month_end": m,
            "net_return": net,
            "gross_return": gross,
            "turnover": turnover,
            "cost": cost,
        })
        prev = cur

    if not out:
        return pd.DataFrame(
            columns=["net_return", "gross_return", "turnover", "cost"]
        )
    return pd.DataFrame(out).set_index("month_end")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--holdout-months", type=int, default=12)
    ap.add_argument("--top-n", type=int, default=25)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--benchmark-id", default="M1_REV21_K20")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.input)
    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    required = {"symbol", "month_end", "adj_close"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["symbol"] = df["symbol"].astype(str)
    df["month_end"] = pd.to_datetime(df["month_end"])
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    for col in df.columns:
        if col not in {"symbol", "month_end"}:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.sort_values(["month_end", "symbol"]).drop_duplicates(
        ["month_end", "symbol"]
    ).reset_index(drop=True)

    # Recompute strict next-calendar-month return from month-end snapshots.
    df["_next_month"] = df.groupby("symbol")["month_end"].shift(-1)
    df["_next_adj_close"] = df.groupby("symbol")["adj_close"].shift(-1)
    expected = df["month_end"] + pd.offsets.MonthEnd(1)
    df["fwd1"] = np.where(
        df["_next_month"].eq(expected),
        df["_next_adj_close"] / df["adj_close"] - 1.0,
        np.nan,
    )
    df.drop(columns=["_next_month", "_next_adj_close"], inplace=True)

    factors = sorted({
        term[0]
        for formula in catalog
        for term in formula.get("terms", [])
        if term[0] in df.columns
    })
    if args.benchmark_id not in {f["id"] for f in catalog}:
        raise SystemExit(f"benchmark formula {args.benchmark_id} missing from catalog")
    factors = [f for f in factors if float(df[f].notna().mean()) >= 0.20]
    if not factors:
        raise SystemExit("no factors with >=20% coverage")

    months = sorted(df["month_end"].dropna().unique())
    if len(months) <= args.holdout_months + 12:
        raise SystemExit("not enough months for training and holdout")

    train_months = months[:-args.holdout_months]
    holdout_months = months[-args.holdout_months:]

    # Only formulas whose factors are available can participate.
    available_set = set(factors)
    formulas = [
        f for f in catalog
        if all(t[0] in available_set for t in f.get("terms", []))
    ]
    if args.benchmark_id not in {f["id"] for f in formulas}:
        raise SystemExit("benchmark is not evaluable with available factors")

    train_scores = []
    for formula in formulas:
        fr = evaluate(df, formula, train_months, args.k, args.cost_bps, factors)
        r = fr["net_return"].dropna()
        train_scores.append((
            geo(r),
            float((r > 0).mean()) if len(r) else 0.0,
            formula["id"],
        ))
    train_scores.sort(key=lambda x: (-x[0], -x[1], x[2]))
    selected_scores = train_scores[:args.top_n]
    selected_ids = {x[2] for x in selected_scores}
    by_id = {f["id"]: f for f in formulas}

    rows = []
    for rank, (tr_geo, tr_pos, fid) in enumerate(selected_scores, 1):
        h = evaluate(
            df, by_id[fid], holdout_months, args.k, args.cost_bps, factors
        )
        r = h["net_return"].dropna()
        eq = np.cumprod(1.0 + r.to_numpy()) if len(r) else np.array([])
        dd = (
            float((eq / np.maximum.accumulate(eq) - 1.0).min())
            if len(eq) else None
        )
        rows.append({
            "training_rank": rank,
            "formula_id": fid,
            "training_geometric_monthly": tr_geo,
            "training_positive_pct": tr_pos,
            "holdout_geometric_monthly": geo(r),
            "holdout_cumulative": float(eq[-1] - 1.0) if len(eq) else -1.0,
            "holdout_positive_pct": float((r > 0).mean()) if len(r) else 0.0,
            "holdout_months_ge_7pct": int((r >= 0.07).sum()) if len(r) else 0,
            "holdout_max_drawdown_pct": dd,
            "holdout_avg_turnover": float(h["turnover"].mean()) if len(h) else 0.0,
        })

    result = pd.DataFrame(rows)
    if len(result):
        result = result.sort_values(
            ["training_rank"], ascending=[True]
        )
    result.to_csv(out / "holdout_ranked.csv", index=False)

    benchmark = by_id[args.benchmark_id]
    b_train = evaluate(
        df, benchmark, train_months, args.k, args.cost_bps, factors
    )["net_return"].dropna()
    b_hold = evaluate(
        df, benchmark, holdout_months, args.k, args.cost_bps, factors
    )["net_return"].dropna()

    rank1 = next(
        (r for r in rows if r["training_rank"] == 1), None
    )
    diagnostic = (
        result.iloc[result["holdout_geometric_monthly"].argmax()].to_dict()
        if len(result) else None
    )

    summary = {
        "status": "COMPLETED",
        "engine": "luna-holdout-audit-v2",
        "total_months": len(months),
        "training_months": len(train_months),
        "holdout_months": len(holdout_months),
        "training_end": str(train_months[-1]),
        "holdout_start": str(holdout_months[0]),
        "top_n_frozen": args.top_n,
        "k": args.k,
        "cost_bps": args.cost_bps,
        "catalog_formulas": len(catalog),
        "evaluable_formulas": len(formulas),
        "available_factors": factors,
        "rank1_frozen_candidate_holdout": rank1,
        "highest_holdout_diagnostic_only": diagnostic,
        "benchmark_id": args.benchmark_id,
        "benchmark_training_geometric_monthly": geo(b_train),
        "benchmark_holdout_geometric_monthly": geo(b_hold),
        "benchmark_holdout_cumulative": float(np.prod(1.0 + b_hold) - 1.0) if len(b_hold) else -1.0,
        "selection_guard": "training ranking is frozen before the holdout; holdout returns are never used for ranking or promotion",
    }

    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
