#!/usr/bin/env python3
"""Regression tests for PIT membership provenance, scope, checksum, and interval integrity."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "scripts" / "research"
if str(RESEARCH) not in sys.path:
    sys.path.insert(0, str(RESEARCH))

SPEC = importlib.util.spec_from_file_location(
    "verify_pit_membership_manifest",
    RESEARCH / "verify_pit_membership_manifest.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def write_fixture(root: Path, membership_text: str, **manifest_changes):
    membership = root / "membership.csv"
    manifest = root / "membership.csv.manifest.json"
    membership.write_text(membership_text, encoding="utf-8")
    metadata = {
        "schema_version": "LUNA-PIT-MEMBERSHIP-V1",
        "provider": "The Stock Exchange of Thailand",
        "source_url": "https://www.set.or.th/en/market/information/securities-list/constituents-list-set50-set100",
        "authority_level": "PRIMARY_EXCHANGE",
        "retrieved_at": "2026-10-11T00:00:00Z",
        "membership_file_sha256": hashlib.sha256(membership.read_bytes()).hexdigest(),
        "membership_row_count": 2,
        "universe_definition": "Synthetic fixture for test only; not production membership evidence",
    }
    metadata.update(manifest_changes)
    manifest.write_text(json.dumps(metadata), encoding="utf-8")
    return membership, manifest


def test_valid_provenance_and_hash() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        membership, manifest = write_fixture(
            root,
            "symbol,start_date,end_date\nPTT,2001-01-01,\nABC,2020-01-01,2024-12-31\n",
        )
        result = MODULE.verify(membership, manifest)
        assert result["status"] == "PASS"
        assert result["membership_rows"] == 2
        assert result["unique_symbols"] == 2


def test_rejects_bad_checksum() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        membership, manifest = write_fixture(
            root,
            "symbol,start_date,end_date\nPTT,2001-01-01,\nABC,2020-01-01,2024-12-31\n",
            membership_file_sha256="0" * 64,
        )
        try:
            MODULE.verify(membership, manifest)
        except ValueError as exc:
            assert "PIT_MEMBERSHIP_SHA256_MISMATCH" in str(exc)
        else:
            raise AssertionError("a bad membership checksum must fail closed")


def test_rejects_non_authoritative_host() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        membership, manifest = write_fixture(
            root,
            "symbol,start_date,end_date\nPTT,2001-01-01,\nABC,2020-01-01,2024-12-31\n",
            source_url="https://example.com/member-list.csv",
        )
        try:
            MODULE.verify(membership, manifest)
        except ValueError as exc:
            assert "PIT_MANIFEST_SOURCE_DOMAIN_NOT_ALLOWED" in str(exc)
        else:
            raise AssertionError("an unapproved source domain must fail closed")


def test_rejects_overlapping_symbol_intervals() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        membership, manifest = write_fixture(
            root,
            "symbol,start_date,end_date\nPTT,2001-01-01,2020-12-31\nPTT,2020-06-01,\n",
        )
        try:
            MODULE.verify(membership, manifest)
        except ValueError as exc:
            assert "PIT_MEMBERSHIP_OVERLAPPING_INTERVALS" in str(exc)
        else:
            raise AssertionError("overlapping membership intervals must fail closed")


def test_rejects_row_count_mismatch() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        membership, manifest = write_fixture(
            root,
            "symbol,start_date,end_date\nPTT,2001-01-01,\nABC,2020-01-01,2024-12-31\n",
            membership_row_count=3,
        )
        try:
            MODULE.verify(membership, manifest)
        except ValueError as exc:
            assert "PIT_MANIFEST_ROW_COUNT_MISMATCH" in str(exc)
        else:
            raise AssertionError("row-count mismatch must fail closed")


if __name__ == "__main__":
    test_valid_provenance_and_hash()
    test_rejects_bad_checksum()
    test_rejects_non_authoritative_host()
    test_rejects_overlapping_symbol_intervals()
    test_rejects_row_count_mismatch()
    print("LUNA PIT membership manifest regression: OK")
