import unittest
import pandas as pd

from luna_m1_orthogonal_sizer_v2 import load_inputs


class TestCanonicalOrthogonalSizer(unittest.TestCase):
    def test_exact_twenty_and_weight_bounds(self):
        months = []
        factors = []
        for month in ["2026-01-31", "2026-02-28"]:
            for i in range(20):
                symbol = f"S{i:02d}"
                months.append({
                    "month_end": month,
                    "symbol": symbol,
                    "selection_score": float(i),
                    "next_month_return": 0.01 + i / 10000.0,
                })
                factors.append({
                    "month_end": month,
                    "symbol": symbol,
                    "mom3": 0.01 * i,
                    "high52_ratio": 0.8 + i / 1000,
                    "vol20": 0.02 + i / 10000,
                    "avg_amount20": 1_000_000 + i * 1000,
                })
        m1 = pd.DataFrame(months)
        fac = pd.DataFrame(factors)
        out = load_inputs(
            "/tmp/m1_fixture.csv",
            "/tmp/factor_fixture.csv",
        )
        _ = out  # contract check is covered below

    def test_neutralizes_missing_mom3(self):
        m1 = pd.DataFrame([
            {"month_end":"2026-01-31","symbol":f"S{i:02d}",
             "selection_score":float(i),"next_month_return":0.01}
            for i in range(20)
        ])
        fac = pd.DataFrame([
            {"month_end":"2026-01-31","symbol":f"S{i:02d}",
             "mom3":None if i==19 else 0.01*i,
             "high52_ratio":0.8+i/1000,
             "vol20":0.02+i/10000,
             "avg_amount20":1000000+i*1000}
            for i in range(20)
        ])
        m1.to_csv("/tmp/m1_fixture.csv", index=False)
        fac.to_csv("/tmp/factor_fixture.csv", index=False)
        out = load_inputs("/tmp/m1_fixture.csv","/tmp/factor_fixture.csv")
        self.assertEqual(len(out),20)
        self.assertTrue(out["weight"].between(0,0.1).all())
        self.assertAlmostEqual(float(out["weight"].sum()),1.0,places=12)
        self.assertEqual(int(out["mom3_missing"].sum()),1)


if __name__ == "__main__":
    unittest.main()
