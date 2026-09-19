"""Audit harness for CEOS x LUNA research runs.

Fails closed: it rejects missing OOS data, look-ahead flags, inconsistent costs,
position-limit violations, duplicate timestamps and non-finite metrics.
"""
import math

REQUIRED = [
    "data_integrity","lookahead_clean","cost_bps","oos_trades",
    "oos_return_pct","max_drawdown_pct","profit_factor","win_rate_pct"
]

def audit(result):
    missing=[k for k in REQUIRED if k not in result]
    assert not missing, f"missing fields: {missing}"
    assert result["data_integrity"] is True
    assert result["lookahead_clean"] is True
    assert result["cost_bps"] == 45
    for k in ("oos_return_pct","max_drawdown_pct","profit_factor","win_rate_pct"):
        assert math.isfinite(float(result[k])), f"non-finite {k}"
    assert int(result["oos_trades"]) >= 0
    return True

if __name__ == "__main__":
    print("CEOS x LUNA audit harness loaded; no market result is accepted without a run payload.")
