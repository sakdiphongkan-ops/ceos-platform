#!/usr/bin/env python3
"""Auditable monthly regime/conditional-blend search for LUNA.

The engine uses only current-month features to choose a portfolio held for the
next month. Train/Dev are used for selection; OOS is the first untouched test;
Holdout is computed only for reporting and is never used in selection.

Input columns:
  symbol, month_end, adj_close,
  mom1, mom3, mom6, mom12, high52_ratio, vol20, maxdd60, avg_amount20
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Candidate:
    name: str
    f1: str
    d1: str
    f2: str = ""
    d2: str = ""
    weight: float = 1.0

    def score(self, ranks: dict[str, pd.Series]) -> pd.Series:
        a = ranks[self.f1]
        a = a if self.d1 == "HIGH" else 1.0 - a
        if not self.f2:
            return a
        b = ranks[self.f2]
        b = b if self.d2 == "HIGH" else 1.0 - b
        return self.weight * a + (1.0 - self.weight) * b


def geo(x: pd.Series) -> float:
    x = pd.to_numeric(x, errors="coerce").dropna().astype(float)
    if len(x) == 0 or (x <= -1).any():
        return -1.0
    return float(np.exp(np.log1p(x).mean()) - 1.0)


def metrics(x: pd.Series) -> dict:
    x = pd.to_numeric(x, errors="coerce").dropna().astype(float)
    if len(x) == 0:
        return {"months": 0, "geo": -1.0, "positive": 0.0, "worst": -1.0,
                "max_drawdown": 1.0, "cumulative": -1.0}
    eq = (1.0 + x).cumprod()
    peak = eq.cummax()
    dd = 1.0 - eq / peak
    return {
        "months": int(len(x)),
        "geo": geo(x),
        "positive": float((x > 0).mean()),
        "worst": float(x.min()),
        "max_drawdown": float(dd.max()),
        "cumulative": float(eq.iloc[-1] - 1.0),
    }


def build_candidates(factors: list[str], weights: list[float]) -> list[Candidate]:
    directions = []
    for f in factors:
        # Both tails are explicit hypotheses.
        directions.extend([(f, "LOW"), (f, "HIGH")])

    out: list[Candidate] = []
    for f, d in directions:
        out.append(Candidate(f"{f}_{d}", f, d))
    for i, (f1, d1) in enumerate(directions):
        for f2, d2 in directions[i + 1:]:
            for w in weights:
                out.append(Candidate(
                    f"{f1}_{d1}__{f2}_{d2}__W{w:.2f}",
                    f1, d1, f2, d2, float(w)
                ))
    # Stable de-duplication.
    seen = set()
    ans = []
    for c in out:
        if c.name not in seen:
            ans.append(c)
            seen.add(c.name)
    return ans


def candidate_returns(
    df: pd.DataFrame,
    ranks: dict[str, pd.Series],
    candidate: Candidate,
    k: int,
    cost: float,
) -> pd.Series:
    score = candidate.score(ranks)
    tmp = pd.DataFrame({
        "month_end": df["month_end"].values,
        "score": score.values,
        "fwd1": df["fwd1"].values,
        "symbol": df["symbol"].values,
    })
    tmp = tmp.dropna(subset=["score", "fwd1"])
    tmp = tmp.sort_values(["month_end", "score", "symbol"], ascending=[True, False, True])
    top = tmp.groupby("month_end", sort=True).head(k)
    r = top.groupby("month_end")["fwd1"].mean() - cost
    return r


def regime_series(frame: pd.DataFrame, threshold: float) -> pd.DataFrame:
    m = frame.groupby("month_end").agg(
        breadth1=("mom1", lambda s: float((s > 0).mean())),
        breadth6=("mom6", lambda s: float((s > 0).mean())),
    ).sort_index()
    p1 = m["breadth1"].shift(1).rolling(12, min_periods=12)
    p6 = m["breadth6"].shift(1).rolling(12, min_periods=12)
    z1 = (m["breadth1"] - p1.mean()) / p1.std()
    z6 = (m["breadth6"] - p6.mean()) / p6.std()
    z = 0.5 * z1 + 0.5 * z6
    m["regime"] = np.where(
        z >= threshold, "ON",
        np.where(z <= -threshold, "OFF", "NEUTRAL"),
    )
    return m.reset_index()[["month_end", "regime", "breadth1", "breadth6"]]


def period_mask(months: pd.Series, start: str, end: str) -> pd.Series:
    return (months >= pd.Timestamp(start)) & (months <= pd.Timestamp(end))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--train-end", default="2023-12-01")
    ap.add_argument("--dev-end", default="2024-12-01")
    ap.add_argument("--oos-end", default="2025-12-01")
    ap.add_argument("--holdout-end", default="2026-07-01")
    ap.add_argument("--cost-bps", type=float, default=40.0)
    ap.add_argument("--k-values", default="5,10,20")
    ap.add_argument("--weights", default="0.20,0.35,0.50,0.65,0.80")
    ap.add_argument("--regime-thresholds", default="0.25,0.50,0.75")
    ap.add_argument("--train-pool", type=int, default=40)
    ap.add_argument("--pair-pool", type=int, default=15)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(args.input)
    need = {
        "symbol", "month_end", "adj_close", "mom1", "mom3", "mom6", "mom12",
        "high52_ratio", "vol20", "maxdd60", "avg_amount20",
    }
    missing = sorted(need - set(df.columns))
    if missing:
        raise SystemExit(f"input missing columns: {missing}")

    df["month_end"] = pd.to_datetime(df["month_end"])
    df = df.sort_values(["symbol", "month_end"]).drop_duplicates(
        ["symbol", "month_end"]
    ).reset_index(drop=True)
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    df["fwd1"] = df.groupby("symbol")["adj_close"].shift(-1) / df["adj_close"] - 1.0
    factors = [
        "mom1", "mom3", "mom6", "mom12", "high52_ratio",
        "vol20", "maxdd60", "avg_amount20",
    ]
    for c in factors:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # Percentile rank is calculated using only the same month's available universe.
    ranks = {
        c: df.groupby("month_end")[c].rank(pct=True, method="average")
        for c in factors
    }

    ks = [int(x) for x in args.k_values.split(",") if x.strip()]
    weights = [float(x) for x in args.weights.split(",") if x.strip()]
    thresholds = [float(x) for x in args.regime_thresholds.split(",") if x.strip()]
    candidates = build_candidates(factors, weights)
    cost = args.cost_bps / 10000.0

    rows = []
    series_map: dict[tuple[str, int], pd.Series] = {}
    for c in candidates:
        for k in ks:
            s = candidate_returns(df, ranks, c, k, cost)
            series_map[(c.name, k)] = s
            row = {"candidate": c.name, "k": k}
            for label, lo, hi in [
                ("TRAIN", "1900-01-01", args.train_end),
                ("DEV", f"{pd.Timestamp(args.train_end) + pd.offsets.MonthBegin(1):%Y-%m-%d}", args.dev_end),
                ("OOS", f"{pd.Timestamp(args.dev_end) + pd.offsets.MonthBegin(1):%Y-%m-%d}", args.oos_end),
                ("HOLDOUT", f"{pd.Timestamp(args.oos_end) + pd.offsets.MonthBegin(1):%Y-%m-%d}", args.holdout_end),
            ]:
                mm = metrics(s.loc[period_mask(s.index.to_series(), lo, hi)] if isinstance(s.index, pd.DatetimeIndex) else pd.Series(dtype=float))
                for key, value in mm.items():
                    row[f"{label}_{key}"] = value
            rows.append(row)

    cand_df = pd.DataFrame(rows)
    train_rank = cand_df.sort_values(
        ["TRAIN_geo", "TRAIN_positive", "TRAIN_max_drawdown"],
        ascending=[False, False, True]
    ).head(args.train_pool)
    dev_rank = train_rank.sort_values(
        ["DEV_geo", "DEV_positive", "DEV_max_drawdown"],
        ascending=[False, False, True]
    ).head(args.pair_pool)

    regimes_all = {}
    pair_rows = []
    pair_candidates = [
        (r.candidate, int(r.k))
        for r in dev_rank.itertuples(index=False)
    ]
    for threshold in thresholds:
        reg = regime_series(df, threshold).set_index("month_end")["regime"]
        for on_name, on_k in pair_candidates:
            on_s = series_map[(on_name, on_k)]
            for off_name, off_k in pair_candidates:
                off_s = series_map[(off_name, off_k)]
                months = sorted(set(on_s.index) & set(off_s.index) & set(reg.index))
                base = pd.DataFrame({
                    "on": on_s.reindex(months),
                    "off": off_s.reindex(months),
                    "reg": reg.reindex(months),
                }).dropna()
                for neutral in ("ON", "OFF", "CASH"):
                    ret = np.where(
                        base["reg"].eq("ON"), base["on"],
                        np.where(base["reg"].eq("OFF"), base["off"],
                                 base["on"] if neutral == "ON" else
                                 base["off"] if neutral == "OFF" else 0.0)
                    )
                    s = pd.Series(ret, index=pd.DatetimeIndex(months))
                    row = {
                        "threshold": threshold,
                        "neutral": neutral,
                        "on_candidate": on_name,
                        "on_k": on_k,
                        "off_candidate": off_name,
                        "off_k": off_k,
                    }
                    for label, lo, hi in [
                        ("DEV", f"{pd.Timestamp(args.train_end) + pd.offsets.MonthBegin(1):%Y-%m-%d}", args.dev_end),
                        ("OOS", f"{pd.Timestamp(args.dev_end) + pd.offsets.MonthBegin(1):%Y-%m-%d}", args.oos_end),
                        ("HOLDOUT", f"{pd.Timestamp(args.oos_end) + pd.offsets.MonthBegin(1):%Y-%m-%d}", args.holdout_end),
                    ]:
                        mm = metrics(s.loc[period_mask(s.index.to_series(), lo, hi)])
                        for key, value in mm.items():
                            row[f"{label}_{key}"] = value
                    pair_rows.append(row)

    pairs = pd.DataFrame(pair_rows)
    if not pairs.empty:
        best = pairs.sort_values(
            ["DEV_geo", "DEV_positive", "DEV_max_drawdown"],
            ascending=[False, False, True],
        ).iloc[0].to_dict()
    else:
        best = {}

    # Exact final decision is based on DEV only. OOS/HOLDOUT remain untouched.
    selected = cand_df.sort_values(
        ["DEV_geo", "DEV_positive", "DEV_max_drawdown"],
        ascending=[False, False, True]
    ).iloc[0].to_dict() if not cand_df.empty else {}
    oos_candidates = cand_df[cand_df["candidate"].isin(train_rank["candidate"])].sort_values(
        ["DEV_geo", "DEV_positive"], ascending=[False, False]
    ).head(20)

    selection_count = int(len(candidates) * len(ks) + len(pair_rows))
    summary = {
        "status": "COMPLETED",
        "engine": "luna-monthly-regime-v1",
        "dataset_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "rows": int(len(df)),
        "symbols": int(df.symbol.nunique()),
        "months": int(df.month_end.nunique()),
        "periods": {
            "train_end": args.train_end,
            "dev_end": args.dev_end,
            "oos_end": args.oos_end,
            "holdout_end": args.holdout_end,
        },
        "cost_bps_per_monthly_rebalance": args.cost_bps,
        "candidate_count": int(len(candidates)),
        "candidate_k_configs": int(len(candidates) * len(ks)),
        "conditional_pair_configs": int(len(pair_rows)),
        "multiple_testing_family_size": selection_count,
        "selection_policy": "candidate pool selected from TRAIN, final conditional pair selected from DEV only; OOS and HOLDOUT excluded from selection",
        "oos_hurdle": 0.07,
        "selected_unconditional_from_dev": selected,
        "selected_conditional_from_dev": best,
        "oos_hurdle_pass_unconditional": bool(selected.get("OOS_geo", -1) >= 0.07),
        "oos_hurdle_pass_conditional": bool(best.get("OOS_geo", -1) >= 0.07),
        "holdout_hurdle_pass_conditional": bool(best.get("HOLDOUT_geo", -1) >= 0.07),
        "blind_holdout_note": "Holdout is computed for confirmation only and never affects candidate/rule selection.",
        "m1_comparison_note": "This engine is monthly rebalance/one-month holding. It must not be labeled as the exact daily M1 benchmark."
    }

    cand_df.to_csv(out / "candidate_results.csv", index=False)
    pairs.to_csv(out / "conditional_pairs.csv", index=False)
    Path(out / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    Path(out / "manifest.json").write_text(json.dumps({
        **summary,
        "candidate_definitions": [asdict(c) for c in candidates],
        "regime_definition": "0.5*z(breadth1 vs prior 12m)+0.5*z(breadth6 vs prior 12m); threshold selected on DEV",
    }, indent=2, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
