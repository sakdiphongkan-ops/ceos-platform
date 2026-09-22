import unittest
import numpy as np
import pandas as pd

from luna_feasibility import (
    geometric_monthly_return,
    max_drawdown_stats,
    newey_west_mean_tstat,
    summarize,
    validate_ledger,
)


class TestLunaFeasibility(unittest.TestCase):
    def test_geometric_monthly_return(self):
        self.assertAlmostEqual(
            geometric_monthly_return([0.10, -0.10]),
            np.sqrt(1.10 * 0.90) - 1.0,
            places=12,
        )

    def test_drawdown_is_reported_in_money(self):
        result = max_drawdown_stats([0.10, -0.20, 0.05], 30000)
        self.assertAlmostEqual(result["max_drawdown_pct"], -0.20, places=12)
        self.assertAlmostEqual(result["max_drawdown_baht"], -6600.0, places=8)

    def test_hac_t_stat_detects_constant_positive_series(self):
        self.assertGreater(newey_west_mean_tstat([0.008, 0.010, 0.012, 0.009, 0.011, 0.010, 0.009, 0.012, 0.010, 0.011, 0.009, 0.010]), 1.645)

    def test_summary_target_hits(self):
        result = summarize([0.08, 0.06, -0.02, 0.09], 30000, 0.07)
        self.assertEqual(result["months"], 4)
        self.assertEqual(result["months_ge_target"], 2)
        self.assertAlmostEqual(result["target_hit_pct"], 0.5, places=12)

    def test_cost_reconciliation_guard(self):
        frame = pd.DataFrame({
            "month_end": pd.to_datetime(["2026-01-31", "2026-02-28"]),
            "gross_return": [0.05, 0.02],
            "turnover": [1.0, 0.5],
            "transaction_cost": [0.002, 0.001],
            "realized_return": [0.048, 0.019],
        })
        validate_ledger(frame)


if __name__ == "__main__":
    unittest.main()
