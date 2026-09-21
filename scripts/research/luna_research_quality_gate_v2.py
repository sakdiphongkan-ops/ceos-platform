#!/usr/bin/env python3
"""LUNA research quality gate v2.

This is an auditable gate layered on top of formula search. It never changes
formula selection and never reads the frozen holdout to tune a formula.

Hard checks:
- positive frozen holdout
- positive nested outer OOS
- positive development IC and ICIR
- positive 45 bps holdout return at K=20
- positive holdout across K=10/20/30/50 at 20 bps
- positive neutralized IC

Diagnostics:
- crowding warning when max abs rank correlation exceeds a configurable level
- fresh-seed replication evidence is required for promotion, but absence here
  remains a research-only flag rather than an execution failure.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--summary", required=True)
    ap.add_argument("--scorecard", required=True)
    ap.add_argument("--neutralized", required=True)
    ap.add_argument("--replication", required=False)
    ap.add_argument("--universe", required=False)
    ap.add_argument("--sector-neutralization", required=False)
    ap.add_argument("--output", required=True)
    ap.add_argument("--max-crowding-warning", type=float, default=0.90)
    args = ap.parse_args()

    summary = load(args.summary)
    score = load(args.scorecard)
    neutral = load(args.neutralized)
    replication = load(args.replication) if args.replication else {}
    universe = load(args.universe) if args.universe else {}
    sector = load(args.sector_neutralization) if args.sector_neutralization else {}

    checks = score.get("promotion_checks", {})
    hard = {
        "holdout_geo_positive": bool(checks.get("holdout_geo_positive", False)),
        "outer_oos_geo_positive": bool(checks.get("outer_oos_geo_positive", False)),
        "development_ic_positive": bool(checks.get("ic_mean_positive", False)),
        "development_icir_positive": bool(checks.get("icir_positive", False)),
        "cost_45bps_holdout_positive": bool(checks.get("cost_45bps_holdout_positive", False)),
        "k_stability_positive": bool(checks.get("k10_k20_k30_k50_all_positive_at20bps", False)),
        "neutralized_ic_positive": bool(float(neutral.get("neutral_ic_mean", -math.inf)) > 0),
        "universe_stress_available": universe.get("status") == "COMPLETED",
        "universe_stress_holdout_median_positive": bool(
            float(universe.get("random_dropout", {}).get("median_holdout_geo", -math.inf)) > 0
        ),
        "sector_neutralization_available": sector.get("status") == "COMPLETED",
    }

    crowding = neutral.get("crowding_max_abs_corr")
    crowding_warning = (
        crowding is not None and math.isfinite(float(crowding))
        and float(crowding) > args.max_crowding_warning
    )

    fresh_seed_replication = bool(replication.get("replication_pass", False))

    failed = [k for k, v in hard.items() if not v]
    result = {
        "status": "COMPLETED",
        "engine": "luna-research-quality-gate-v2",
        "candidate_formula_id": summary.get("final_formula", {}).get("id"),
        "hard_gate": {
            "pass": not failed,
            "failed_checks": failed,
            "checks": hard,
        },
        "diagnostics": {
            "neutral_ic_mean": neutral.get("neutral_ic_mean"),
            "neutral_icir_annualized": neutral.get("neutral_icir_annualized"),
            "neutral_churn_mean": neutral.get("neutral_churn_mean"),
            "crowding_max_abs_corr": crowding,
            "crowding_warning": crowding_warning,
            "fresh_seed_replication_evidence_present": fresh_seed_replication,
            "fresh_seed_replication": replication.get("runs", []),
            "universe_robustness": universe,
            "sector_industry_neutralization": sector,
        },
        "promotion_status": (
            "PROMOTION_ELIGIBLE_PENDING_FRESH_SEED_REPLICATION"
            if not failed and fresh_seed_replication
            else "RESEARCH_ONLY"
        ),
        "guardrails": [
            "No formula selection is changed by this gate.",
            "Frozen holdout is never used to tune or re-select the candidate.",
            "A passing gate is not permission to trade live without execution and broker checks.",
        ],
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
