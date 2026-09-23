import unittest
import pandas as pd

from luna_m1_regime_selector_v1 import candidate_monthly_stats, select_regime


class TestRegimeSelector(unittest.TestCase):
    def test_selection_uses_only_past_months(self):
        frame = pd.DataFrame([
            {"strategy":"M1","month_end":"2022-01-31","k":2,"gross":0.01,"symbols":{"A","B"}},
            {"strategy":"M1","month_end":"2022-02-28","k":2,"gross":0.01,"symbols":{"A","B"}},
            {"strategy":"P10","month_end":"2022-01-31","k":1,"gross":0.00,"symbols":{"C"}},
            {"strategy":"P10","month_end":"2022-02-28","k":1,"gross":0.10,"symbols":{"D"}},
        ])
        frame["month_end"] = pd.to_datetime(frame["month_end"])
        frame["turnover"] = [1.0,0.0,1.0,1.0]
        frame["net"] = frame["gross"] - frame["turnover"] * 0.002
        choices = select_regime(frame, 1, pd.Timestamp("2022-02-28"))
        self.assertEqual(choices.iloc[0]["selected_strategy"], "M1")

    def test_strategy_specific_turnover_is_used(self):
        holdings = pd.DataFrame([
            {"strategy":"M1","month_end":"2022-01-31","symbol":"A","fwd":0.01,"k":2},
            {"strategy":"M1","month_end":"2022-01-31","symbol":"B","fwd":0.01,"k":2},
            {"strategy":"M1","month_end":"2022-02-28","symbol":"A","fwd":0.01,"k":2},
            {"strategy":"M1","month_end":"2022-02-28","symbol":"C","fwd":0.01,"k":2},
        ])
        stats = candidate_monthly_stats(holdings, 20)
        feb = stats[(stats["strategy"]=="M1") & (stats["month_end"]=="2022-02-28")].iloc[0]
        self.assertAlmostEqual(feb["turnover"], 0.5)


if __name__ == "__main__":
    unittest.main()
