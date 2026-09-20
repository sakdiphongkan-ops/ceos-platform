#!/usr/bin/env python3
"""LUNA monthly adaptive formula search from the public SET/mai daily dataset.

Point-in-time construction:
- Keep the last trading observation for each symbol in each calendar month.
- Forward return is from that month-end observation to the NEXT calendar month's
  month-end observation for the same symbol. Missing months are never treated as 1M.
- 1,000 deterministic signed rank-blend formulas (M1 locked + 999 generated).
- Equal-weight Top-K portfolio, turnover-aware costs.
- Adaptive selection uses only the previous 24 realized months.
- Final 12 months are frozen holdout: candidate ranking is done only on training.
"""

from __future__ import annotations

import argparse, hashlib, json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

FACTORS = [
    "MOM_5","MOM_10","MOM_20","MOM_60","MOM_120",
    "REL_MOM","VOL_10","VOL_20","MAXDD_60","ATR_PCT",
    "ADV20","AMOUNT","RSI14","DIST_MA20","DIST_MA60",
    "BREAKOUT20","BREAKOUT55","SKEW_20","SKEW_60",
]

@dataclass(frozen=True)
class Formula:
    formula_id: str
    terms: tuple[tuple[str, float], ...]

def hash_u32(s: str) -> int:
    h = 2166136261
    for ch in s.encode():
        h ^= ch
        h = (h * 16777619) & 0xffffffff
    return h

def u01(s: str) -> float:
    return hash_u32(s) / 4294967296.0

def geometric(xs: list[float]) -> float:
    x = np.asarray(xs, dtype=float)
    x = x[np.isfinite(x)]
    if x.size == 0 or np.any(x <= -1):
        return -1.0
    return float(np.exp(np.log1p(x).mean()) - 1.0)

def make_formulas(count: int, seed: int) -> list[Formula]:
    out = [Formula("M1_REV_K20", (("MOM_20", -1.0),))]
    for i in range(1, count):
        n = 2 + (hash_u32(f"n|{seed}|{i}") % 3)
        chosen = sorted(
            FACTORS,
            key=lambda f: hash_u32(f"pick|{seed}|{i}|{f}")
        )[:n]
        raw = []
        for f in chosen:
            mag = 0.25 + 0.75 * u01(f"mag|{seed}|{i}|{f}")
            sign = 1.0 if hash_u32(f"sign|{seed}|{i}|{f}") & 1 else -1.0
            raw.append((f, sign * mag))
        denom = sum(abs(w) for _, w in raw)
        out.append(Formula(
            f"F{i:04d}",
            tuple((f, float(w / denom)) for f, w in raw),
        ))
    return out

def perf(xs: list[float], initial: float = 30000.0) -> dict:
    if not xs:
        return {
            "months": 0, "geometric_monthly_return": -1.0,
            "cumulative_return": -1.0, "positive_month_pct": 0.0,
            "min_monthly_return": None, "max_monthly_return": None,
            "max_drawdown_pct": None, "final_baht": None,
        }
    eq = initial
    peak = initial
    mdd = 0.0
    logs = 0.0
    pos = 0
    for r in xs:
        eq *= 1.0 + r
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1.0)
        logs += np.log1p(r)
        pos += int(r > 0)
    return {
        "months": len(xs),
        "geometric_monthly_return": float(np.exp(logs / len(xs)) - 1.0),
        "cumulative_return": float(eq / initial - 1.0),
        "positive_month_pct": float(pos / len(xs)),
        "min_monthly_return": float(min(xs)),
        "max_monthly_return": float(max(xs)),
        "max_drawdown_pct": float(mdd),
        "final_baht": float(eq),
    }

def stress_from_ledger(ledger: pd.DataFrame, bps: float) -> dict:
    xs = (ledger["gross_return"] - ledger["turnover"] * bps / 10000.0).tolist()
    return perf(xs)

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--formula-count", type=int, default=1000)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--lookback-months", type=int, default=24)
    ap.add_argument("--min-history-months", type=int, default=12)
    ap.add_argument("--holdout-months", type=int, default=12)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--seed", type=int, default=20260920)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(args.input)
    required = {"date","symbol","adj_close",*FACTORS}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["date"] = pd.to_datetime(df["date"], errors="raise")
    df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    for f in FACTORS:
        if f not in df.columns:
            df[f] = np.nan
        df[f] = pd.to_numeric(df[f], errors="coerce")

    # Month-end snapshot = final trading observation present for that symbol/month.
    # Triggered from the default branch so GitHub Actions can run the research without secrets.
    df["month"] = df["date"].dt.to_period("M")
    snap = (
        df.sort_values(["symbol","date"])
          .groupby(["symbol","month"], as_index=False)
          .tail(1)
          .sort_values(["month","symbol"])
          .reset_index(drop=True)
    )

    # Strict next-calendar-month forward return.
    price_map = {(r.symbol, r.month): r.adj_close for r in snap.itertuples()}
    fwd = []
    for r in snap.itertuples():
        nxt = r.month + 1
        px = price_map.get((r.symbol, nxt), np.nan)
        fwd.append(px / r.adj_close - 1.0 if np.isfinite(px) and np.isfinite(r.adj_close) and r.adj_close else np.nan)
    snap["fwd1m"] = fwd

    groups = []
    for month, g in snap.groupby("month", sort=True):
        g = g.dropna(subset=["fwd1m", "MOM_20"]).copy()
        if len(g) >= args.k:
            # Cross-sectional ranks are factor-specific; a formula can only use
            # symbols where all of its own terms are present.
            groups.append((month, g))
    if len(groups) < args.lookback_months + args.holdout_months + 1:
        raise SystemExit("not enough contiguous monthly observations")

    months = [m for m, _ in groups]
    ranks = {}
    for month, g in groups:
        ranks[month] = {
            f: g[f].rank(pct=True, method="average").to_numpy(float)
            for f in FACTORS if g[f].notna().any()
        }

    formulas = make_formulas(args.formula_count, args.seed)
    catalog = [
        {"formula_id": f.formula_id, "terms": list(map(list, f.terms))}
        for f in formulas
    ]
    (out / "formula_catalog.json").write_text(
        json.dumps(catalog, indent=2), encoding="utf-8"
    )

    # Candidate monthly portfolios.
    returns: dict[str, pd.DataFrame] = {}
    for formula in formulas:
        rows = []
        prev: set[str] = set()
        for month, g in groups:
            score = np.zeros(len(g), dtype=float)
            valid = np.ones(len(g), dtype=bool)
            for f, w in formula.terms:
                if f not in ranks[month]:
                    valid[:] = False
                    break
                r = ranks[month][f]
                valid &= np.isfinite(r)
                score += np.nan_to_num(r, nan=0.0) * w
            eligible = np.flatnonzero(valid)
            if len(eligible) < args.k:
                rows.append({
                    "month": str(month), "gross_return": 0.0,
                    "turnover": 1.0 if not prev else 0.0,
                    "net_return": 0.0,
                })
                continue
            order = eligible[np.argsort(-score[eligible], kind="mergesort")[:args.k]]
            chosen = g.iloc[order]
            cur = set(chosen["symbol"])
            overlap = len(cur & prev)
            turnover = 1.0 if not prev else 1.0 - overlap / args.k
            gross = float(chosen["fwd1m"].mean())
            rows.append({
                "month": str(month),
                "gross_return": gross,
                "turnover": float(turnover),
                "net_return": gross - turnover * args.cost_bps / 10000.0,
            })
            prev = cur
        returns[formula.formula_id] = pd.DataFrame(rows)

    # Adaptive walk-forward.
    adaptive_rows = []
    for j, month in enumerate(months):
        prior_idx = list(range(max(0, j - args.lookback_months), j))
        if len(prior_idx) < args.min_history_months:
            continue
        scores = []
        for formula in formulas:
            fr = returns[formula.formula_id]
            hist = fr.iloc[prior_idx]["net_return"].dropna().tolist()
            if len(hist) >= args.min_history_months:
                scores.append((geometric(hist), sum(x > 0 for x in hist) / len(hist), formula.formula_id))
        scores.sort(key=lambda z: (-z[0], -z[1], z[2]))
        chosen = scores[0]
        rr = returns[chosen[2]].iloc[j]
        adaptive_rows.append({
            "month": str(month),
            "history_start": str(months[prior_idx[0]]),
            "history_end": str(months[prior_idx[-1]]),
            "formula_id": chosen[2],
            "selected_geo": chosen[0],
            "selected_positive": chosen[1],
            **rr.to_dict(),
        })
    adaptive = pd.DataFrame(adaptive_rows)
    adaptive.to_csv(out / "adaptive_selection_ledger.csv", index=False)

    adaptive_perf = perf(adaptive["net_return"].tolist())
    benchmark_perf = perf(returns["M1_REV_K20"]["net_return"].tolist())
    stress = {str(int(b)): stress_from_ledger(adaptive, b) for b in (0, 10, 20, 30, 45, 60)}

    # Frozen holdout: rank using only months before the last holdout window.
    holdout_start = len(months) - args.holdout_months
    train_idx = list(range(holdout_start))
    frozen_scores = []
    for formula in formulas:
        hist = returns[formula.formula_id].iloc[train_idx]["net_return"].dropna().tolist()
        if len(hist) >= args.min_history_months:
            frozen_scores.append((geometric(hist), sum(x > 0 for x in hist) / len(hist), formula.formula_id))
    frozen_scores.sort(key=lambda z: (-z[0], -z[1], z[2]))
    frozen_top = [x[2] for x in frozen_scores[:25]]
    hold_rows = []
    for fid in frozen_top + ["M1_REV_K20"]:
        fr = returns[fid].iloc[holdout_start:].copy()
        p20 = perf(fr["net_return"].tolist())
        hold_rows.append({
            "formula_id": fid,
            "train_rank": next(i+1 for i,x in enumerate(frozen_scores) if x[2] == fid) if fid in frozen_top else None,
            "train_geometric_monthly": next(x[0] for x in frozen_scores if x[2] == fid) if fid in frozen_top else geometric(returns[fid].iloc[train_idx]["net_return"].tolist()),
            "holdout_geometric_monthly": p20["geometric_monthly_return"],
            "holdout_cumulative_return": p20["cumulative_return"],
            "holdout_positive_month_pct": p20["positive_month_pct"],
            "holdout_max_drawdown_pct": p20["max_drawdown_pct"],
        })
    holdout = pd.DataFrame(hold_rows)
    holdout.to_csv(out / "frozen_holdout_ranked.csv", index=False)

    selection_counts = adaptive["formula_id"].value_counts().head(25).to_dict() if not adaptive.empty else {}
    summary = {
        "status": "COMPLETED",
        "engine": "luna-monthly-adaptive-formula-search-v1",
        "dataset_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "formula_count": len(formulas),
        "formula_seed": args.seed,
        "months_available": len(months),
        "period_start": str(months[0]),
        "period_end": str(months[-1]),
        "k": args.k,
        "lookback_months": args.lookback_months,
        "min_history_months": args.min_history_months,
        "holdout_months": args.holdout_months,
        "cost_bps": args.cost_bps,
        "adaptive": adaptive_perf,
        "benchmark_m1": benchmark_perf,
        "cost_stress": stress,
        "frozen_holdout_top25": hold_rows,
        "adaptive_selection_frequency_top25": selection_counts,
        "hurdle_7pct": {
            "target_geometric_monthly": 0.07,
            "adaptive_months_ge_7pct": int((adaptive["net_return"] >= 0.07).sum()) if len(adaptive) else 0,
            "adaptive_hurdle_pass": bool(adaptive_perf["geometric_monthly_return"] >= 0.07),
        },
        "guards": {
            "monthly_forward_return_requires_next_calendar_month": True,
            "selection_uses_strictly_prior_months": True,
            "holdout_excluded_from_formula_selection": True,
            "m1_locked_benchmark": True,
        },
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
