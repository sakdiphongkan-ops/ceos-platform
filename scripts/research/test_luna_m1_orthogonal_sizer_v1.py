import unittest
import pandas as pd

from luna_m1_orthogonal_sizer_v1 import prepare


class TestOrthogonalSizer(unittest.TestCase):
    def _frames(self):
        holdings = pd.DataFrame([
            {"month_end":"2026-01-31","symbol":"A","selection_score":1.0,"next_month_return":0.02},
            {"month_end":"2026-01-31","symbol":"B","selection_score":2.0,"next_month_return":0.01},
            {"month_end":"2026-02-28","symbol":"A","selection_score":1.0,"next_month_return":0.03},
            {"month_end":"2026-02-28","symbol":"B","selection_score":2.0,"next_month_return":0.02},
        ])
        # Minimal two-name fixture; override TOP_K semantics by calling
        # prepare only to ensure residualization/rank mechanics remain deterministic.
        ranked = pd.DataFrame([
            {"month_end":"2026-01-31","symbol":"A","r_mom3":1.0,"r_high52_ratio":0.1,"r_vol20":0.2},
            {"month_end":"2026-01-31","symbol":"B","r_mom3":0.0,"r_high52_ratio":0.2,"r_vol20":0.1},
            {"month_end":"2026-02-28","symbol":"A","r_mom3":1.0,"r_high52_ratio":0.1,"r_vol20":0.2},
            {"month_end":"2026-02-28","symbol":"B","r_mom3":0.0,"r_high52_ratio":0.2,"r_vol20":0.1},
        ])
        return holdings, ranked

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


if __name__ == "__main__":
    unittest.main()
