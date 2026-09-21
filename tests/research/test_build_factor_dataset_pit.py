#!/usr/bin/env python3
"""Regression test for LUNA field-level PIT fundamental joins."""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "research" / "build_factor_dataset.py"


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        prices = tmp / "prices.csv"
        fundamentals = tmp / "fundamentals.csv"
        output = tmp / "factors.csv"

        dates = pd.date_range("2026-01-02", periods=5, freq="B")
        price_rows = []
        for symbol, base in [("AAA", 10.0), ("BBB", 20.0)]:
            for i, day in enumerate(dates):
                price_rows.append({
                    "date": day.date().isoformat(),
                    "symbol": symbol,
                    "open": base + i,
                    "high": base + i + 0.5,
                    "low": base + i - 0.5,
                    "close": base + i,
                    "volume": 100000,
                    "adj_close": base + i,
                    "amount": (base + i) * 100000,
                })
        with prices.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=price_rows[0].keys())
            writer.writeheader()
            writer.writerows(price_rows)

        fund_rows = [
            # Same symbol, different source timestamps and sparse fields.
            {"symbol": "AAA", "available_at": "2026-01-02T16:00:00Z", "pe": 8.0, "roe": ""},
            {"symbol": "AAA", "available_at": "2026-01-03T16:00:00Z", "pe": "", "roe": 12.0},
            {"symbol": "BBB", "available_at": "2026-01-02T16:00:00Z", "pe": 9.0, "roe": ""},
            {"symbol": "BBB", "available_at": "2026-01-03T16:00:00Z", "pe": "", "roe": 11.0},
        ]
        with fundamentals.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=fund_rows[0].keys())
            writer.writeheader()
            writer.writerows(fund_rows)

        subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--prices", str(prices),
                "--fundamentals", str(fundamentals),
                "--output", str(output),
            ],
            check=True,
            cwd=ROOT,
        )

        out = pd.read_csv(output)
        row = out[(out.symbol == "AAA") & (out.date == "2026-01-05")].iloc[0]
        assert abs(row["PE"] - 8.0) < 1e-12, row.to_dict()
        assert abs(row["ROE"] - 12.0) < 1e-12, row.to_dict()

        manifest = json.loads(output.with_suffix(".manifest.json").read_text())
        assert manifest["pit_future_rows"] == 0
        assert "PE" in manifest["pit_fundamental_fields_covered"]
        assert "ROE" in manifest["pit_fundamental_fields_covered"]

        print("PIT field-level merge regression: OK")


if __name__ == "__main__":
    main()
