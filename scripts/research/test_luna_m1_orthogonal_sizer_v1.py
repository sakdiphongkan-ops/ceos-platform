import unittest
import pandas as pd

from luna_m1_orthogonal_sizer_v1 import prepare


class TestOrthogonalSizer(unittest.TestCase):
    def _frames(self):
        holdings = []
        ranked = []
        for month in ["2026-01-31", "2026-02-28"]:
            for i in range(20):
                symbol = f"S{i:02d}"
                holdings.append({
                    "month_end": month,
                    "symbol": symbol,
                    "selection_score": float(i),
                    "next_month_return": 0.01 + i / 10000.0,
                })
                ranked.append({
                    "month_end": month,
                    "symbol": symbol,
                    "r_mom3": 1.0 - i / 20.0,
                    "r_high52_ratio": i / 20.0,
                    "r_vol20": i / 30.0,
                })
        return pd.DataFrame(holdings), pd.DataFrame(ranked)

    def test_weight_sum_and_non_negative(self):
        h, r = self._frames()
        p = prepare(h, r, 1.0)
        self.assertTrue((p["target_weight"] >= 0).all())
        self.assertTrue((p.groupby("month_end")["target_weight"].sum() - 1).abs().max() < 1e-10)
        self.assertAlmostEqual(float(p["target_weight"].max()), 0.1, places=12)
        self.assertAlmostEqual(float(p["target_weight"].min()), 0.0, places=12)

    def test_frozen_lambda(self):
        h, r = self._frames()
        with self.assertRaises(SystemExit):
            prepare(h, r, 1.25)

    def test_rejects_incomplete_m1_basket(self):
        h, r = self._frames()
        h = h[h["symbol"] != "S19"].copy()
        r = r[r["symbol"] != "S19"].copy()
        with self.assertRaises(SystemExit):
            prepare(h, r, 1.0)


if __name__ == "__main__":
    unittest.main()
