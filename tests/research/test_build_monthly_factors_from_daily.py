import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "research" / "build_monthly_factors_from_daily.py"


class MonthlyFactorPITTests(unittest.TestCase):
    def run_builder(self, frame):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        input_path = Path(tmp.name) / "daily.csv"
        output_path = Path(tmp.name) / "monthly.csv"
        frame.to_csv(input_path, index=False)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--input", str(input_path), "--output", str(output_path)],
            text=True,
            capture_output=True,
        )
        return result, output_path

    def test_null_adjusted_close_is_excluded_before_month_end_selection(self):
        frame = pd.DataFrame([
            {"date":"2024-01-30","symbol":"AAA","close":10,"adj_close":10,"volume":100,"amount":1000},
            {"date":"2024-01-31","symbol":"AAA","close":None,"adj_close":None,"volume":None,"amount":None},
            {"date":"2024-02-29","symbol":"AAA","close":11,"adj_close":11,"volume":100,"amount":1100},
            {"date":"2024-01-31","symbol":"BBB","close":5,"adj_close":5,"volume":100,"amount":500},
            {"date":"2024-02-29","symbol":"BBB","close":6,"adj_close":6,"volume":100,"amount":600},
        ])
        result, output_path = self.run_builder(frame)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = pd.read_csv(output_path)
        jan_aaa = out[(out.symbol=="AAA") & (out.month_end=="2024-01-31")]
        self.assertEqual(len(jan_aaa), 1)
        self.assertEqual(float(jan_aaa.iloc[0].adj_close), 10.0)
        self.assertIn("excluded_missing_or_nonpositive_price_rows", result.stdout)
        self.assertIn("'excluded_missing_or_nonpositive_price_rows': 1", result.stdout)

    def test_yahoo_daily_bar_before_1705_bangkok_is_rejected(self):
        frame = pd.DataFrame([
            {"date":"2024-01-30","symbol":"AAA","close":10,"adj_close":10,"volume":100,"amount":1000,
             "source":"YAHOO_FINANCE_CHART:1d","available_at":"2024-01-30T10:04:00Z"},
        ])
        result, _ = self.run_builder(frame)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("point-in-time availability violation", result.stderr)

    def test_yahoo_daily_bar_at_1705_bangkok_is_accepted(self):
        frame = pd.DataFrame([
            {"date":"2024-01-30","symbol":"AAA","close":10,"adj_close":10,"volume":100,"amount":1000,
             "source":"YAHOO_FINANCE_CHART:1d","available_at":"2024-01-30T10:05:00Z"},
        ])
        result, _ = self.run_builder(frame)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("'availability_rows_verified': 1", result.stdout)


if __name__ == "__main__":
    unittest.main()
