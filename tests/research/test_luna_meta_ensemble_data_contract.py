#!/usr/bin/env python3
"""Regression tests for the LUNA meta-ensemble input contract and bias guards."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "research" / "luna_meta_ensemble_lab_v1.py"
SPEC = importlib.util.spec_from_file_location("luna_meta_ensemble_lab_v1", SCRIPT)
LAB = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = LAB
SPEC.loader.exec_module(LAB)


def build_uppercase_input(path: Path) -> None:
    """Create rank-complete monthly source factors with one missing next-month price."""
    rows = []
    months = pd.to_datetime(["2024-01-31", "2024-02-29", "2024-03-31"])
    for i in range(25):
        for j, month in enumerate(months):
            # S24 is absent in February but returns in March. Its January signal
            # must remain in the investable universe, with a missing January return.
            if i == 24 and j == 1:
                continue
            rows.append({
                "date": month.date().isoformat(),
                "symbol": f"S{i:02d}",
                "adj_close": 10.0 + i / 10.0 + j,
                "MOM_20": -100.0 if i == 24 else float(i + j),
                "MOM_40": -100.0 if i == 24 else float(i + j + 1),
                "MOM_60": -100.0 if i == 24 else float(i + j + 2),
                "MOM_80": -100.0 if i == 24 else float(i + j + 3),
                "MOM_120": -100.0 if i == 24 else float(i + j + 4),
                "MOM_252": -100.0 if i == 24 else float(i + j + 5),
                "DIST_HIGH_252": 100.0 if i == 24 else i / 100.0,
                "VOL_20": -100.0 if i == 24 else float(i + 1),
                "MAXDD_60": 100.0 if i == 24 else -float(i),
                "AMOUNT": 100000000.0 if i == 24 else float((i + 1) * 1000),
            })
    pd.DataFrame(rows).to_csv(path, index=False)


def test_aliases_and_missing_outcome_fail_closed() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "factors.csv"
        build_uppercase_input(source)
        panels = LAB.prepare(source)

    assert len(panels) == 2, f"expected only the two months with a following month, got {len(panels)}"
    january = next(p for p in panels if pd.Timestamp(p["month"]) == pd.Timestamp("2024-01-31"))
    assert len(january["symbols"]) == 25, "signal universe must not be filtered by future return availability"
    missing_idx = list(january["symbols"]).index("S24")
    assert np.isnan(january["fwd"][missing_idx]), "missing forward outcome must remain visible"

    try:
        LAB.component_paths(panels, k=5, cost_bps=20)
    except SystemExit as exc:
        assert "MISSING_FORWARD_RETURN_FOR_SELECTED_SYMBOLS" in str(exc), str(exc)
    else:
        raise AssertionError("selected symbol with missing next-month return must fail closed")


def test_incomplete_windows_fail_closed() -> None:
    panels = [
        {"month": pd.Timestamp("2024-01-31")},
        {"month": pd.Timestamp("2024-02-29")},
    ]
    origins = [("TEST", "2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30")]
    try:
        LAB.validate_origin_coverage(panels, origins)
    except SystemExit as exc:
        msg = str(exc)
        assert "INCOMPLETE_ORIGIN_DATA" in msg, msg
        assert "2024-03" in msg and "2024-04" in msg, msg
    else:
        raise AssertionError("partial holdout must never be reported as a complete run")


if __name__ == "__main__":
    test_aliases_and_missing_outcome_fail_closed()
    test_incomplete_windows_fail_closed()
    print("LUNA meta-ensemble data-contract regression: OK")
