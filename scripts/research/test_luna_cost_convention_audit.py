import unittest
import pandas as pd

from luna_cost_convention_audit import stats


class TestCostConventionAudit(unittest.TestCase):
    def test_two_sided_cost_reduces_return_more(self):
        one = stats(pd.Series([0.05, 0.05]))
        two = stats(pd.Series([0.04, 0.04]))
        self.assertGreater(one["geometric_monthly_return"], two["geometric_monthly_return"])


if __name__ == "__main__":
    unittest.main()
