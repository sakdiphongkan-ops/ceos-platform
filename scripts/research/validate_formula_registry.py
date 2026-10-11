#!/usr/bin/env python3
"""Fail-closed validation for the durable LUNA formula registry.

The registry is the canonical human/audit record; Supabase retains the catalog,
run configuration, and monthly returns. A chat response alone is not persistence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


REQUIRED_TOP_LEVEL = {
    "schema_version",
    "record_type",
    "formula_id",
    "version",
    "status",
    "promotion_approved",
    "formula_sha256",
    "hash_payload",
    "definition",
    "research_run",
    "limitations",
    "promotion_gates",
}
REQUIRED_PAYLOAD = {
    "formula_id",
    "version",
    "factors",
    "transform",
    "score_expression",
    "holdings",
    "rebalance",
    "weighting",
    "tie_break",
    "gross_return",
    "turnover",
    "cost_model",
}


class RegistryValidationError(ValueError):
    """Raised when a formula artifact lacks durable identity or provenance."""


def canonical_sha256(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_record(record: dict[str, Any], path: Path | str = Path("<memory>")) -> None:
    missing = sorted(REQUIRED_TOP_LEVEL - set(record))
    if missing:
        raise RegistryValidationError(f"{path}: missing fields: {', '.join(missing)}")

    if record["schema_version"] != "1.0":
        raise RegistryValidationError(f"{path}: unsupported schema_version")
    if record["record_type"] != "immutable_formula_candidate":
        raise RegistryValidationError(f"{path}: unexpected record_type")

    formula_id = record["formula_id"]
    version = record["version"]
    if not isinstance(formula_id, str) or not formula_id.strip():
        raise RegistryValidationError(f"{path}: formula_id must be a non-empty string")
    if not isinstance(version, str) or not version.strip():
        raise RegistryValidationError(f"{path}: version must be a non-empty string")

    payload = record["hash_payload"]
    if not isinstance(payload, dict):
        raise RegistryValidationError(f"{path}: hash_payload must be an object")
    missing_payload = sorted(REQUIRED_PAYLOAD - set(payload))
    if missing_payload:
        raise RegistryValidationError(
            f"{path}: hash_payload missing fields: {', '.join(missing_payload)}"
        )
    if payload["formula_id"] != formula_id or payload["version"] != version:
        raise RegistryValidationError(f"{path}: hash payload identity differs from record")
    if not isinstance(payload["factors"], list) or not payload["factors"]:
        raise RegistryValidationError(f"{path}: hash payload factors must be non-empty")
    for factor in payload["factors"]:
        if not isinstance(factor, dict) or not isinstance(factor.get("column"), str):
            raise RegistryValidationError(f"{path}: malformed factor definition")
        if not isinstance(factor.get("weight"), (int, float)):
            raise RegistryValidationError(f"{path}: factor weight must be numeric")

    expected_hash = canonical_sha256(payload)
    actual_hash = record["formula_sha256"]
    if not isinstance(actual_hash, str) or actual_hash != expected_hash:
        raise RegistryValidationError(
            f"{path}: formula_sha256 mismatch; expected {expected_hash}"
        )

    definition = record["definition"]
    if not isinstance(definition, dict):
        raise RegistryValidationError(f"{path}: definition must be an object")
    if definition.get("factors") != payload["factors"]:
        raise RegistryValidationError(f"{path}: definition factors differ from hash payload")
    if definition.get("score_expression") != payload["score_expression"]:
        raise RegistryValidationError(f"{path}: score expression differs from hash payload")

    run = record["research_run"]
    if not isinstance(run, dict):
        raise RegistryValidationError(f"{path}: research_run must be an object")
    for field in ("run_id", "database_formula_id", "dataset_id", "database_monthly_return_rows"):
        if field not in run or run[field] in (None, ""):
            raise RegistryValidationError(f"{path}: research_run.{field} is required")
    if not isinstance(run["database_formula_id"], int) or run["database_formula_id"] < 0:
        raise RegistryValidationError(f"{path}: database_formula_id must be a non-negative integer")
    if not isinstance(run["database_monthly_return_rows"], int) or run["database_monthly_return_rows"] < 1:
        raise RegistryValidationError(f"{path}: at least one monthly return row is required")
    if not isinstance(run.get("stored_return_month_range"), list) or len(run["stored_return_month_range"]) != 2:
        raise RegistryValidationError(f"{path}: stored_return_month_range must have start and end")
    if not run.get("dataset_name") or not run.get("source"):
        raise RegistryValidationError(f"{path}: dataset name and source are required")

    if record["status"] == "PAPER_SHADOW_ONLY" and record["promotion_approved"] is not False:
        raise RegistryValidationError(f"{path}: paper-only candidate cannot be promotion-approved")
    if record.get("related_missing_formula") and record.get("recovered_original") is True:
        raise RegistryValidationError(f"{path}: cannot mark related missing formula recovered without provenance")
    if not isinstance(record["limitations"], list) or not record["limitations"]:
        raise RegistryValidationError(f"{path}: limitations must be a non-empty list")
    if not isinstance(record["promotion_gates"], list) or not record["promotion_gates"]:
        raise RegistryValidationError(f"{path}: promotion_gates must be a non-empty list")


def validate_directory(root: Path) -> int:
    files = sorted(root.rglob("*.json"))
    if not files:
        raise RegistryValidationError(f"{root}: no JSON formula records found")
    valid = 0
    for path in files:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("record_type") != "immutable_formula_candidate":
                raise RegistryValidationError(f"{path}: unexpected record_type")
            validate_record(record, path)
            valid += 1
            print(f"PASS {path}")
        except (OSError, json.JSONDecodeError, RegistryValidationError) as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            raise
    print(f"Validated {valid} immutable formula record(s).")
    return valid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("research-results/formula-registry"),
        help="Folder containing immutable formula JSON records",
    )
    args = parser.parse_args()
    try:
        validate_directory(args.root)
    except (OSError, RegistryValidationError) as exc:
        print(f"Formula registry validation failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
