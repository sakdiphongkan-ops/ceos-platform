#!/usr/bin/env python3
"""LUNA dependent-data multiple-testing diagnostic v1.

Implements a block-bootstrap max-t Reality-Check-style diagnostic over the
entire searched formula family. The frozen holdout is excluded completely.
This is a research diagnostic, not a formal p-value proof. The search-v1 CI trigger intentionally reruns the full family after inference changes.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--return-matrix", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--bootstrap-count", type=int, default=500)
    ap.add_argument("--block-length", type=int, default=3)
    ap.add_argument("--seed", type=int, default=20260921)
    args = ap.parse_args()

    summary = json.loads(Path(args.summary).read_text(encoding="utf-8"))
    holdout_start = pd.Timestamp(summary["holdout_start"])

    m = pd.read_csv(args.return_matrix, compression="gzip")
    m["month_end"] = pd.to_datetime(m["month_end"], errors="raise")
    dev = m.loc[m["month_end"] < holdout_start].copy()
    formula_cols = [c for c in dev.columns if c != "month_end"]

    if len(dev) < 12:
        raise SystemExit("insufficient development months for dependent-data bootstrap")
    if len(formula_cols) < 2:
        raise SystemExit("insufficient formula family")

    X = dev[formula_cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=float)
    # Keep formulas with at least 90% development observations.
    keep = np.isfinite(X).sum(axis=0) >= math.ceil(0.90 * len(dev))
    X = X[:, keep]
    names = [n for n, ok in zip(formula_cols, keep) if ok]
    if X.shape[1] < 2:
        raise SystemExit("insufficient formulas after coverage filter")

    # Fill residual gaps with the formula's development mean only for the
    # centered bootstrap residual. The observed statistic uses native values.
    means = np.nanmean(X, axis=0)
    counts = np.isfinite(X).sum(axis=0)
    std = np.nanstd(X, axis=0, ddof=1)
    denom = std / np.sqrt(np.maximum(counts, 1))
    observed_t = means / np.where(denom > 0, denom, np.inf)
    observed_max_t = float(np.nanmax(observed_t))
    best_idx = int(np.nanargmax(observed_t))

    X_filled = np.where(np.isfinite(X), X, means[None, :])
    centered = X_filled - means[None, :]
    n = X.shape[0]
    L = max(1, min(args.block_length, n))

    rng = np.random.default_rng(args.seed)
    boot_max = np.empty(args.bootstrap_count, dtype=float)

    for b in range(args.bootstrap_count):
        idx = []
        while len(idx) < n:
            start = int(rng.integers(0, n))
            block = [(start + j) % n for j in range(L)]
            idx.extend(block)
        idx = np.asarray(idx[:n], dtype=int)
        sample = centered[idx, :]
        bm = sample.mean(axis=0)
        bs = sample.std(axis=0, ddof=1)
        bt = bm / np.where(bs > 0, bs / np.sqrt(n), np.inf)
        boot_max[b] = np.nanmax(bt)

    p = float((1 + np.sum(boot_max >= observed_max_t)) / (len(boot_max) + 1))
    q95 = float(np.quantile(boot_max, 0.95))
    q99 = float(np.quantile(boot_max, 0.99))

    # A simple winner's-curse gap: best raw development mean against the
    # cross-family mean. This is descriptive, not a selection criterion.
    best_mean = float(means[best_idx])
    family_mean = float(np.nanmean(means))

    result = {
        "status": "COMPLETED",
        "engine": "luna-dependent-data-multiple-testing-v1",
        "method": "moving-block-bootstrap max-t Reality-Check-style diagnostic",
        "null_construction": "development returns centered formula-by-formula before common time-block resampling",
        "holdout_excluded": True,
        "development_months": int(n),
        "formula_family_size_after_coverage": int(len(names)),
        "bootstrap_count": int(args.bootstrap_count),
        "block_length_months": int(L),
        "seed": int(args.seed),
        "observed_max_t": observed_max_t,
        "observed_winner_formula_id": names[best_idx],
        "observed_winner_mean_monthly_return": best_mean,
        "family_mean_monthly_return": family_mean,
        "bootstrap_max_t_95pct": q95,
        "bootstrap_max_t_99pct": q99,
        "reality_check_style_p_value": p,
        "interpretation": (
            "Diagnostic only. A small value suggests the best development "
            "t-stat is unusual relative to a common dependent-data bootstrap "
            "of the entire searched family; it is not a formal finite-sample "
            "p-value and does not establish live tradability."
        ),
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
