#!/usr/bin/env python3
"""LUNA direct 1,000-formula search v1.

Designed to reproduce the direct Supabase audit that was run from the
connected database tool. It consumes the same monthly factor CSV exported
from public.luna_research_monthly_price_factors.

Formula generation is deterministic and independent of NumPy RNG:
1 locked M1_REV_K20 alias + 999 FNV-1a hash-seeded 2-4-factor rank blends.
Selection is strict walk-forward: month t uses only the prior 24 months,
with at least 12 months of history. Cost model is turnover * bps.
"""

from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

FACTORS = [
    "mom1", "mom3", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]


def hash32(s: str) -> int:
    h = 2166136261
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def u01(s: str) -> float:
    return hash32(s) / 4294967296.0


def geo(x: np.ndarray | pd.Series) -> float:
    a = np.asarray(x, dtype=float)
    a = a[np.isfinite(a)]
    if len(a) == 0 or np.any(a <= -1):
        return -1.0
    return float(np.exp(np.log1p(a).mean()) - 1.0)


def generate_formulas(n: int) -> list[dict]:
    if n < 1:
        return []
    formulas = [{"id": "M1_REV_K20", "terms": [("mom1", -1.0)]}]
    for i in range(1, n):
        count = 2 + (hash32(f"n|{i}") % 3)
        chosen = sorted(
            FACTORS,
            key=lambda f: hash32(f"sel|{i}|{f}"),
        )[:count]
        raw = []
        for f in chosen:
            magnitude = 0.25 + 0.75 * u01(f"w|{i}|{f}")
            sign = 1.0 if (hash32(f"s|{i}|{f}") & 1) else -1.0
            raw.append((f, magnitude * sign))
        denom = sum(abs(v) for _, v in raw)
        terms = [(f, float(v / denom)) for f, v in raw]
        formulas.append({"id": f"F{i:04d}", "terms": terms})
    return formulas


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--formula-count", type=int, default=1000)
    ap.add_argument("--lookback-months", type=int, default=24)
    ap.add_argument("--min-history-months", type=int, default=12)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--k", type=int, default=20)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.input)
    req = {"symbol", "month_end", "adj_close", *FACTORS}
    missing = sorted(req - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["month_end"] = (
        pd.to_datetime(df["month_end"])
        .dt.to_period("M")
        .dt.to_timestamp("MS")
    )
    df = (
        df.sort_values(["month_end", "symbol"])
        .drop_duplicates(["month_end", "symbol"])
        .reset_index(drop=True)
    )
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")

    df["_next_month"] = df.groupby("symbol")["month_end"].shift(-1)
    df["_next_adj_close"] = df.groupby("symbol")["adj_close"].shift(-1)
    expected = df["month_end"] + pd.DateOffset(months=1)
    df["fwd1"] = np.where(
        df["_next_month"].eq(expected),
        df["_next_adj_close"] / df["adj_close"] - 1.0,
        np.nan,
    )
    df.drop(columns=["_next_month", "_next_adj_close"], inplace=True)

    for f in FACTORS:
        df[f] = pd.to_numeric(df[f], errors="coerce")

    ranks = np.stack(
        [
            df.groupby("month_end")[f]
            .rank(pct=True, method="average")
            .to_numpy()
            for f in FACTORS
        ],
        axis=1,
    )
    valid = (
        np.isfinite(df["fwd1"].to_numpy())
        & np.all(np.isfinite(ranks), axis=1)
    )
    df = df.loc[valid].reset_index(drop=True)
    ranks = ranks[valid]
    y = df["fwd1"].to_numpy(dtype=float)
    months = sorted(df["month_end"].unique())

    formulas = generate_formulas(args.formula_count)
    factor_pos = {f: i for i, f in enumerate(FACTORS)}
    month_arrays = {
        m: np.where(df["month_end"].to_numpy() == m)[0] for m in months
    }

    candidates: dict[str, pd.DataFrame] = {}
    for formula in formulas:
        weights = np.zeros(len(FACTORS))
        for f, w in formula["terms"]:
            weights[factor_pos[f]] = w

        ret = []
        previous: set[str] = set()
        for m in months:
            ix = month_arrays[m]
            score = ranks[ix] @ weights
            order = ix[np.argsort(-score, kind="mergesort")]
            chosen = order[: args.k]
            gross = float(np.nanmean(y[chosen]))
            current = set(df.loc[chosen, "symbol"])
            turnover = (
                1.0 if not previous
                else 1.0 - len(current & previous) / float(args.k)
            )
            cost = turnover * args.cost_bps / 10000.0
            ret.append(
                (
                    m,
                    gross - cost,
                    gross,
                    turnover,
                    cost,
                )
            )
            previous = current

        candidates[formula["id"]] = pd.DataFrame(
            ret,
            columns=[
                "month_end",
                "net_return",
                "gross_return",
                "turnover",
                "cost",
            ],
        ).set_index("month_end")

    ledger = []
    for j, month in enumerate(months):
        history = months[max(0, j - args.lookback_months):j]
        if len(history) < args.min_history_months:
            continue

        eligible = []
        for fid, frame in candidates.items():
            h = frame.reindex(history)["net_return"].dropna()
            if len(h) < args.min_history_months:
                continue
            eligible.append(
                (
                    geo(h),
                    float((h > 0).mean()),
                    fid,
                )
            )
        eligible.sort(key=lambda z: (-z[0], -z[1], z[2]))
        selected_geo, selected_positive, fid = eligible[0]
        rr = candidates[fid].loc[month]
        ledger.append(
            {
                "month_end": month,
                "history_start": history[0],
                "history_end": history[-1],
                "formula_id": fid,
                "selected_geo": selected_geo,
                "selected_positive": selected_positive,
                "gross_return": rr["gross_return"],
                "turnover": rr["turnover"],
                "transaction_cost": rr["cost"],
                "realized_return": rr["net_return"],
            }
        )

    ledger_df = pd.DataFrame(ledger)
    ledger_df.to_csv(out / "selection-ledger.csv", index=False)

    realized = ledger_df["realized_return"].to_numpy(dtype=float)

    def perf(x: np.ndarray) -> dict:
        x = np.asarray(x, dtype=float)
        equity = 30000.0 * np.cumprod(1.0 + x)
        peak = np.maximum.accumulate(equity)
        dd = equity / peak - 1.0
        return {
            "months": int(len(x)),
            "geometric_monthly_return": geo(x),
            "cumulative_return": float(equity[-1] / 30000.0 - 1.0),
            "positive_month_pct": float((x > 0).mean()),
            "min_monthly_return": float(x.min()),
            "max_monthly_return": float(x.max()),
            "max_drawdown_pct": float(dd.min()),
            "final_baht": float(equity[-1]),
        }

    catalog = out / "formula-catalog.json"
    catalog.write_text(json.dumps(formulas, indent=2), encoding="utf-8")

    full_formula_stats = []
    for fid, frame in candidates.items():
        x = frame["net_return"].to_numpy(dtype=float)
        full_formula_stats.append({"id": fid, **perf(x)})
    full_formula_stats.sort(
        key=lambda x: (
            -x["geometric_monthly_return"],
            -x["positive_month_pct"],
            x["id"],
        )
    )

    summary = {
        "status": "COMPLETED",
        "engine": "luna-direct-supabase-1000-v1",
        "dataset_sha256": hashlib.sha256(
            Path(args.input).read_bytes()
        ).hexdigest(),
        "formula_count": len(formulas),
        "k": args.k,
        "cost_bps": args.cost_bps,
        "lookback_months": args.lookback_months,
        "min_history_months": args.min_history_months,
        "period_start": str(months[0].date()),
        "period_end": str(months[-1].date()),
        "months_available": len(months),
        "months_traded": int(len(realized)),
        "adaptive": perf(realized),
        "direct_m1_alias": perf(
            candidates["M1_REV_K20"]["net_return"].to_numpy(dtype=float)
        ),
        "months_ge_7pct": int((realized >= 0.07).sum()),
        "top20_full_period": full_formula_stats[:20],
        "formula_generation": (
            "M1_REV_K20 + 999 FNV-1a hash-seeded 2-4-factor "
            "signed rank blends; stable without NumPy RNG"
        ),
        "leakage_guard": (
            "month t selection uses only strictly earlier months; "
            "forward return requires the next calendar month"
        ),
        "benchmark_warning": (
            "M1_REV_K20 here is the monthly-factor alias, not a claim of "
            "identity with the persisted integer-share 925-universe engine"
        ),
    }
    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
