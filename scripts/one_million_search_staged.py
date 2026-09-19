#!/usr/bin/env python3
"""Development-split, auditable search of up to one million deterministic hypotheses with a blind holdout.

Phase 1 screens every generated rule with a fast, point-in-time proxy on the
last screen_days of a development-only window with cross-sectional coverage checks. Phase 2 runs exact walk-forward OOS + locked holdout
evaluation on the deterministic top-N finalists.

This avoids pretending that 1M rules x millions of rows can be brute-forced
with a naive Python loop while still testing every hypothesis quantitatively.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import heapq
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

FEATURES = [
    "PE", "PBV", "EV_EBITDA", "FCF_YIELD", "EARNINGS_YIELD", "DIV_YIELD",
    "ROE", "ROA", "ROIC", "GPM", "NPM", "CFO_MARGIN",
    "REV_G", "EPS_G", "NI_G", "FCF_G",
    "MOM_5", "MOM_10", "MOM_20", "MOM_60", "MOM_120", "REL_MOM",
    "VOL_10", "VOL_20", "BETA", "MAXDD_60", "ATR_PCT",
    "ADV20", "TURNOVER", "AMOUNT",
    "ASSET_G", "CAPEX_G", "INVESTMENT_RATE",
    "DIV_G", "PAYOUT", "BUYBACK",
    "DE", "NET_DEBT_EBITDA", "INTEREST_COVER", "CURRENT_RATIO",
    "RSI14", "DIST_MA20", "DIST_MA60", "BREAKOUT20", "BREAKOUT55",
]


@dataclass(frozen=True)
class Rule:
    feature: str
    direction: str
    quantile: float
    op: str
    feature2: str = ""
    direction2: str = ""
    quantile2: float = 0.0
    weight: float = 0.5

    @property
    def id(self) -> str:
        raw = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode()).hexdigest()[:16]


def generate_rules(features: list[str], max_trials: int):
    qs = (0.05, 0.10, 0.20, 0.30, 0.40)
    base = [
        Rule(f, d, q, "single")
        for f in features
        for q in qs
        for d in ("top", "bottom")
    ]
    emitted = 0
    for r in base:
        yield r
        emitted += 1
        if emitted >= max_trials:
            return
    for i, a in enumerate(base):
        for b in base[i + 1:]:
            for op in ("and", "or"):
                yield Rule(
                    a.feature, a.direction, a.quantile, op,
                    b.feature, b.direction, b.quantile,
                )
                emitted += 1
                if emitted >= max_trials:
                    return
    weights = np.linspace(0.01, 0.99, 141)
    for a in base:
        for b in base:
            if a.feature == b.feature:
                continue
            for w in weights:
                yield Rule(
                    a.feature, a.direction, a.quantile, "blend",
                    b.feature, b.direction, b.quantile, float(w),
                )
                emitted += 1
                if emitted >= max_trials:
                    return


def signal_from_rank(rank: pd.Series, direction: str, q: float) -> np.ndarray:
    x = pd.to_numeric(rank, errors="coerce").to_numpy(dtype=np.float32, na_value=np.nan)
    if direction == "top":
        return np.maximum(x - (1.0 - q), 0.0) / q
    return np.maximum(q - x, 0.0) / q


def covariance_score(signal: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    m = np.isfinite(signal) & np.isfinite(y)
    if m.sum() < 20:
        return 0.0, 0.0, 0.0
    s = signal[m].astype(np.float64)
    r = y[m].astype(np.float64)
    s_mean = float(s.mean())
    r_mean = float(r.mean())
    s0 = s - s_mean
    r0 = r - r_mean
    std = float(s0.std(ddof=1))
    if not np.isfinite(std) or std <= 0:
        return 0.0, 0.0, 0.0
    cov = float(np.mean(s0 * r0))
    corr_proxy = cov / (std * max(float(r0.std(ddof=1)), 1e-12))
    return cov, std, corr_proxy


def build_screen_stats(
    df: pd.DataFrame,
    features: list[str],
    development_end_idx: int,
    screen_days: int,
    holdout_days: int,
    purge_days: int,
    min_names_per_day: int,
) -> dict[tuple[str, str, float], tuple[float, float, float]]:
    dates = sorted(df["date"].unique())
    screen_end = development_end_idx - purge_days
    if screen_end <= 0 or len(dates) <= development_end_idx + holdout_days + purge_days:
        raise ValueError("Not enough dates for development/OOS/holdout/purge")
    end = screen_end
    start = max(0, end - screen_days)
    screen_dates = set(dates[start:end])
    s = df[df["date"].isin(screen_dates)].copy()
    daily_counts = s.groupby("date")["symbol"].transform("count")
    s = s.loc[daily_counts >= min_names_per_day].copy()
    valid_screen_dates = s["date"].nunique()
    if valid_screen_dates < min(screen_days, max(30, screen_days // 2)):
        raise ValueError(
            f"Insufficient screen coverage: {valid_screen_dates} valid days "
            f"with >= {min_names_per_day} names"
        )
    y = s["fwd_return"].to_numpy(dtype=np.float64)
    stats = {}
    for f in features:
        ranks = s.groupby("date")[f].rank(pct=True, method="average")
        for direction in ("top", "bottom"):
            for q in (0.05, 0.10, 0.20, 0.30, 0.40):
                sig = signal_from_rank(ranks, direction, q)
                stats[(f, direction, q)] = covariance_score(sig, y)
    return stats


def proxy_for_rule(
    rule: Rule,
    stats: dict[tuple[str, str, float], tuple[float, float, float]],
) -> float:
    a = stats[(rule.feature, rule.direction, rule.quantile)]
    if rule.op == "single":
        return a[2]
    b = stats[(rule.feature2, rule.direction2, rule.quantile2)]
    w = 0.5 if rule.op in ("and", "or") else rule.weight
    cov = w * a[0] + (1.0 - w) * b[0]
    # Conservative denominator: ignores positive/negative covariance between
    # the two signals, so the proxy is a ranking device, not a return estimate.
    std = w * a[1] + (1.0 - w) * b[1]
    return float(cov / max(std, 1e-12))


def prepare_exact_frame(df: pd.DataFrame, features: list[str]) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray, list, np.ndarray, np.ndarray]:
    x = df.sort_values(["date", "symbol"]).reset_index(drop=True)
    dates = x["date"].drop_duplicates().tolist()
    day_ids = pd.Categorical(x["date"], categories=dates, ordered=True).codes.astype(np.int32)
    starts = np.flatnonzero(np.r_[True, day_ids[1:] != day_ids[:-1]])
    ends = np.r_[starts[1:], len(x)]
    ranks = {}
    for f in features:
        ranks[f] = (
            x.groupby("date")[f]
            .rank(pct=True, method="average")
            .to_numpy(dtype=np.float32, na_value=np.nan)
        )
    rets = pd.to_numeric(x["fwd_return"], errors="coerce").to_numpy(dtype=np.float64, na_value=np.nan)
    return ranks, rets, day_ids, dates, starts.astype(np.int64), ends.astype(np.int64)


def daily_metrics(daily: np.ndarray, counts: np.ndarray, cost: float) -> dict:
    valid = np.isfinite(daily) & (counts > 0)
    x = daily[valid] - cost
    if x.size == 0:
        return {
            "trades": 0, "return": 0.0, "win_rate": 0.0,
            "profit_factor": 0.0, "max_drawdown": 1.0, "avg_names": 0.0,
            "mean_daily": 0.0, "std_daily": 0.0, "t_stat": 0.0,
        }
    equity = np.cumprod(1.0 + x)
    peak = np.maximum.accumulate(equity)
    dd = 1.0 - equity / peak
    gains = x[x > 0].sum()
    losses = -x[x < 0].sum()
    mean = float(x.mean())
    std = float(x.std(ddof=1)) if x.size > 1 else 0.0
    return {
        "trades": int(x.size),
        "return": float(equity[-1] - 1.0),
        "win_rate": float((x > 0).mean()),
        "profit_factor": float(gains / losses) if losses > 0 else float("inf"),
        "max_drawdown": float(dd.max()),
        "avg_names": float(counts[valid].mean()),
        "mean_daily": mean,
        "std_daily": std,
        "t_stat": float(mean / (std / np.sqrt(x.size))) if std > 0 else 0.0,
    }


def exact_period(
    rule: Rule,
    ranks: dict[str, np.ndarray],
    rets: np.ndarray,
    day_ids: np.ndarray,
    starts: np.ndarray,
    ends: np.ndarray,
    day_start: int,
    day_end: int,
    cost: float,
) -> tuple[np.ndarray, np.ndarray]:
    out_len = day_end - day_start
    daily = np.full(out_len, np.nan, dtype=np.float64)
    counts = np.zeros(out_len, dtype=np.int32)

    def selected(a: np.ndarray, b: np.ndarray | None, op: str) -> np.ndarray:
        if b is None:
            return a
        if op == "and":
            return a & b
        return a | b

    if rule.op != "blend":
        a_rank = ranks[rule.feature]
        a = (a_rank >= (1.0 - rule.quantile)) if rule.direction == "top" else (a_rank <= rule.quantile)
        b = None
        if rule.op in ("and", "or"):
            b_rank = ranks[rule.feature2]
            b = (b_rank >= (1.0 - rule.quantile2)) if rule.direction2 == "top" else (b_rank <= rule.quantile2)
        mask = selected(a, b, rule.op)
        mask &= np.isfinite(rets)
        idx = day_ids[mask]
        wt = rets[mask]
        sums = np.bincount(idx, weights=wt, minlength=len(starts))
        cnts = np.bincount(idx, minlength=len(starts))
        sl = slice(day_start, day_end)
        cnt = cnts[sl]
        sm = sums[sl]
        good = cnt > 0
        daily[good] = sm[good] / cnt[good] - cost
        counts[:] = cnt.astype(np.int32)
        return daily, counts

    a_rank = ranks[rule.feature]
    b_rank = ranks[rule.feature2]
    for d in range(day_start, day_end):
        lo, hi = int(starts[d]), int(ends[d])
        sa = a_rank[lo:hi]
        sb = b_rank[lo:hi]
        score = rule.weight * (
            sa if rule.direction == "top" else 1.0 - sa
        ) + (1.0 - rule.weight) * (
            sb if rule.direction2 == "top" else 1.0 - sb
        )
        valid = np.isfinite(score) & np.isfinite(rets[lo:hi])
        if not valid.any():
            continue
        threshold = float(np.nanquantile(score[valid], 1.0 - min(rule.quantile, rule.quantile2)))
        m = valid & (score >= threshold)
        if m.any():
            daily[d - day_start] = float(rets[lo:hi][m].mean()) - cost
            counts[d - day_start] = int(m.sum())
    return daily, counts


def exact_walk_forward(
    rule: Rule,
    ranks: dict[str, np.ndarray],
    rets: np.ndarray,
    day_ids: np.ndarray,
    dates: list,
    starts: np.ndarray,
    ends: np.ndarray,
    development_end_idx: int,
    oos_days: int,
    holdout_days: int,
    purge_days: int,
    cost_bps: float,
) -> dict:
    n_days = len(dates)
    if n_days <= development_end_idx + oos_days + holdout_days + purge_days:
        raise ValueError("Not enough dates for development/OOS/holdout/purge windows")
    holdout_start = n_days - holdout_days
    oos_end_limit = holdout_start - purge_days
    n_folds = (oos_end_limit - development_end_idx) // oos_days
    oos_start = development_end_idx
    oos_end = development_end_idx + n_folds * oos_days

    oos_daily, oos_counts = exact_period(
        rule, ranks, rets, day_ids, starts, ends, oos_start, oos_end, cost_bps / 10000.0
    )
    hold_daily, hold_counts = exact_period(
        rule, ranks, rets, day_ids, starts, ends, n_days - holdout_days, n_days, cost_bps / 10000.0
    )

    folds = []
    for i in range(n_folds):
        lo, hi = i * oos_days, (i + 1) * oos_days
        m = daily_metrics(oos_daily[lo:hi], oos_counts[lo:hi], 0.0)
        folds.append({
            "train_return": None,
            **{f"oos_{k}": v for k, v in m.items()},
        })

    all_oos = daily_metrics(oos_daily, oos_counts, 0.0)
    hold = daily_metrics(hold_daily, hold_counts, 0.0)
    positive = [f["oos_return"] for f in folds if f["oos_trades"] > 0]

    return {
        "folds": n_folds,
        "oos_trades": int(sum(f["oos_trades"] for f in folds)),
        "oos_return_sum": float(sum(positive)),
        "oos_positive_folds": int(sum(x > 0 for x in positive)),
        "oos_max_drawdown_max": float(max([f["oos_max_drawdown"] for f in folds], default=1.0)),
        "oos_profit_factor_mean": float(np.mean([
            f["oos_profit_factor"] for f in folds if np.isfinite(f["oos_profit_factor"])
        ] or [0.0])),
        "oos_return": float(all_oos["return"]),
        "oos_t_stat": float(all_oos["t_stat"]),
        "holdout_return": float(hold["return"]),
        "holdout_trades": int(hold["trades"]),
        "holdout_t_stat": float(hold["t_stat"]),
        "folds_detail": folds,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--max-trials", type=int, default=1_000_000)
    ap.add_argument("--finalists", type=int, default=200)
    ap.add_argument("--screen-days", type=int, default=120)
    ap.add_argument("--development-fraction", type=float, default=0.60)
    ap.add_argument("--min-names-per-day", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=45.0)
    ap.add_argument("--oos-days", type=int, default=20)
    ap.add_argument("--holdout-days", type=int, default=40)
    ap.add_argument("--purge-days", type=int, default=1)
    ap.add_argument("--min-trades", type=int, default=30)
    ap.add_argument("--min-positive-fold-fraction", type=float, default=0.50)
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    required = {"date", "symbol", "fwd_return"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"Missing columns: {sorted(missing)}")
    df["date"] = pd.to_datetime(df["date"], errors="raise").dt.date
    df = df.replace([np.inf, -np.inf], np.nan).sort_values(["date", "symbol"]).reset_index(drop=True)
    available = [f for f in FEATURES if f in df.columns]
    if len(available) < 3:
        raise SystemExit("Need at least 3 recognized factor columns.")

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    dates = sorted(df["date"].unique())
    development_end_idx = int(len(dates) * args.development_fraction)
    if development_end_idx <= args.screen_days + args.purge_days:
        raise SystemExit("development_fraction leaves too little screen history")
    stats = build_screen_stats(
        df,
        available,
        development_end_idx,
        args.screen_days,
        args.holdout_days,
        args.purge_days,
        args.min_names_per_day,
    )

    heap: list[tuple[float, int, dict]] = []
    screen_path = out / "screen_ledger.jsonl.gz"
    committed = 0
    with gzip.open(screen_path, "wt", encoding="utf-8") as ledger:
        for i, rule in enumerate(generate_rules(available, args.max_trials), 1):
            committed = i
            score = proxy_for_rule(rule, stats)
            rec = {
                "trial": i,
                **asdict(rule),
                "rule_id": rule.id,
                "screen_proxy": score,
            }
            ledger.write(json.dumps(rec) + "\n")
            item = (score, -i, rec)
            if len(heap) < args.finalists:
                heapq.heappush(heap, item)
            elif item > heap[0]:
                heapq.heapreplace(heap, item)

    finalists = [x[2] for x in sorted(heap, key=lambda z: (-z[0], -z[2]["trial"]))]
    pd.DataFrame(finalists).to_csv(out / "screen_top.csv", index=False)

    ranks, rets, day_ids, dates, starts, ends = prepare_exact_frame(df, available)
    final_rows = []
    for rec in finalists:
        rule = Rule(
            rec["feature"], rec["direction"], float(rec["quantile"]), rec["op"],
            rec["feature2"], rec["direction2"], float(rec["quantile2"]),
            float(rec["weight"]),
        )
        result = {"trial": rec["trial"], **asdict(rule), "rule_id": rule.id, "screen_proxy": rec["screen_proxy"]}
        try:
            wf = exact_walk_forward(
                rule, ranks, rets, day_ids, dates, starts, ends,
                development_end_idx, args.oos_days, args.holdout_days, args.purge_days, args.cost_bps
            )
            result.update({k: v for k, v in wf.items() if k != "folds_detail"})
            positive_fold_min = int(np.ceil(result["folds"] * args.min_positive_fold_fraction))
            result["eligible"] = bool(
                result["oos_trades"] >= args.min_trades
                and result["oos_positive_folds"] >= positive_fold_min
                and result["oos_return_sum"] > 0
                and result["oos_return"] > 0
            )
            result["selection_holdout_blind"] = True
            result["positive_fold_min"] = positive_fold_min
            result["status"] = "passed_gate" if result["eligible"] else "rejected"
            result["folds_detail"] = wf["folds_detail"]
        except Exception as exc:
            result["eligible"] = False
            result["status"] = "error"
            result["error"] = str(exc)
        final_rows.append(result)
        pd.DataFrame([
            {k: v for k, v in x.items() if k != "folds_detail"} for x in final_rows
        ]).to_csv(out / "results.csv", index=False)

    results = pd.DataFrame([{k: v for k, v in x.items() if k != "folds_detail"} for x in final_rows])
    if not results.empty:
        passed = results[results["eligible"] == True].sort_values(
            ["oos_return_sum", "oos_t_stat", "oos_positive_folds"],
            ascending=False,
        )
    else:
        passed = results
    passed.to_csv(out / "passed.csv", index=False)

    manifest = {
        "engine": "luna-one-million-staged-v3",
        "trials_committed": committed,
        "max_trials_requested": args.max_trials,
        "finalists_exact": len(finalists),
        "screen_days": args.screen_days,
        "development_fraction": args.development_fraction,
        "development_end_idx": development_end_idx,
        "min_names_per_day": args.min_names_per_day,
        "cost_bps": args.cost_bps,
        "oos_days": args.oos_days,
        "holdout_days": args.holdout_days,
        "purge_days": args.purge_days,
        "min_positive_fold_fraction": args.min_positive_fold_fraction,
        "features_used": available,
        "input_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "screen_definition": "deterministic development-only smooth tail-signal covariance proxy; screen window is inside development period and excludes one purge day before OOS",
        "exact_definition": "cross-sectional percentile rules with forward OOS validation and a holdout that is computed for reporting but excluded from eligibility/ranking",
        "selection_rule": "Eligibility and ranking use OOS only. Holdout is excluded from selection and is reported as blind confirmation. Majority-of-fold stability is required.",
        "selection_warning": "All hypotheses are screened, but only finalists receive exact full-period evaluation; screen_proxy is not a return estimate. Multiple-testing correction and independent validation are still required before treating a finalist as validated.",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({
        "trials": manifest["trials_committed"],
        "finalists": len(finalists),
        "passed": int(len(passed)),
    }, indent=2))


if __name__ == "__main__":
    main()
