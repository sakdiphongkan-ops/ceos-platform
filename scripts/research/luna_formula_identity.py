#!/usr/bin/env python3
"""Versioned, run-scoped identities for LUNA formula research artifacts.

Display labels such as F0954 are intentionally not globally unique. Use
formula_uid plus the run manifest to identify a candidate across stored runs.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import re
from typing import Any, Mapping, Sequence

IDENTITY_SCHEMA = "luna-formula-identity/v1"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _canonical_json(value: Any) -> str:
    """Return deterministic JSON and reject non-JSON values/NaN/Infinity."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    )


def _sha256_json(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _json_round_trip(value: Any, name: str) -> Any:
    try:
        return json.loads(_canonical_json(value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be finite, JSON-serializable data") from exc


def canonical_formula_definition(formula: Mapping[str, Any]) -> dict[str, Any]:
    """Canonicalize factor terms plus candidate-specific parameters.

    Terms are order-independent but factor names must be unique. The display
    label is excluded deliberately; two different definitions must not share
    an identity merely because both were called F0954.
    """
    raw_terms = formula.get("terms")
    if not isinstance(raw_terms, Sequence) or isinstance(raw_terms, (str, bytes)) or not raw_terms:
        raise ValueError("formula terms must be a non-empty sequence")
    terms: list[dict[str, Any]] = []
    seen: set[str] = set()
    for term in raw_terms:
        if not isinstance(term, Sequence) or isinstance(term, (str, bytes)) or len(term) != 2:
            raise ValueError(f"invalid formula term: {term!r}")
        factor = str(term[0]).strip()
        if not factor:
            raise ValueError("factor names cannot be empty")
        if factor in seen:
            raise ValueError(f"duplicate factor in formula definition: {factor}")
        seen.add(factor)
        try:
            weight = float(term[1])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"factor weight must be numeric: {term!r}") from exc
        if not math.isfinite(weight):
            raise ValueError(f"factor weight must be finite: {term!r}")
        if weight == 0.0:
            weight = 0.0
        terms.append({"factor": factor, "weight": weight})
    terms.sort(key=lambda item: item["factor"])
    parameters = _json_round_trip(formula.get("parameters", {}), "formula parameters")
    if not isinstance(parameters, dict):
        raise ValueError("formula parameters must be a JSON object")
    return {"terms": terms, "parameters": parameters}


def build_identity_catalog(
    formulas: Sequence[Mapping[str, Any]],
    *,
    engine: str,
    run_id: str,
    dataset_sha256: str,
    config: Mapping[str, Any],
    code_revision: str | None = None,
    created_at_utc: str | None = None,
) -> dict[str, Any]:
    """Build an immutable manifest and run-scoped catalog for formula candidates."""
    engine = str(engine).strip()
    run_id = str(run_id).strip()
    dataset_sha256 = str(dataset_sha256).lower().strip()
    if not engine:
        raise ValueError("engine is required")
    if not run_id:
        raise ValueError("run_id is required")
    if not _SHA256_RE.fullmatch(dataset_sha256):
        raise ValueError("dataset_sha256 must be a lowercase 64-character SHA-256 hex string")
    if not formulas:
        raise ValueError("at least one formula is required")

    config_json = _json_round_trip(dict(config), "experiment config")
    config_sha256 = _sha256_json(config_json)
    experiment_payload = {
        "identity_schema": IDENTITY_SCHEMA,
        "engine": engine,
        "run_id": run_id,
        "dataset_sha256": dataset_sha256,
        "config": config_json,
        "code_revision": code_revision,
    }
    experiment_sha256 = _sha256_json(experiment_payload)
    created = created_at_utc or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    seen_ids: set[str] = set()
    catalog_entries: list[dict[str, Any]] = []
    for formula in formulas:
        display_id = str(formula.get("id", formula.get("formula_id", ""))).strip()
        if not display_id:
            raise ValueError("each formula requires a non-empty id/display label")
        if display_id in seen_ids:
            raise ValueError(f"duplicate display formula id in one run: {display_id}")
        seen_ids.add(display_id)

        definition = canonical_formula_definition(formula)
        definition_sha256 = _sha256_json(definition)
        identity_payload = {
            "identity_schema": IDENTITY_SCHEMA,
            "engine": engine,
            "run_id": run_id,
            "dataset_sha256": dataset_sha256,
            "experiment_sha256": experiment_sha256,
            "formula_id": display_id,
            "formula_definition_sha256": definition_sha256,
        }
        formula_uid = "luna_formula_v1_" + _sha256_json(identity_payload)
        catalog_entries.append({
            "id": display_id,
            "formula_id": display_id,
            "formula_uid": formula_uid,
            "formula_definition_sha256": definition_sha256,
            "experiment_sha256": experiment_sha256,
            "dataset_sha256": dataset_sha256,
            "run_id": run_id,
            "terms": [[term["factor"], term["weight"]] for term in definition["terms"]],
            "parameters": definition["parameters"],
        })

    manifest = {
        "identity_schema": IDENTITY_SCHEMA,
        "engine": engine,
        "run_id": run_id,
        "created_at_utc": created,
        "dataset_sha256": dataset_sha256,
        "experiment_config": config_json,
        "experiment_config_sha256": config_sha256,
        "experiment_sha256": experiment_sha256,
        "code_revision": code_revision,
        "formula_count": len(catalog_entries),
    }
    catalog_payload = {"identity_schema": IDENTITY_SCHEMA, "manifest": manifest, "formulas": catalog_entries}
    return {**catalog_payload, "catalog_sha256": _sha256_json(catalog_payload)}
