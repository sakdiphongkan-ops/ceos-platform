#!/usr/bin/env python3
"""Regression tests for canonical-vs-alias monthly return alignment."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "research" / "compare_monthly_return_series.py"
SPEC = importlib.util.spec_from_file_location("compare_monthly_return_series", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def series(months, values, name):
    index = pd.to_datetime(months).to_period("M").to_timestamp()
    return pd.Series(values, index=index, name=name)


def test_identical_monthly_returns_ignore_date_day() -> None:
    candidate = series(["2024-01-01", "2024-02-01", "2024-03-01"], [0.01, -0.02, 0.03], "candidate")
    reference = series(["2024-01-31", "2024-02-29", "2024-03-31"], [0.01, -0.02, 0.03], "reference")
    result = MODULE.audit_monthly_series(candidate, reference)
    assert result["status"] == "ALIGNED"
    assert result["months"] == 3
    assert result["max_absolute_delta"] == 0.0


def test_high_correlation_does_not_hide_return_mismatch() -> None:
    candidate = series(["2024-01", "2024-02", "2024-03"], [0.01, -0.02, 0.03], "candidate")
    reference = series(["2024-01", "2024-02", "2024-03"], [0.02, -0.01, 0.04], "reference")
    result = MODULE.audit_monthly_series(candidate, reference, tolerance=1e-6)
    assert result["return_correlation"] > 0.99
    assert result["status"] == "MISMATCH_RETURNS"
    assert result["months_with_delta_over_tolerance"] == 3


def test_missing_month_fails_closed() -> None:
    candidate = series(["2024-01", "2024-02"], [0.01, -0.02], "candidate")
    reference = series(["2024-01", "2024-02", "2024-03"], [0.01, -0.02, 0.03], "reference")
    result = MODULE.audit_monthly_series(candidate, reference)
    assert result["status"] == "MISMATCH_COVERAGE"
    assert result["missing_from_candidate"] == ["2024-03"]


def test_duplicate_month_is_rejected_on_load() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "candidate.csv"
        pd.DataFrame({"month_end": ["2024-01-01", "2024-01-31"], "net_return": [0.01, 0.02]}).to_csv(path, index=False)
        try:
            MODULE.load_monthly_series(path, "month_end", "net_return", "CANDIDATE")
        except ValueError as exc:
            assert "CANDIDATE_DUPLICATE_MONTHS" in str(exc)
        else:
            raise AssertionError("duplicate month rows must not be silently aggregated")


if __name__ == "__main__":
    test_identical_monthly_returns_ignore_date_day()
    test_high_correlation_does_not_hide_return_mismatch()
    test_missing_month_fails_closed()
    test_duplicate_month_is_rejected_on_load()
    print("LUNA monthly benchmark-alignment regression: OK")
