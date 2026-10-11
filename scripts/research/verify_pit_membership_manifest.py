#!/usr/bin/env python3
"""Validate the provenance, checksum, and date-interval contract for LUNA PIT membership."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from apply_pit_universe import load_membership

ALLOWED_DOMAINS = ("set.or.th", "settrade.com")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_intervals(rows: list[tuple[str, object, object]]) -> None:
    """Reject overlapping active windows that make symbol eligibility ambiguous."""
    by_symbol: dict[str, list[tuple[object, object]]] = defaultdict(list)
    for symbol, start, end in rows:
        by_symbol[symbol].append((start, end))
    for symbol, intervals in by_symbol.items():
        intervals.sort(key=lambda item: item[0])
        previous_start = previous_end = None
        for start, end in intervals:
            if previous_start is not None and (previous_end is None or start <= previous_end):
                raise ValueError(
                    f"PIT_MEMBERSHIP_OVERLAPPING_INTERVALS:{symbol}:"
                    f"{previous_start}..{previous_end or 'open'} overlaps {start}..{end or 'open'}"
                )
            previous_start, previous_end = start, end


def verify(membership: Path, manifest: Path, allowed_domains: tuple[str, ...] = ALLOWED_DOMAINS) -> dict:
    if not membership.is_file() or not manifest.is_file():
        raise ValueError("PIT_MEMBERSHIP_AND_MANIFEST_REQUIRED")

    m = json.loads(manifest.read_text(encoding="utf-8"))
    required = (
        "schema_version",
        "provider",
        "source_url",
        "authority_level",
        "retrieved_at",
        "membership_file_sha256",
        "membership_row_count",
        "universe_definition",
    )
    for key in required:
        if not str(m.get(key, "")).strip():
            raise ValueError(f"PIT_MANIFEST_MISSING:{key}")
    if m["schema_version"] != "LUNA-PIT-MEMBERSHIP-V1":
        raise ValueError("PIT_MANIFEST_SCHEMA_INVALID")
    if m["authority_level"] not in {"PRIMARY_EXCHANGE", "INDEX_PROVIDER", "ISSUER_OFFICIAL"}:
        raise ValueError("PIT_MANIFEST_AUTHORITY_LEVEL_INVALID")
    if not SHA256_RE.fullmatch(str(m["membership_file_sha256"]).lower()):
        raise ValueError("PIT_MANIFEST_SHA256_FORMAT_INVALID")
    actual_hash = sha256(membership)
    if str(m["membership_file_sha256"]).lower() != actual_hash:
        raise ValueError("PIT_MEMBERSHIP_SHA256_MISMATCH")

    retrieved_at = datetime.fromisoformat(str(m["retrieved_at"]).replace("Z", "+00:00"))
    if retrieved_at.tzinfo is None:
        raise ValueError("PIT_MANIFEST_RETRIEVED_AT_MUST_INCLUDE_TIMEZONE")

    url = urlparse(str(m["source_url"]))
    host = (url.hostname or "").lower()
    allowed = tuple(domain.strip().lower() for domain in allowed_domains if domain.strip())
    if url.scheme != "https" or not any(host == d or host.endswith("." + d) for d in allowed):
        raise ValueError(f"PIT_MANIFEST_SOURCE_DOMAIN_NOT_ALLOWED:{host}")

    rows = load_membership(str(membership))
    validate_intervals(rows)
    if int(m["membership_row_count"]) != len(rows):
        raise ValueError(
            f"PIT_MANIFEST_ROW_COUNT_MISMATCH:manifest={m['membership_row_count']}:actual={len(rows)}"
        )
    if not str(m["provider"]).strip() or not str(m["universe_definition"]).strip():
        raise ValueError("PIT_MANIFEST_PROVIDER_AND_UNIVERSE_DEFINITION_REQUIRED")

    return {
        "status": "PASS",
        "membership_sha256": actual_hash,
        "membership_rows": len(rows),
        "unique_symbols": len({row[0] for row in rows}),
        "source_url": m["source_url"],
        "provider": m["provider"],
        "authority_level": m["authority_level"],
        "universe_definition": m["universe_definition"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--membership", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--allowed-domains", default=",".join(ALLOWED_DOMAINS))
    args = ap.parse_args()
    allowed = tuple(x.strip() for x in args.allowed_domains.split(",") if x.strip())
    try:
        result = verify(Path(args.membership), Path(args.manifest), allowed)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise SystemExit(str(exc)) from exc
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
