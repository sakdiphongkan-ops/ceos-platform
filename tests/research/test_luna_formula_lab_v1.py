from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.research.luna_formula_lab_v1 import (
    CANDIDATES,
    EXPECTED_FORMULA_HASHES,
    evaluate_candidate,
    load_monthly_factors,
    run_lab,
)


class LunaFormulaLabTests(unittest.TestCase):
    def test_canonical_formula_hashes_match_saved_registry(self) -> None:
        for candidate in CANDIDATES:
            with self.subTest(formula_id=candidate.formula_id):
                self.assertEqual(
                    candidate.sha256(),
                    EXPECTED_FORMULA_HASHES[candidate.database_formula_id],
                )

    def _write_synthetic_panel(self, missing_symbol: str | None = None) -> str:
        rows = []
        symbols = [f"S{i:02d}" for i in range(21)]
        months = [pd.Period("2026-07", "M"), pd.Period("2026-08", "M"), pd.Period("2026-09", "M")]
        for position, symbol in enumerate(symbols):
            for month_index, month in enumerate(months):
                if symbol == missing_symbol and month == pd.Period("2026-09", "M"):
                    continue
                rows.append({
                    "dataset_id": "synthetic-set",
                    "symbol": symbol,
                    "month_end": month.to_timestamp(),
                    "adj_close": 100.0 + position + month_index,
                    "mom1": float(position - 10),
                    "mom3": float(position - 10),
                    "mom6": float(position - 10),
                    "mom12": float(position - 10),
                    "high52_ratio": float(position + 1) / 22.0,
                    "vol20": 0.01 + position / 10000.0,
                    "maxdd60": None,
                    "avg_amount20": 1_000_000.0 + position * 1_000.0,
                })
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", encoding="utf-8", delete=False) as handle:
            pd.DataFrame(rows).to_csv(handle.name, index=False)
            return handle.name

    def test_missing_forward_return_does_not_replace_selected_symbol(self) -> None:
        # S00 is the lowest mom1 name and therefore belongs in M1_REV top 20.
        # It has no September price. Correct behavior keeps S00 in the frozen
        # August selection and marks August incomplete, rather than promoting S20.
        path = self._write_synthetic_panel(missing_symbol="S00")
        try:
            frame = load_monthly_factors(path)
            monthly, selected = evaluate_candidate(frame, CANDIDATES[0], k=20)
            august = monthly.loc[monthly["formation_month"] == "2026-08"].iloc[0]
            august_names = set(
                selected.loc[selected["formation_month"] == "2026-08", "symbol"]
            )

            self.assertEqual(august["selected_count"], 20)
            self.assertEqual(august["valid_forward_outcomes"], 19)
            self.assertFalse(august["outcome_complete"])
            self.assertEqual(august["missing_selected_symbols"], ["S00"])
            self.assertIn("S00", august_names)
            self.assertNotIn("S20", august_names)
            self.assertTrue(pd.isna(august["gross_return"]))
            self.assertTrue(pd.isna(august["net_return_20bps"]))
        finally:
            Path(path).unlink(missing_ok=True)

    def _write_export_manifest(self, csv_path: str, output_sha256: str | None = None) -> Path:
        frame = pd.read_csv(csv_path)
        payload = {
            "schema_version": "1.0",
            "record_type": "supabase_monthly_factor_export_manifest",
            "source_table": "public.synthetic_monthly_factors",
            "dataset_ids": ["synthetic-set"],
            "rows": int(len(frame)),
            "symbols": int(frame["symbol"].nunique()),
            "output_sha256": output_sha256 or hashlib.sha256(Path(csv_path).read_bytes()).hexdigest(),
            "exported_at_utc": "2026-10-12T00:00:00+00:00",
        }
        path = Path(csv_path).with_suffix(".manifest.json")
        path.write_text(json.dumps(payload, indent=2) + "\\n", encoding="utf-8")
        return path

    def test_runner_verifies_export_manifest_hash_and_counts(self) -> None:
        csv_path = self._write_synthetic_panel()
        try:
            self._write_export_manifest(csv_path)
            with tempfile.TemporaryDirectory() as out_dir:
                manifest = run_lab(csv_path, out_dir)
                self.assertEqual(
                    manifest["source_export_manifest"]["status"],
                    "VERIFIED_EXPORT_FILE_HASH_AND_COUNTS",
                )
                self.assertEqual(
                    manifest["source_export_manifest"]["dataset_ids"],
                    ["synthetic-set"],
                )
                self.assertEqual(
                    manifest["dataset_sha256"],
                    hashlib.sha256(Path(csv_path).read_bytes()).hexdigest(),
                )
        finally:
            Path(csv_path).unlink(missing_ok=True)
            Path(csv_path).with_suffix(".manifest.json").unlink(missing_ok=True)

    def test_runner_rejects_mismatched_export_manifest(self) -> None:
        csv_path = self._write_synthetic_panel()
        try:
            manifest_path = self._write_export_manifest(csv_path, output_sha256="0" * 64)
            with tempfile.TemporaryDirectory() as out_dir:
                with self.assertRaisesRegex(ValueError, "Export manifest SHA-256 mismatch"):
                    run_lab(csv_path, out_dir)
        finally:
            Path(csv_path).unlink(missing_ok=True)
            Path(csv_path).with_suffix(".manifest.json").unlink(missing_ok=True)

    def test_valid_month_net_returns_apply_turnover_cost(self) -> None:
        path = self._write_synthetic_panel()
        try:
            frame = load_monthly_factors(path)
            monthly, _ = evaluate_candidate(frame, CANDIDATES[0], k=20, cost_bps=(20.0, 30.0, 40.0))
            valid = monthly.loc[monthly["outcome_complete"]].copy()
            self.assertFalse(valid.empty)
            first = valid.iloc[0]
            expected20 = first["gross_return"] - 0.002 * first["turnover"]
            expected30 = first["gross_return"] - 0.003 * first["turnover"]
            expected40 = first["gross_return"] - 0.004 * first["turnover"]
            self.assertAlmostEqual(first["net_return_20bps"], expected20, places=12)
            self.assertAlmostEqual(first["net_return_30bps"], expected30, places=12)
            self.assertAlmostEqual(first["net_return_40bps"], expected40, places=12)
        finally:
            Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
