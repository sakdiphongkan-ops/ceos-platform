#!/usr/bin/env python3
"""Regression tests for the theory-driven M1 candidate family generator."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "research" / "luna_m1_research_v2.py"
SPEC = importlib.util.spec_from_file_location("luna_m1_research_v2", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_candidate_cartesian_product_is_complete_and_unique() -> None:
    candidates = MODULE.make_candidates()
    # mw(3) * liquidity weight(3) * volatility weight(2) *
    # trend floor(2) * liquidity floor(2) * style(2)
    assert len(candidates) == 144, f"expected 144 parameter combinations, got {len(candidates)}"
    assert len({candidate.name for candidate in candidates}) == 144
    assert {c.mom_w for c in candidates}  # family is non-empty
    assert all(abs(c.mom_w + c.lq_w + c.vol_w - 1.0) < 1e-12 for c in candidates)
    assert {c.trend_floor for c in candidates} == {0.0, 0.2}
    assert {c.liq_floor for c in candidates} == {0.0, 0.2}
    assert {c.lq_style for c in candidates} == {"SAFE", "CONTRARIAN"}


if __name__ == "__main__":
    test_candidate_cartesian_product_is_complete_and_unique()
    print("LUNA M1 candidate-family regression: OK")
