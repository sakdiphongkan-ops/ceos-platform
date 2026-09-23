import unittest
from pathlib import Path

import pandas as pd

from luna_m1_orthogonal_sizer_v2 import load_inputs


class TestCanonicalOrthogonalSizer(unittest.TestCase):
    def _write_fixture(self, missing_mom3=False):
        m1_rows = []
        factor_rows = []
        for i in range(20):
            symbol = f"S{i:02d}"
            m1_rows.append({
                "month_end": "2026-01-31",
                "symbol": symbol,
                "selection_score": float(i),
                "next_month_return": 0.01 + i / 10000.0,
            })
            factor_rows.append({
                "month_end": "2026-01-31",
                "symbol": symbol,
                "mom3": None if (missing_mom3 and i == 19) else 0.01 * i,
                "high52_ratio": 0.8 + i / 1000,
                "vol20": 0.02 + i / 10000,
                "avg_amount20": 1_000_000 + i * 1000,
            })
        m1 = pd.DataFrame(m1_rows)
        factors = pd.DataFrame(factor_rows)
        m1_path = Path("/tmp/m1_fixture.csv")
        factor_path = Path("/tmp/factor_fixture.csv")
        m1.to_csv(m1_path, index=False)
        factors.to_csv(factor_path, index=False)
        return str(m1_path), str(factor_path)

    def test_exact_twenty_and_weight_bounds(self):
        m1_path, factor_path = self._write_fixture()
        out = load_inputs(m1_path, factor_path)
        self.assertEqual(len(out), 20)
        self.assertTrue(out["weight"].between(0, 0.1).all())
        self.assertAlmostEqual(float(out["weight"].sum()), 1.0, places=12)

    def test_neutralizes_missing_mom3(self):
        m1_path, factor_path = self._write_fixture(missing_mom3=True)
        out = load_inputs(m1_path, factor_path)
        self.assertEqual(int(out["mom3_missing"].sum()), 1)
        self.assertAlmostEqual(float(out["weight"].sum()), 1.0, places=12)


if __name__ == "__main__":
    unittest.main()
