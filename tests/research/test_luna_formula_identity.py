#!/usr/bin/env python3
"""Regression tests for immutable, run-scoped LUNA formula identities."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "scripts" / "research"
if str(RESEARCH) not in sys.path:
    sys.path.insert(0, str(RESEARCH))

from luna_formula_identity import build_identity_catalog, canonical_formula_definition  # noqa: E402

DATASET_A = hashlib.sha256(b"dataset-a").hexdigest()
DATASET_B = hashlib.sha256(b"dataset-b").hexdigest()
CONFIG = {"k": 20, "cost_bps": 20, "period": ["2021-09", "2026-08"]}


def catalog(run_id, dataset_sha=DATASET_A, terms=None, config=None):
    return build_identity_catalog(
        [{"id": "F0954", "terms": terms or [("mom1", -0.5), ("mom6", 0.5)]}],
        engine="luna-direct-supabase-1000-v1",
        run_id=run_id,
        dataset_sha256=dataset_sha,
        config=config or CONFIG,
        code_revision="abc123",
        created_at_utc="2026-10-11T00:00:00Z",
    )


def test_display_label_is_not_identity() -> None:
    a = catalog("run-a")
    b = catalog("run-b")
    changed_definition = catalog("run-a", terms=[("mom1", -0.4), ("mom6", 0.6)])
    changed_dataset = catalog("run-a", dataset_sha=DATASET_B)
    assert a["formulas"][0]["id"] == b["formulas"][0]["id"] == "F0954"
    assert len({a["formulas"][0]["formula_uid"], b["formulas"][0]["formula_uid"],
                changed_definition["formulas"][0]["formula_uid"],
                changed_dataset["formulas"][0]["formula_uid"]}) == 4


def test_definition_hash_ignores_term_order_but_not_weights() -> None:
    x = canonical_formula_definition({"terms": [("mom6", 0.5), ("mom1", -0.5)]})
    y = canonical_formula_definition({"terms": [("mom1", -0.5), ("mom6", 0.5)]})
    z = canonical_formula_definition({"terms": [("mom1", -0.5), ("mom6", 0.6)]})
    a = catalog("run-c", terms=[("mom6", 0.5), ("mom1", -0.5)])
    b = catalog("run-c", terms=[("mom1", -0.5), ("mom6", 0.5)])
    assert x == y
    assert a["formulas"][0]["formula_definition_sha256"] == b["formulas"][0]["formula_definition_sha256"]
    assert z != x


def test_configuration_change_changes_experiment_identity() -> None:
    a = catalog("run-x")
    b = catalog("run-x", config={"k": 10, "cost_bps": 20, "period": ["2021-09", "2026-08"]})
    assert a["manifest"]["experiment_sha256"] != b["manifest"]["experiment_sha256"]
    assert a["formulas"][0]["formula_uid"] != b["formulas"][0]["formula_uid"]


def test_catalog_checksum_and_validation() -> None:
    result = catalog("run-check")
    payload = {k: v for k, v in result.items() if k != "catalog_sha256"}
    checksum = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    assert checksum == result["catalog_sha256"]
    assert result["manifest"]["formula_count"] == 1
    for bad_weight in (float("nan"), float("inf")):
        try:
            catalog("bad", terms=[("mom1", bad_weight)])
        except ValueError:
            pass
        else:
            raise AssertionError("non-finite formula weights must be rejected")
    try:
        catalog("dup", terms=[("mom1", 0.2), ("mom1", 0.8)])
    except ValueError:
        pass
    else:
        raise AssertionError("duplicate factors must be rejected")


if __name__ == "__main__":
    test_display_label_is_not_identity()
    test_definition_hash_ignores_term_order_but_not_weights()
    test_configuration_change_changes_experiment_identity()
    test_catalog_checksum_and_validation()
    print("LUNA formula identity regression: OK")
