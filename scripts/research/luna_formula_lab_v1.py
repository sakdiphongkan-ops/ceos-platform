#!/usr/bin/env python3
"""Reproducible, fail-closed runner for the LUNA eight-candidate theory-driven family.

This runner is intentionally a research tool, not an order-generation tool.
It uses factor values at the formation month only, freezes the top-K selection
before checking forward outcomes, and marks any candidate-month with missing
selected outcomes incomplete. It never replaces a selected name with rank K+1.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

SCRIPT_VERSION = "luna_formula_lab_v1.0.0"
FACTOR_TRANSFORM = "percent_rank_ascending_within_month_on_non_null_factor_values"
GROSS_RETURN_SPEC = "mean(next_adj_close/current_adj_close - 1)"
TURNOVER_SPEC = "1 - count(current_holdings intersect previous_month_holdings)/20"
COST_MODEL_SPEC = "net_return = gross_return - 0.002 * turnover"
MISSING_OUTCOME_POLICY = (
    "fail_closed_month_if_any_selected_symbol_has_no_next_calendar_month_adjusted_close; "
    "never_filter_by_forward_outcome_before_ranking; never_substitute_rank_21"
)

# The baseline uses an integer -1 in the canonical hash payload, matching the
# saved registry JSON. Other factors deliberately preserve their decimal weights.
@dataclass(frozen=True)
class Candidate:
    formula_id: str
    version: str
    weights: tuple[tuple[str, int | float], ...]
    score_expression: str
    database_formula_id: int
    database_formula_name: str

    def hash_payload(self) -> dict[str, Any]:
        return {
            "formula_id": self.formula_id,
            "version": self.version,
            "factors": [{"column": f, "weight": w} for f, w in self.weights],
            "transform": FACTOR_TRANSFORM,
            "score_expression": self.score_expression,
            "holdings": 20,
            "rebalance": "monthly",
            "weighting": "equal_weight",
            "tie_break": "symbol ASC",
            "gross_return": GROSS_RETURN_SPEC,
            "turnover": TURNOVER_SPEC,
            "cost_model": COST_MODEL_SPEC,
            "missing_outcome_policy": MISSING_OUTCOME_POLICY,
        }

    def sha256(self) -> str:
        raw = json.dumps(
            self.hash_payload(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()


CANDIDATES: tuple[Candidate, ...] = (
    Candidate("LUNA_BASE_M1_REV_V1", "1.0.0", (("mom1", -1),),
              "-1.00*prank(mom1)", 2002, "LUNA_BASE_M1_REV_V1_FAM_20261012"),
    Candidate("LUNA_MR_70_30_V1", "1.0.0", (("mom1", -0.70), ("mom3", -0.30)),
              "-0.70*prank(mom1)-0.30*prank(mom3)", 2003, "LUNA_MR_70_30_V1_FAM_20261012"),
    Candidate("LUNA_MR_60_40_V1", "1.0.0", (("mom1", -0.60), ("mom3", -0.40)),
              "-0.60*prank(mom1)-0.40*prank(mom3)", 2004, "LUNA_MR_60_40_V1_FAM_20261012"),
    Candidate("LUNA_MR_MIX_50_30_20_V1", "1.0.0",
              (("mom1", -0.50), ("mom3", -0.30), ("mom6", 0.20)),
              "-0.50*prank(mom1)-0.30*prank(mom3)+0.20*prank(mom6)",
              2005, "LUNA_MR_MIX_50_30_20_V1_FAM_20261012"),
    Candidate("LUNA_MR_MIX_70_20_10_V1", "1.0.0",
              (("mom1", -0.70), ("mom3", -0.20), ("mom6", 0.10)),
              "-0.70*prank(mom1)-0.20*prank(mom3)+0.10*prank(mom6)",
              2006, "LUNA_MR_MIX_70_20_10_V1_FAM_20261012"),
    Candidate("LUNA_REV_LOWVOL_LIQ_V1", "1.0.0",
              (("mom1", -0.55), ("mom3", -0.25), ("vol20", -0.15), ("avg_amount20", 0.05)),
              "-0.55*prank(mom1)-0.25*prank(mom3)-0.15*prank(vol20)+0.05*prank(avg_amount20)",
              2007, "LUNA_REV_LOWVOL_LIQ_V1_FAM_20261012"),
    Candidate("LUNA_TREND_MOM_4F_V1", "1.0.0",
              (("mom3", 0.20), ("mom6", 0.30), ("mom12", 0.30), ("high52_ratio", 0.20)),
              "0.20*prank(mom3)+0.30*prank(mom6)+0.30*prank(mom12)+0.20*prank(high52_ratio)",
              2008, "LUNA_TREND_MOM_4F_V1_FAM_20261012"),
    Candidate("LUNA_TREND_RISK_ADJ_4F_V1", "1.0.0",
              (("mom6", 0.35), ("mom12", 0.35), ("high52_ratio", 0.20), ("vol20", -0.10)),
              "0.35*prank(mom6)+0.35*prank(mom12)+0.20*prank(high52_ratio)-0.10*prank(vol20)",
              2009, "LUNA_TREND_RISK_ADJ_4F_V1_FAM_20261012"),
)

EXPECTED_FORMULA_HASHES = {
    2002: "f52ec3ebeb36211ad60f89d616701864df4a6d6286f271648394c74cb52ea185",
    2003: "ef8351910c92ea2297874b353d68cae5bd56f311eae7649202f8346344106b8a",
    2004: "a5b71f9bdca598656c54e0caeb40bbadc4a7ac7b22d5d5cbf5369a7163155e36",
    2005: "5e84e97df4002f0439c37498d7fb75c3ca0cc23bcd35f201ae2222dc5bb3c6b6",
    2006: "f6428ccdeb4ba03fe380c8fff423de7e3494088fff6373613aab9785f03ec4cb",
    2007: "17031bd12ad7bc24b76add2b7ac6f1a9b525551de171517ca5aba5853959b6d2",
    2008: "fa3f0d0653b206f1f25f0e7fe61419032044bc9a2c706f6e0525bddbf2c88d55",
    2009: "c0652fd66b5aefe43dac93fc363575a2e6aa0687391a5fe29ab512ebdeddcd1e",
}


def _monthly_period(value: Any) -> pd.Period:
    return pd.Timestamp(value).to_period("M")


def load_monthly_factors(path: str | Path) -> pd.DataFrame:
    """Normalize month labels and derive strict next-calendar-month outcomes."""
    frame = pd.read_csv(path)
    required = {"symbol", "month_end", "adj_close"}
    required.update(f for candidate in CANDIDATES for f, _ in candidate.weights)
    missing_columns = sorted(required - set(frame.columns))
    if missing_columns:
        raise ValueError(f"Missing required columns: {missing_columns}")

    frame["symbol"] = frame["symbol"].astype(str).str.strip().str.upper()
    if (frame["symbol"] == "").any():
        raise ValueError("Blank symbols are not allowed")
    frame["month_period"] = pd.to_datetime(frame["month_end"], errors="raise").dt.to_period("M")
    frame["month_label"] = frame["month_period"].dt.to_timestamp()
    if frame.duplicated(["symbol", "month_period"]).any():
        dupes = frame.loc[frame.duplicated(["symbol", "month_period"], keep=False),
                          ["symbol", "month_label"]].head(10).to_dict("records")
        raise ValueError(f"Duplicate symbol-month observations; examples: {dupes}")

    numeric_cols = {"adj_close"}
    numeric_cols.update(f for candidate in CANDIDATES for f, _ in candidate.weights)
    for column in numeric_cols:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame.loc[~np.isfinite(frame["adj_close"]), "adj_close"] = np.nan
    frame.loc[frame["adj_close"] <= 0, "adj_close"] = np.nan

    frame = frame.sort_values(["symbol", "month_period"]).reset_index(drop=True)
    grouped = frame.groupby("symbol", sort=False)
    next_period = grouped["month_period"].shift(-1)
    next_price = grouped["adj_close"].shift(-1)
    expected_period = frame["month_period"] + 1
    exact_next_month = next_period.eq(expected_period)
    forward = next_price / frame["adj_close"] - 1.0
    frame["fwd1"] = forward.where(exact_next_month & np.isfinite(forward))
    frame["fwd1"] = pd.to_numeric(frame["fwd1"], errors="coerce")
    frame.loc[~np.isfinite(frame["fwd1"]), "fwd1"] = np.nan

    # SQL/Pg percent_rank semantics: (rank(method='min') - 1) / (N - 1).
    # Tied values share the lowest rank in the tie; all-missing factor values
    # remain missing and cannot be scored by formulas that use that factor.
    for candidate in CANDIDATES:
        for factor, _weight in candidate.weights:
            rank_column = f"rank__{factor}"
            if rank_column in frame.columns:
                continue

            def percentile_rank(series: pd.Series) -> pd.Series:
                n = int(series.notna().sum())
                if n == 0:
                    return pd.Series(np.nan, index=series.index, dtype=float)
                ranks = series.rank(method="min", ascending=True)
                if n == 1:
                    return ranks.where(series.notna(), np.nan).mul(0.0)
                return (ranks - 1.0) / (n - 1.0)

            frame[rank_column] = frame.groupby("month_period", sort=False)[factor].transform(
                percentile_rank
            )

    return frame


def evaluate_candidate(frame: pd.DataFrame, candidate: Candidate, k: int = 20,
                       cost_bps: tuple[float, ...] = (20.0, 30.0, 40.0)) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return per-month audit rows and selected-symbol rows; never outcome-filter before ranking."""
    if k <= 0:
        raise ValueError("k must be positive")
    factors = [factor for factor, _ in candidate.weights]
    ranks = [f"rank__{factor}" for factor in factors]
    months = sorted(frame["month_period"].dropna().unique())
    holdings_by_month: dict[pd.Period, set[str]] = {}
    selected_records: list[dict[str, Any]] = []
    monthly_records: list[dict[str, Any]] = []

    # Stage 1: rank based only on formation date, fixed factor values and
    # deterministic symbol tie-break. The forward outcome is not in this sort.
    for month in months:
        month_data = frame.loc[frame["month_period"].eq(month)].copy()
        eligible = month_data.dropna(subset=ranks).copy()
        eligible["score"] = 0.0
        for (factor, weight), rank_column in zip(candidate.weights, ranks):
            eligible["score"] += float(weight) * eligible[rank_column].astype(float)

        eligible = eligible.sort_values(
            ["score", "symbol"], ascending=[False, True], kind="mergesort"
        )
        chosen = eligible.head(k).copy()
        chosen_symbols = set(chosen["symbol"].astype(str))
        holdings_by_month[month] = chosen_symbols
        enough_names = len(chosen) == k

        previous_month = month - 1
        if previous_month in holdings_by_month:
            turnover = 1.0 - len(chosen_symbols & holdings_by_month[previous_month]) / float(k)
        else:
            turnover = 1.0
        turnover = max(0.0, min(1.0, float(turnover)))

        missing_symbols = sorted(
            chosen.loc[~np.isfinite(chosen["fwd1"].to_numpy(dtype=float)), "symbol"].astype(str).tolist()
        )
        complete_outcomes = enough_names and len(missing_symbols) == 0
        gross = float(chosen["fwd1"].mean()) if complete_outcomes else None

        monthly_row: dict[str, Any] = {
            "candidate_id": candidate.formula_id,
            "database_formula_id": candidate.database_formula_id,
            "formation_month": str(month),
            "selected_count": int(len(chosen)),
            "required_count": k,
            "valid_forward_outcomes": int(chosen["fwd1"].notna().sum()),
            "missing_selected_symbols": missing_symbols,
            "outcome_complete": bool(complete_outcomes),
            "gross_return": gross,
            "turnover": turnover,
        }
        for bps in cost_bps:
            monthly_row[f"net_return_{int(bps)}bps"] = (
                gross - (float(bps) / 10000.0) * turnover if complete_outcomes else None
            )
        monthly_records.append(monthly_row)

        for selected_rank, item in enumerate(chosen.itertuples(index=False), start=1):
            selected_records.append({
                "candidate_id": candidate.formula_id,
                "database_formula_id": candidate.database_formula_id,
                "formation_month": str(month),
                "rank": selected_rank,
                "symbol": str(item.symbol),
                "score": float(item.score),
                "adj_close_at_formation": float(item.adj_close) if pd.notna(item.adj_close) else None,
                "forward_return_next_calendar_month": float(item.fwd1) if pd.notna(item.fwd1) else None,
                "forward_outcome_available": bool(pd.notna(item.fwd1)),
                "outcome_used_for_selection": False,
            })

    monthly = pd.DataFrame(monthly_records)
    selected = pd.DataFrame(selected_records)
    return monthly, selected


def fold_for_month(value: str) -> str | None:
    month = pd.Period(value, freq="M")
    if pd.Period("2021-12", "M") <= month <= pd.Period("2024-08", "M"):
        return "train"
    if pd.Period("2024-09", "M") <= month <= pd.Period("2025-08", "M"):
        return "oos_retrospective"
    if pd.Period("2025-09", "M") <= month <= pd.Period("2026-08", "M"):
        return "posthoc_not_virgin_holdout"
    return None


def summarize_monthly(monthly: pd.DataFrame) -> pd.DataFrame:
    """Produce transparent diagnostics; incomplete periods are flagged, never silently completed."""
    rows: list[dict[str, Any]] = []
    if monthly.empty:
        return pd.DataFrame()
    annotated = monthly.copy()
    annotated["fold"] = annotated["formation_month"].map(fold_for_month)
    annotated = annotated.loc[annotated["fold"].notna()].copy()

    for candidate_id, cand_group in annotated.groupby("candidate_id", sort=True):
        for cost_col in [c for c in cand_group.columns if c.startswith("net_return_")]:
            for fold, fold_group in cand_group.groupby("fold", sort=True):
                returns = pd.to_numeric(fold_group[cost_col], errors="coerce")
                complete_mask = returns.notna() & fold_group["outcome_complete"].astype(bool)
                valid_returns = returns.loc[complete_mask].astype(float)
                missing_months = int((~complete_mask).sum())
                equity = (1.0 + valid_returns).cumprod()
                peaks = equity.cummax()
                drawdown = equity / peaks - 1.0 if not equity.empty else pd.Series(dtype=float)
                average = float(valid_returns.mean()) if not valid_returns.empty else None
                deviation = float(valid_returns.std(ddof=1)) if len(valid_returns) > 1 else None
                sharpe = (
                    float(np.sqrt(12.0) * average / deviation)
                    if average is not None and deviation not in (None, 0.0)
                    else None
                )
                rows.append({
                    "candidate_id": candidate_id,
                    "fold": fold,
                    "cost_case": cost_col.replace("net_return_", ""),
                    "formation_months_declared": int(len(fold_group)),
                    "valid_return_months": int(len(valid_returns)),
                    "missing_or_invalid_months": missing_months,
                    "fold_complete": bool(missing_months == 0),
                    "first_valid_month": str(fold_group.loc[complete_mask, "formation_month"].min()) if complete_mask.any() else None,
                    "last_valid_month": str(fold_group.loc[complete_mask, "formation_month"].max()) if complete_mask.any() else None,
                    "cumulative_net_return_pct": float((equity.iloc[-1] - 1.0) * 100.0) if not equity.empty else None,
                    "mean_monthly_net_return_pct": average * 100.0 if average is not None else None,
                    "monthly_return_std_pct": deviation * 100.0 if deviation is not None else None,
                    "annualized_sharpe_rf0": sharpe,
                    "max_drawdown_pct": float(drawdown.min() * 100.0) if not drawdown.empty else None,
                    "positive_month_pct": float((valid_returns > 0).mean() * 100.0) if not valid_returns.empty else None,
                    "mean_turnover_pct": float(pd.to_numeric(fold_group["turnover"], errors="coerce").mean() * 100.0),
                })
    return pd.DataFrame(rows)


def run_lab(input_path: str | Path, output_dir: str | Path, run_id: str | None = None,
            costs_bps: tuple[float, ...] = (20.0, 30.0, 40.0)) -> dict[str, Any]:
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    frame = load_monthly_factors(input_path)
    run_id = run_id or str(uuid.uuid4())
    dataset_hash = hashlib.sha256(input_path.read_bytes()).hexdigest()

    all_monthly, all_selected, candidate_manifest = [], [], []
    for candidate in CANDIDATES:
        digest = candidate.sha256()
        expected = EXPECTED_FORMULA_HASHES.get(candidate.database_formula_id)
        if expected and digest != expected:
            raise ValueError(
                f"Canonical formula hash mismatch for {candidate.formula_id}: "
                f"computed={digest} expected={expected}"
            )
        monthly, selected = evaluate_candidate(frame, candidate, k=20, cost_bps=costs_bps)
        all_monthly.append(monthly)
        all_selected.append(selected)
        candidate_manifest.append({
            "formula_id": candidate.formula_id,
            "version": candidate.version,
            "database_formula_id": candidate.database_formula_id,
            "database_formula_name": candidate.database_formula_name,
            "formula_sha256": digest,
            "hash_payload": candidate.hash_payload(),
            "selected_count": 20,
            "cost_cases_bps_per_turnover_unit": list(costs_bps),
            "source_factor_columns": [f for f, _ in candidate.weights],
        })

    monthly_df = pd.concat(all_monthly, ignore_index=True)
    selected_df = pd.concat(all_selected, ignore_index=True)
    summary_df = summarize_monthly(monthly_df)

    monthly_df.to_csv(output_dir / "monthly_returns.csv", index=False)
    selected_df.to_csv(output_dir / "selected_holdings.csv", index=False)
    summary_df.to_csv(output_dir / "summary.csv", index=False)
    manifest = {
        "schema_version": "1.0",
        "engine": SCRIPT_VERSION,
        "run_id": run_id,
        "input_path_name": input_path.name,
        "dataset_sha256": dataset_hash,
        "input_rows": int(len(frame)),
        "input_symbols": int(frame["symbol"].nunique()),
        "input_months": sorted(str(m) for m in frame["month_period"].dropna().unique()),
        "cost_cases_bps_per_turnover_unit": list(costs_bps),
        "factor_transform": FACTOR_TRANSFORM,
        "outcome_policy": MISSING_OUTCOME_POLICY,
        "formula_count": len(CANDIDATES),
        "candidate_manifest": candidate_manifest,
        "output_files": ["monthly_returns.csv", "selected_holdings.csv", "summary.csv"],
        "limitations": [
            "This runner does not reconstruct PIT membership; it requires a separately verified point-in-time universe snapshot.",
            "This runner fails closed for missing outcomes and does not replace selected names after formation.",
            "The historical dataset currently has material survivorship-bias and factor-builder lineage risks.",
            "Posthoc_not_virgin_holdout is descriptive only; use a prospective frozen-paper period for validation.",
            "The linear weights are hypothesis-driven experiment constants, not optimized proof of alpha.",
        ],
    }
    (output_dir / "run_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="CSV exported from luna_research_monthly_price_factors")
    parser.add_argument("--output", required=True, help="Directory for the manifest and audit outputs")
    parser.add_argument("--run-id", default=None, help="Stable caller-supplied research run ID; generated if omitted")
    parser.add_argument("--cost-bps", default="20,30,40", help="Comma-separated bps per full turnover unit")
    args = parser.parse_args()
    try:
        costs = tuple(float(value.strip()) for value in args.cost_bps.split(",") if value.strip())
        if not costs or any(value < 0 for value in costs):
            raise ValueError("cost-bps must contain non-negative values")
        manifest = run_lab(args.input, args.output, args.run_id, costs)
    except (OSError, ValueError, KeyError) as exc:
        parser.error(str(exc))
    print(json.dumps({
        "run_id": manifest["run_id"],
        "formula_count": manifest["formula_count"],
        "dataset_sha256": manifest["dataset_sha256"],
        "output_files": manifest["output_files"],
        "manifest_path": str(Path(args.output) / "run_manifest.json"),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
