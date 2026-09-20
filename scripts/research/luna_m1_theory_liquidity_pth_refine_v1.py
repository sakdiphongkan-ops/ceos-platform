#!/usr/bin/env python3
"""LUNA M1 theory lab v2: liquidity/PTH conditioning.

Locked evaluation rules:
- monthly rebalance
- equal-weight top K=20
- next-calendar-month forward return
- transaction-cost stress 20/40/60 bps
- M1_REV_K20 permanent benchmark

Candidate selection uses TRAIN+DEV only. OOS/HOLDOUT are frozen.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Candidate:
    code: str
    rev_w: float
    liq_w: float
    pth_w: float
    interaction: bool
    style: str
    amount_floor: float
    pth_focus: bool
    transform: str = "LINEAR"
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
    eq = np.cumprod(1.0 + x)
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1.0
    return {
        "months": int(x.size),
        "geo_monthly": geo(x),
        "cumulative": float(eq[-1] - 1.0),
        "positive_month_pct": float(np.mean(x > 0)),
        "worst_month": float(np.min(x)),
        "best_month": float(np.max(x)),
        "max_drawdown_pct": float(np.min(dd)),
    }


def make_candidates(k: int) -> list[Candidate]:
    out = [Candidate("M1_REV_K20", 1.0, 0.0, 0.0, False, "SAFE", 0.0, False, "LINEAR", k)]
    idx = 0
    # Focused refinement around the promising contrarian-liquidity/PTH region.
    for liq_w in (0.10, 0.15, 0.20, 0.25, 0.30):
        for pth_w in (0.05, 0.10, 0.15):
            rev_w = 1.0 - liq_w - pth_w
            if rev_w <= 0:
                continue
            for transform in ("LINEAR", "CONTRA_CONVEX", "PTH_CONVEX"):
                for interaction in (False, True):
                    idx += 1
                    out.append(Candidate(
                        f"RF{idx:03d}_{transform}_I{int(interaction)}",
                        rev_w, liq_w, pth_w,
                        interaction,
                        "CONTRARIAN",
                        0.0,
                        False,
                        transform,
                        k
                    ))
    return out


def load_and_prepare(path: str):
    df = pd.read_csv(path)
    need = {"symbol", "month_end", "adj_close", "mom1", "high52_ratio", "avg_amount20"}
    missing = sorted(need - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["month_end"] = pd.to_datetime(df["month_end"])
    df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    for c in ["adj_close", "mom1", "high52_ratio", "avg_amount20"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df = (
        df.sort_values(["month_end", "symbol"])
          .drop_duplicates(["month_end", "symbol"])
          .reset_index(drop=True)
    )
    df["next_month"] = df.groupby("symbol")["month_end"].shift(-1)
    df["next_price"] = df.groupby("symbol")["adj_close"].shift(-1)
    expected = df["month_end"] + pd.offsets.MonthEnd(1)
    df["fwd1"] = np.where(
        df["next_month"].eq(expected),
        df["next_price"] / df["adj_close"] - 1.0,
        np.nan,
    )

    # Precompute the exact cross-sectional ranks once.
    r_mom = df.groupby("month_end")["mom1"].rank(pct=True, method="average").to_numpy()
    r_pth = df.groupby("month_end")["high52_ratio"].rank(pct=True, method="average").to_numpy()
    r_lq = df.groupby("month_end")["avg_amount20"].rank(pct=True, method="average").to_numpy()

    months = np.sort(df["month_end"].dropna().unique())
    groups = {m: g.index.to_numpy() for m, g in df.groupby("month_end", sort=True)}

    return (
        df,
        months,
        groups,
        1.0 - r_mom,
        1.0 - r_pth,
        r_lq,
        df["fwd1"].to_numpy(dtype=float),
        df["symbol"].to_numpy(),
    )


def candidate_returns(prep, c: Candidate):
    df, months, groups, rev, pth, r_lq, fwd, symbols = prep
    liq = r_lq if c.style == "SAFE" else 1.0 - r_lq
    if c.transform == "CONTRA_CONVEX":
        liq = np.power(np.clip(liq, 0.0, 1.0), 1.5)
    if c.transform == "PTH_CONVEX":
        pth = np.power(np.clip(pth, 0.0, 1.0), 1.5)
    score = c.rev_w * rev + c.liq_w * liq + c.pth_w * pth
    if c.interaction:
        score = score + 0.25 * rev * liq
    if c.pth_focus:
        score = score + 0.15 * rev * pth

    out_months = []
    gross = []
    turnover = []
    previous = set()

    for month in months:
        ix = groups[month]
        ok = np.isfinite(score[ix]) & np.isfinite(fwd[ix])
        if c.amount_floor > 0:
            ok &= r_lq[ix] >= c.amount_floor
        ix = ix[ok]
        if ix.size == 0:
            continue

        take = min(c.k, ix.size)
        if take == ix.size:
            chosen = ix
        else:
            part = np.argpartition(-score[ix], take - 1)[:take]
            chosen = ix[part]
            # Stable deterministic ordering only for audit/turnover set construction.
            chosen = chosen[np.argsort(-score[chosen], kind="mergesort")]

        cur = set(symbols[chosen].tolist())
        t = 1.0 if not previous else 1.0 - len(cur & previous) / float(c.k)
        previous = cur

        out_months.append(month)
        gross.append(float(np.mean(fwd[chosen])))
        turnover.append(float(t))

    return (
        np.asarray(out_months),
        np.asarray(gross, dtype=float),
        np.asarray(turnover, dtype=float),
    )


def period_mask(months: np.ndarray, start: str, end: str) -> np.ndarray:
    d = pd.to_datetime(months)
    return (d >= pd.Timestamp(start)) & (d <= pd.Timestamp(end))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--costs", default="20,40,60")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    prep = load_and_prepare(args.input)
    df = prep[0]
    candidates = make_candidates(args.k)
    costs = [float(z) for z in args.costs.split(",")]

    rows = []
    catalog = []

    for c in candidates:
        catalog.append(c.__dict__)
        months, gross, turnover = candidate_returns(prep, c)

        for bps in costs:
            net = gross - turnover * (bps / 10000.0)
            row = {"candidate": c.code, "bps": bps, "regime": "LIQUIDITY_PTH"}

            for label, start, end in [
                ("TRAIN_DEV", "2021-10-31", "2024-12-31"),
                ("OOS", "2025-01-31", "2025-12-31"),
                ("HOLDOUT", "2026-01-31", "2026-12-31"),
            ]:
                x = net[period_mask(months, start, end)]
                p = perf(x)
                row.update({f"{label}_{k}": v for k, v in p.items()})
            rows.append(row)

    result = pd.DataFrame(rows)
    result.to_csv(out / "candidate_results.csv", index=False)
    (out / "candidate_catalog.json").write_text(
        json.dumps(catalog, indent=2), encoding="utf-8"
    )

    ref = costs[0]
    stress = costs[-1]

    ref_df = result[result["bps"] == ref].set_index("candidate")
    stress_df = result[result["bps"] == stress].set_index("candidate")

    robust = pd.DataFrame(index=ref_df.index)
    robust["train_dev_geo_ref"] = ref_df["TRAIN_DEV_geo_monthly"]
    robust["train_dev_geo_stress"] = stress_df["TRAIN_DEV_geo_monthly"]
    robust["train_dev_geo_worst"] = robust[
        ["train_dev_geo_ref", "train_dev_geo_stress"]
    ].min(axis=1)
    robust["train_dev_dd_ref"] = ref_df["TRAIN_DEV_max_drawdown_pct"]
    robust["train_dev_positive_ref"] = ref_df["TRAIN_DEV_positive_month_pct"]
    robust["robust_score"] = (
        robust["train_dev_geo_worst"]
        - 0.25 * robust["train_dev_dd_ref"].abs()
    )
    robust = robust.sort_values(
        ["robust_score", "train_dev_positive_ref", "train_dev_geo_ref"],
        ascending=[False, False, False],
    )
    robust.to_csv(out / "robust_ranking.csv")

    chosen = str(robust.index[0])
    chosen20 = result[
        (result["candidate"] == chosen) & (result["bps"] == ref)
    ].iloc[0].to_dict()
    m1 = result[
        (result["candidate"] == "M1_REV_K20") & (result["bps"] == ref)
    ].iloc[0].to_dict()

    summary = {
        "status": "COMPLETED",
        "engine": "luna-m1-theory-liquidity-pth-refine-v1",
        "data_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "universe_rows": int(len(df)),
        "universe_symbols": int(df["symbol"].nunique()),
        "candidate_count": int(len(candidates)),
        "k": int(args.k),
        "costs_bps": costs,
        "selection": "TRAIN+DEV only; OOS/HOLDOUT frozen",
        "search_scope": "contrarian liquidity + 52-week-high focused weight refinement; linear and convex transforms",
        "selected_candidate": chosen20,
        "m1_baseline": m1,
        "delta_selected_vs_m1": {
            "OOS_geo_monthly": float(
                chosen20["OOS_geo_monthly"] - m1["OOS_geo_monthly"]
            ),
            "HOLDOUT_geo_monthly": float(
                chosen20["HOLDOUT_geo_monthly"] - m1["HOLDOUT_geo_monthly"]
            ),
            "HOLDOUT_cumulative": float(
                chosen20["HOLDOUT_cumulative"] - m1["HOLDOUT_cumulative"]
            ),
        },
        "hurdle": {
            "target_geometric_monthly_return": 0.07,
            "selected_oos_pass": bool(chosen20["OOS_geo_monthly"] >= 0.07),
            "selected_holdout_pass": bool(chosen20["HOLDOUT_geo_monthly"] >= 0.07),
            "m1_oos_pass": bool(m1["OOS_geo_monthly"] >= 0.07),
            "m1_holdout_pass": bool(m1["HOLDOUT_geo_monthly"] >= 0.07),
        },
        "promotion_rule": (
            "Promote only if frozen HOLDOUT improves versus M1 and remains "
            "positive at stress cost; no live deployment in this research job."
        ),
    }

    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
