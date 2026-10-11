#!/usr/bin/env python3
"""Fail-closed month-by-month alignment audit for a strategy alias vs its canonical series.

This tool verifies claimed identity, not relative investment performance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


def load_monthly_series(path: str | Path, date_column: str, return_column: str, label: str) -> pd.Series:
    frame = pd.read_csv(path)
    missing = {date_column, return_column} - set(frame.columns)
    if missing:
        raise ValueError(f"{label}_MISSING_COLUMNS:{sorted(missing)}")
    raw_dates = pd.to_datetime(frame[date_column], errors="raise")
    raw_returns = pd.to_numeric(frame[return_column], errors="coerce")
    if raw_dates.isna().any():
        raise ValueError(f"{label}_MISSING_DATES")
    values = raw_returns.to_numpy(dtype=float)
    if raw_returns.isna().any() or not np.isfinite(values).all():
        raise ValueError(f"{label}_MISSING_OR_NONFINITE_RETURNS")
    if (raw_returns <= -1).any():
        raise ValueError(f"{label}_RETURN_AT_OR_BELOW_MINUS_100_PERCENT")
    month_key = raw_dates.dt.to_period("M").dt.to_timestamp()
    if month_key.duplicated().any():
        duplicates = month_key[month_key.duplicated(keep=False)].dt.strftime("%Y-%m").tolist()
        raise ValueError(f"{label}_DUPLICATE_MONTHS:{sorted(set(duplicates))}")
    out = pd.Series(values, index=month_key, name=label).sort_index()
    if out.empty:
        raise ValueError(f"{label}_EMPTY_SERIES")
    return out


def audit_monthly_series(candidate: pd.Series, reference: pd.Series, *, tolerance: float = 1e-6) -> dict[str, Any]:
    if not np.isfinite(tolerance) or tolerance < 0:
        raise ValueError("TOLERANCE_MUST_BE_FINITE_AND_NONNEGATIVE")
    candidate_months = set(candidate.index)
    reference_months = set(reference.index)
    missing_from_candidate = sorted(reference_months - candidate_months)
    missing_from_reference = sorted(candidate_months - reference_months)
    if missing_from_candidate or missing_from_reference:
        return {
            "status": "MISMATCH_COVERAGE",
            "candidate_months": len(candidate),
            "reference_months": len(reference),
            "missing_from_candidate": [pd.Timestamp(x).strftime("%Y-%m") for x in missing_from_candidate],
            "missing_from_reference": [pd.Timestamp(x).strftime("%Y-%m") for x in missing_from_reference],
            "tolerance": tolerance,
        }
    left = candidate.sort_index()
    right = reference.reindex(left.index)
    delta = left.to_numpy(dtype=float) - right.to_numpy(dtype=float)
    mae = float(np.mean(np.abs(delta)))
    max_abs_delta = float(np.max(np.abs(delta)))
    corr = float(np.corrcoef(left.to_numpy(dtype=float), right.to_numpy(dtype=float))[0, 1]) if len(left) > 1 else None
    return {
        "status": "ALIGNED" if max_abs_delta <= tolerance else "MISMATCH_RETURNS",
        "months": int(len(left)),
        "period_start": pd.Timestamp(left.index.min()).strftime("%Y-%m"),
        "period_end": pd.Timestamp(left.index.max()).strftime("%Y-%m"),
        "mean_delta_candidate_minus_reference": float(np.mean(delta)),
        "mean_absolute_delta": mae,
        "max_absolute_delta": max_abs_delta,
        "return_correlation": corr if corr is None or np.isfinite(corr) else None,
        "months_with_delta_over_tolerance": int((np.abs(delta) > tolerance).sum()),
        "tolerance": tolerance,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--candidate-date-column", default="month_end")
    parser.add_argument("--candidate-return-column", default="net_return")
    parser.add_argument("--reference-date-column", default="month_end")
    parser.add_argument("--reference-return-column", default="net_return")
    parser.add_argument("--tolerance", type=float, default=1e-6)
    parser.add_argument("--output-json")
    args = parser.parse_args()
    candidate = load_monthly_series(args.candidate, args.candidate_date_column, args.candidate_return_column, "CANDIDATE")
    reference = load_monthly_series(args.reference, args.reference_date_column, args.reference_return_column, "REFERENCE")
    result = audit_monthly_series(candidate, reference, tolerance=args.tolerance)
    result.update({
        "candidate_file_sha256": hashlib.sha256(Path(args.candidate).read_bytes()).hexdigest(),
        "reference_file_sha256": hashlib.sha256(Path(args.reference).read_bytes()).hexdigest(),
        "identity_rule": "Month keys must match exactly; return deltas must be within declared tolerance. High correlation alone is not identity.",
    })
    rendered = json.dumps(result, indent=2, ensure_ascii=False)
    print(rendered)
    if args.output_json:
        output = Path(args.output_json)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    if result["status"] != "ALIGNED":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
