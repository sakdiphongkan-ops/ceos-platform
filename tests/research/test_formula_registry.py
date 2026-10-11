from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.research.validate_formula_registry import (
    RegistryValidationError,
    canonical_sha256,
    validate_record,
)


def sample_record() -> dict:
    payload = {
        "formula_id": "TEST_FORMULA",
        "version": "1.0.0",
        "factors": [
            {"column": "mom1", "weight": -0.7},
            {"column": "mom3", "weight": -0.3},
        ],
        "transform": "percent_rank_ascending_within_month",
        "score_expression": "-0.70*prank(mom1)-0.30*prank(mom3)",
        "holdings": 20,
        "rebalance": "monthly",
        "weighting": "equal_weight",
        "tie_break": "symbol ASC",
        "gross_return": "mean(next_adj_close/current_adj_close - 1)",
        "turnover": "1 - count(current_holdings intersect previous_month_holdings)/20",
        "cost_model": "net_return = gross_return - 0.002 * turnover",
    }
    return {
        "schema_version": "1.0",
        "record_type": "immutable_formula_candidate",
        "formula_id": "TEST_FORMULA",
        "version": "1.0.0",
        "status": "PAPER_SHADOW_ONLY",
        "promotion_approved": False,
        "formula_sha256": canonical_sha256(payload),
        "hash_payload": payload,
        "definition": {
            "factors": copy.deepcopy(payload["factors"]),
            "score_expression": payload["score_expression"],
        },
        "research_run": {
            "run_id": "test-run",
            "database_formula_id": 2000,
            "database_monthly_return_rows": 57,
            "stored_return_month_range": ["2021-12-01", "2026-08-01"],
            "dataset_id": "test-dataset",
            "dataset_name": "test-data",
            "source": "test-source",
        },
        "limitations": ["PIT universe has not yet been verified."],
        "promotion_gates": ["Complete PIT data validation."],
    }


class FormulaRegistryValidatorTests(unittest.TestCase):
    def test_accepts_complete_hashed_paper_only_record(self) -> None:
        validate_record(sample_record(), Path("valid.json"))

    def test_rejects_tampered_formula_hash(self) -> None:
        record = sample_record()
        record["hash_payload"]["factors"][0]["weight"] = -0.8
        with self.assertRaisesRegex(RegistryValidationError, "formula_sha256 mismatch"):
            validate_record(record, Path("tampered.json"))

    def test_rejects_paper_only_candidate_approved_for_promotion(self) -> None:
        record = sample_record()
        record["promotion_approved"] = True
        with self.assertRaisesRegex(RegistryValidationError, "cannot be promotion-approved"):
            validate_record(record, Path("unsafe.json"))

    def test_rejects_missing_research_run_id(self) -> None:
        record = sample_record()
        record["research_run"]["run_id"] = None
        with self.assertRaisesRegex(RegistryValidationError, "research_run.run_id is required"):
            validate_record(record, Path("untraceable.json"))

    def test_rejects_definition_that_disagrees_with_hash_payload(self) -> None:
        record = sample_record()
        record["definition"]["score_expression"] = "different formula"
        with self.assertRaisesRegex(RegistryValidationError, "score expression differs"):
            validate_record(record, Path("mismatch.json"))


if __name__ == "__main__":
    unittest.main()
