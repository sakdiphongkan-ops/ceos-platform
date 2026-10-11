#!/usr/bin/env python3
"""Regression tests for outcome-blind LUNA monthly portfolio formation."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "scripts" / "research"
if str(RESEARCH) not in sys.path:
    sys.path.insert(0, str(RESEARCH))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DIRECT = load_module("luna_direct_supabase_1000_v1", RESEARCH / "luna_direct_supabase_1000_v1.py")
ADAPTIVE = load_module("monthly_walk_forward_adaptive_search", RESEARCH / "monthly_walk_forward_adaptive_search.py")

FACTOR_COLUMNS = [
    "mom1", "mom3", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]


def synthetic_monthly_panel() -> pd.DataFrame:
    months = pd.to_datetime(["2024-01-31", "2024-02-29", "2024-03-31"])
    rows = []
    for i in range(25):
        for j, month in enumerate(months):
            # Deliberate lifecycle gap: S24 is present in Jan and Mar, but not Feb.
            if i == 24 and j == 1:
                continue
            row = {
                "symbol": f"S{i:02d}",
                "month_end": month,
                "adj_close": 10.0 + i / 10.0 + j,
            }
            for f in FACTOR_COLUMNS:
                row[f] = -100.0 if i == 24 else float(i + j + 1)
            rows.append(row)
    return pd.DataFrame(rows)


def test_direct_1000_keeps_missing_outcome_out_of_formation_filter() -> None:
    df = DIRECT.add_strict_forward_returns(synthetic_monthly_panel())
    jan = df.loc[df["month_end"] == pd.Timestamp("2024-01-01")].reset_index(drop=True)
    assert len(jan) == 25
    row_s24 = jan.index[jan["symbol"].eq("S24")][0]
    assert np.isnan(jan.loc[row_s24, "fwd1"]), "Jan-to-Mar gap must not become a 1M return"

    ranks = np.stack(
        [jan.groupby("month_end")[f].rank(pct=True, method="average").to_numpy() for f in FACTOR_COLUMNS],
        axis=1,
    )
    positions = np.arange(len(jan))
    factor_pos = {f: i for i, f in enumerate(FACTOR_COLUMNS)}
    chosen = DIRECT.select_formula_positions(
        ranks, positions, [("mom1", -1.0)], factor_pos, 5, "M1_REV_K20", pd.Timestamp("2024-01-01")
    )
    selected_symbols = jan.iloc[chosen]["symbol"].astype(str).tolist()
    assert "S24" in selected_symbols, "selection must depend on known factor values, not future data"
    with np.testing.assert_raises(SystemExit) as err:
        DIRECT.require_selected_outcomes(
            jan["fwd1"].to_numpy(dtype=float), chosen, jan["symbol"], "M1_REV_K20", pd.Timestamp("2024-01-01")
        )
    assert "MISSING_FORWARD_RETURN_FOR_SELECTED_SYMBOLS" in str(err.exception)


def test_adaptive_search_uses_strict_contiguity_and_fails_closed() -> None:
    df = ADAPTIVE.add_strict_forward_returns(synthetic_monthly_panel())
    jan = df.loc[df["month_end"] == pd.Timestamp("2024-01-31")]
    assert len(jan) == 25
    assert np.isnan(jan.loc[jan["symbol"].eq("S24"), "fwd1"].iloc[0])

    selected = ADAPTIVE.ranked_symbols(df, "mom1", "LOW", 5)
    jan_symbols = selected.loc[pd.Timestamp("2024-01-31")].tolist()
    assert "S24" in jan_symbols, "formation universe must not be conditioned on fwd1"

    with np.testing.assert_raises(SystemExit) as err:
        ADAPTIVE.candidate_return(df, "mom1", "LOW", 5, 20.0)
    assert "MISSING_FORWARD_RETURN_FOR_SELECTED_SYMBOLS" in str(err.exception)


if __name__ == "__main__":
    test_direct_1000_keeps_missing_outcome_out_of_formation_filter()
    test_adaptive_search_uses_strict_contiguity_and_fails_closed()
    print("LUNA forward-return guard tests: OK")
