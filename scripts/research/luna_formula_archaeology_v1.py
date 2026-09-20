#!/usr/bin/env python3
"""LUNA Formula Archaeology v1.

Turns an already-completed adaptive tournament into an auditable Formula Genome
and mechanism report. No performance selection or holdout optimization is done
here: the report is descriptive only.

Inputs:
  - formula_catalog.json
  - adaptive_selection_ledger.csv
  - optional frozen_holdout_ranked.csv

Outputs:
  - summary.json
  - recurring_formulas.csv
  - factor_contribution.csv
  - factor_pair_cooccurrence.csv
  - mechanism_clusters.csv
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd


FAMILY = {
    "mom1": "short_reversal",
    "mom3": "short_reversal",
    "mom6": "medium_momentum_reversal",
    "mom12": "long_momentum_reversal",
    "high52_ratio": "52w_position",
    "vol20": "volatility",
    "maxdd60": "drawdown_risk",
    "avg_amount20": "liquidity",
}


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    keys = sorted(set(a) | set(b))
    av = np.array([a.get(k, 0.0) for k in keys], dtype=float)
    bv = np.array([b.get(k, 0.0) for k in keys], dtype=float)
    den = float(np.linalg.norm(av) * np.linalg.norm(bv))
    return float(np.dot(av, bv) / den) if den else 0.0


def load_catalog(path: Path) -> dict[str, dict[str, float]]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for item in rows:
        weights = {str(f): float(w) for f, w in item.get("terms", [])}
        out[str(item["id"])] = weights
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--holdout")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    catalog = load_catalog(Path(args.catalog))
    ledger = pd.read_csv(args.ledger)
    if "formula_id" not in ledger.columns:
        raise SystemExit("ledger must contain formula_id")

    holdout = pd.read_csv(args.holdout) if args.holdout else pd.DataFrame()

    # Selection frequency is the strongest descriptive signal available here,
    # because the walk-forward engine selected these formulas using only prior months.
    freq = ledger["formula_id"].value_counts().rename_axis("formula_id").reset_index(name="selected_months")
    freq["selection_share"] = freq["selected_months"] / max(len(ledger), 1)

    recurring_rows = []
    for r in freq.itertuples(index=False):
        w = catalog.get(r.formula_id, {})
        recurring_rows.append({
            "formula_id": r.formula_id,
            "selected_months": int(r.selected_months),
            "selection_share": float(r.selection_share),
            "formula_terms": ";".join(f"{k}:{w[k]:+.4f}" for k in sorted(w)),
            "term_count": len(w),
            "cosine_to_m1": cosine(w, catalog.get("M1_REV_K20", {"mom1": -1.0})),
        })
    recurring = pd.DataFrame(recurring_rows).sort_values(
        ["selected_months", "cosine_to_m1"], ascending=[False, False]
    )
    recurring.to_csv(out / "recurring_formulas.csv", index=False)

    # Weight exposure across the formulas actually selected by the adaptive engine.
    factor_rows = []
    total_selection_events = len(ledger)
    for factor, family in FAMILY.items():
        occurrences = []
        signed_weights = []
        abs_weights = []
        for fid, count in freq.set_index("formula_id")["selected_months"].items():
            w = catalog.get(fid, {}).get(factor)
            if w is not None:
                occurrences.extend([1] * int(count))
                signed_weights.extend([float(w)] * int(count))
                abs_weights.extend([abs(float(w))] * int(count))
        factor_rows.append({
            "factor": factor,
            "family": family,
            "selected_formula_occurrence_months": len(occurrences),
            "selection_event_coverage": len(occurrences) / max(total_selection_events, 1),
            "mean_signed_weight_when_present": float(np.mean(signed_weights)) if signed_weights else 0.0,
            "median_signed_weight_when_present": float(np.median(signed_weights)) if signed_weights else 0.0,
            "mean_abs_weight_when_present": float(np.mean(abs_weights)) if abs_weights else 0.0,
        })
    factor_df = pd.DataFrame(factor_rows).sort_values(
        ["selection_event_coverage", "mean_abs_weight_when_present"],
        ascending=False
    )
    factor_df.to_csv(out / "factor_contribution.csv", index=False)

    # Pair co-occurrence: which factor interactions repeatedly appear in selected formulas.
    pair_counts = Counter()
    for fid, count in freq.set_index("formula_id")["selected_months"].items():
        fs = sorted(catalog.get(fid, {}))
        for i, a in enumerate(fs):
            for b in fs[i + 1:]:
                pair_counts[(a, b)] += int(count)

    pair_rows = []
    for (a, b), count in pair_counts.most_common():
        pair_rows.append({
            "factor_a": a,
            "factor_b": b,
            "pair_selection_months": int(count),
            "pair_event_coverage": count / max(total_selection_events, 1),
            "family_a": FAMILY.get(a, "other"),
            "family_b": FAMILY.get(b, "other"),
        })
    pairs = pd.DataFrame(pair_rows)
    if not pairs.empty:
        pairs.to_csv(out / "factor_pair_cooccurrence.csv", index=False)
    else:
        pd.DataFrame(columns=[
            "factor_a","factor_b","pair_selection_months","pair_event_coverage",
            "family_a","family_b"
        ]).to_csv(out / "factor_pair_cooccurrence.csv", index=False)

    # Mechanism clusters are descriptive buckets, not rankings.
    clusters = defaultdict(lambda: {"formulas": set(), "selected_months": 0})
    for fid, count in freq.set_index("formula_id")["selected_months"].items():
        weights = catalog.get(fid, {})
        signed = {k: float(v) for k, v in weights.items()}
        has_rev = any(k in signed and signed[k] < 0 for k in ("mom1", "mom3"))
        has_mom = any(k in signed and signed[k] > 0 for k in ("mom6", "mom12"))
        has_52 = "high52_ratio" in signed
        has_lowvol = signed.get("vol20", 0) < 0
        has_drawdown = "maxdd60" in signed
        has_liquidity = "avg_amount20" in signed
        if has_rev and has_52 and has_lowvol:
            key = "reversal + 52w-position + low-volatility"
        elif has_rev and has_52:
            key = "reversal + 52w-position"
        elif has_rev and has_lowvol:
            key = "reversal + low-volatility"
        elif has_rev and has_liquidity:
            key = "reversal + liquidity"
        elif has_mom and has_52 and has_lowvol:
            key = "medium/long momentum + 52w-position + low-volatility"
        elif has_mom and has_52:
            key = "medium/long momentum + 52w-position"
        elif has_drawdown and has_lowvol:
            key = "drawdown + low-volatility"
        else:
            key = "mixed/other"
        clusters[key]["formulas"].add(fid)
        clusters[key]["selected_months"] += int(count)

    cluster_rows = []
    for name, x in sorted(
        clusters.items(),
        key=lambda kv: (-kv[1]["selected_months"], kv[0])
    ):
        cluster_rows.append({
            "mechanism_cluster": name,
            "distinct_formulas": len(x["formulas"]),
            "selected_months": x["selected_months"],
            "selection_event_coverage": x["selected_months"] / max(total_selection_events, 1),
        })
    cluster_df = pd.DataFrame(cluster_rows)
    cluster_df.to_csv(out / "mechanism_clusters.csv", index=False)

    holdout_note = None
    if not holdout.empty and "formula_id" in holdout.columns:
        selected_fids = set(freq["formula_id"])
        overlap = holdout[holdout["formula_id"].isin(selected_fids)].copy()
        holdout_note = {
            "rows_matching_selected_formulas": int(len(overlap)),
            "note": "Holdout values are reported only as an external diagnostic; archaeology does not rank or select formulas from them."
        }

    summary = {
        "status": "COMPLETED",
        "engine": "luna-formula-archaeology-v1",
        "catalog_formula_count": len(catalog),
        "selection_events": int(total_selection_events),
        "distinct_selected_formulas": int(freq["formula_id"].nunique()) if not freq.empty else 0,
        "top_recurring_formulas": recurring.head(15).to_dict(orient="records"),
        "factor_contribution": factor_df.to_dict(orient="records"),
        "top_factor_pairs": pairs.head(20).to_dict(orient="records") if not pairs.empty else [],
        "mechanism_clusters": cluster_df.to_dict(orient="records"),
        "holdout_diagnostic": holdout_note,
        "guards": {
            "descriptive_only": True,
            "no_holdout_selection": True,
            "selection_frequency_comes_from_walk_forward_ledger": True,
        },
    }
    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
