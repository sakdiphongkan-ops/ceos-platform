#!/usr/bin/env python3
"""Leakage-safe monthly walk-forward adaptive selector for LUNA.

Each candidate is evaluated as an equal-weight top-K portfolio. Transaction
cost is turnover-aware: one-way turnover is 1 - overlap/K, with a configurable
bps cost applied to turnover. Candidate selection for month t uses only
candidate net returns strictly before t.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import os
import uuid

import numpy as np
import pandas as pd
from apply_pit_universe import filter_dataframe_by_date
from luna_formula_identity import build_identity_catalog

FACTORS = [
    "mom1", "mom3", "mom6", "mom12",
    "high52_ratio", "vol20", "maxdd60", "avg_amount20",
]


def geo(x: pd.Series) -> float:
    x = pd.to_numeric(x, errors="coerce").dropna()
    if len(x) == 0 or (x <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(x).mean()))


def add_strict_forward_returns(df: pd.DataFrame) -> pd.DataFrame:
    """Calculate next-calendar-month returns and retain missing outcomes for QA."""
    out = df.copy()
    out["month_end"] = pd.to_datetime(out["month_end"]).dt.to_period("M").dt.to_timestamp("M")
    out = out.sort_values(["symbol", "month_end"]).drop_duplicates(
        ["symbol", "month_end"], keep="last"
    ).reset_index(drop=True)
    out["adj_close"] = pd.to_numeric(out["adj_close"], errors="coerce")
    next_month = out.groupby("symbol")["month_end"].shift(-1)
    next_close = out.groupby("symbol")["adj_close"].shift(-1)
    expected = out["month_end"] + pd.offsets.MonthEnd(1)
    out["fwd1"] = np.where(
        next_month.eq(expected),
        next_close / out["adj_close"] - 1.0,
        np.nan,
    )
    # Only exclude the last global month, which cannot yet have a complete
    # following-month outcome. Gaps for individual symbols stay visible.
    final_month = out["month_end"].max()
    if pd.isna(final_month):
        raise SystemExit("NO_MONTHLY_OBSERVATIONS")
    return out.loc[out["month_end"] < final_month].copy().reset_index(drop=True)


def ranked_symbols(df: pd.DataFrame, factor: str, direction: str, k: int) -> pd.Series:
    # Ranking must depend only on factors known at formation time, never on fwd1.
    x = df[["symbol", "month_end", factor]].copy()
    x["rank_pct"] = x.groupby("month_end")[factor].rank(pct=True, method="average")
    x = x.dropna(subset=["rank_pct"])
    ascending = direction == "LOW"
    x = x.sort_values(
        ["month_end", "rank_pct", "symbol"],
        ascending=[True, ascending, True],
    )
    eligible_counts = x.groupby("month_end")["symbol"].size()
    executable_months = eligible_counts[eligible_counts >= k].index
    # If this factor cannot produce K names in a month, that candidate has no
    # tradable portfolio observation for that month. It is not allowed to use
    # future outcomes to fill the gap; the selector will omit it for that date.
    x = x[x["month_end"].isin(executable_months)]
    result = x.groupby("month_end", sort=True).head(k).set_index("month_end")["symbol"]
    result.index.name = "month_end"
    return result


def candidate_return(
    df: pd.DataFrame,
    factor: str,
    direction: str,
    k: int,
    cost_bps: float,
) -> pd.DataFrame:
    selected = ranked_symbols(df, factor, direction, k)
    groups = selected.groupby(level=0)
    rows = []
    previous = set()

    for month, symbols in groups:
        current = set(symbols.tolist())
        holding_rows = df.loc[
            (df["month_end"] == month) & (df["symbol"].isin(current)),
            ["symbol", "fwd1"],
        ].copy()
        if len(current) != k or holding_rows["symbol"].nunique() != k:
            raise SystemExit(
                "INSUFFICIENT_SELECTED_HOLDINGS: "
                f"month={pd.Timestamp(month).strftime('%Y-%m')} "
                f"selected={holding_rows['symbol'].nunique()} required_k={k}"
            )
        holding_rows["fwd1"] = pd.to_numeric(holding_rows["fwd1"], errors="coerce")
        if not np.isfinite(holding_rows["fwd1"].to_numpy(dtype=float)).all():
            missing_symbols = holding_rows.loc[
                ~np.isfinite(holding_rows["fwd1"].to_numpy(dtype=float)), "symbol"
            ].astype(str).tolist()
            raise SystemExit(
                "MISSING_FORWARD_RETURN_FOR_SELECTED_SYMBOLS: "
                f"month={pd.Timestamp(month).strftime('%Y-%m')} symbols={missing_symbols}; "
                "supply defensible terminal/delisting returns or quarantine the run"
            )
        gross = float(holding_rows["fwd1"].mean())
        overlap = len(current & previous)
        turnover = 1.0 if not previous else 1.0 - overlap / float(k)
        net = float(gross) - turnover * cost_bps / 10000.0
        rows.append(
            {
                "month_end": month,
                "gross_return": float(gross),
                "turnover": float(turnover),
                "cost": float(turnover * cost_bps / 10000.0),
                "net_return": net,
            }
        )
        previous = current

    if not rows:
        return pd.DataFrame(
            columns=["gross_return", "turnover", "cost", "net_return"],
            index=pd.DatetimeIndex([], name="month_end"),
        )
    return pd.DataFrame(rows).set_index("month_end")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lookback-months", type=int, default=24)
    ap.add_argument("--min-history-months", type=int, default=12)
    ap.add_argument("--cost-bps", type=float, default=20.0)
    ap.add_argument("--membership", default=os.getenv("LUNA_PIT_UNIVERSE_MEMBERSHIP"))
    ap.add_argument("--k-values", default="5,10,20")
    ap.add_argument("--run-id", default=os.getenv("LUNA_RESEARCH_RUN_ID"))
    args = ap.parse_args()
    run_id = str(args.run_id or uuid.uuid4().hex)

    if not args.membership:
        raise SystemExit("PIT_UNIVERSE_MEMBERSHIP_REQUIRED")
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    raw = pd.read_csv(args.input)
    if "snapshot_date" not in raw.columns:
        raise SystemExit("PIT_SNAPSHOT_DATE_REQUIRED")
    raw["snapshot_date"] = pd.to_datetime(raw["snapshot_date"])
    raw["month_end"] = pd.to_datetime(raw["month_end"])
    raw, pit_excluded_rows, pit_active_symbols = filter_dataframe_by_date(
        raw, args.membership, "snapshot_date"
    )

    required = {"symbol", "month_end", "adj_close", *FACTORS}
    missing = sorted(required - set(raw.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df = raw.copy()
    df["month_end"] = (
        pd.to_datetime(df["month_end"])
        .dt.to_period("M")
        .dt.to_timestamp("M")
    )
    df = df.sort_values(["symbol", "month_end"]).drop_duplicates(
        ["symbol", "month_end"]
    )
    df["adj_close"] = pd.to_numeric(df["adj_close"], errors="coerce")
    df = add_strict_forward_returns(df)
    for f in FACTORS:
        df[f] = pd.to_numeric(df[f], errors="coerce")

    try:
        k_values = list(dict.fromkeys(int(value.strip()) for value in args.k_values.split(",") if value.strip()))
    except ValueError as exc:
        raise SystemExit("INVALID_K_VALUES: expected comma-separated positive integers") from exc
    if not k_values or any(k < 1 for k in k_values):
        raise SystemExit("INVALID_K_VALUES: expected comma-separated positive integers")
    configs = [
        (f, d, k)
        for f in FACTORS
        for d in ("HIGH", "LOW")
        for k in k_values
    ]
    dataset_sha256 = hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
    membership_sha256 = hashlib.sha256(Path(args.membership).read_bytes()).hexdigest()
    formula_definitions = [
        {
            "id": f"{factor}:{direction}:K{k}",
            "terms": [(factor, 1.0 if direction == "HIGH" else -1.0)],
            "parameters": {"direction": direction, "k": k, "ranking": "factor percentile"},
        }
        for factor, direction, k in configs
    ]
    formula_identity_catalog = build_identity_catalog(
        formula_definitions,
        engine="luna-monthly-walk-forward-adaptive-v1",
        run_id=run_id,
        dataset_sha256=dataset_sha256,
        config={
            "lookback_months": args.lookback_months,
            "min_history_months": args.min_history_months,
            "cost_bps": args.cost_bps,
            "k_values": k_values,
            "factor_schema": FACTORS,
            "pit_membership_sha256": membership_sha256,
            "snapshot_column": "snapshot_date",
            "forward_return_rule": "same-symbol next calendar month only; gaps are missing",
            "portfolio_rule": "equal-weight top-K with turnover-based cost",
        },
        code_revision=os.getenv("GITHUB_SHA"),
    )
    identity_by_config = {
        config: item
        for config, item in zip(configs, formula_identity_catalog["formulas"], strict=True)
    }

    returns = {}
    for factor, direction, k in configs:
        config = (factor, direction, k)
        # Fail the entire experiment if selected outcomes are incomplete. Excluding
        # only candidates that encounter future missingness would itself be a
        # look-ahead filter on the formula search.
        result = candidate_return(df, factor, direction, k, args.cost_bps)
        if not result.empty:
            returns[config] = result

    if not returns:
        raise SystemExit("NO_VALID_ADAPTIVE_CANDIDATES: no candidate has sufficient factor coverage")
    months = sorted(set().union(*(set(frame.index) for frame in returns.values())))
    if not months:
        raise SystemExit("NO_EXECUTABLE_MONTHS")

    rows = []
    for month in months:
        prior = [m for m in months if m < month][-args.lookback_months:]
        if len(prior) < args.min_history_months:
            continue

        eligible = []
        for cfg, frame in returns.items():
            # A candidate must be executable at this formation date before it
            # can be selected; this uses signal coverage only, not its outcome.
            if month not in frame.index:
                continue
            hist = frame.reindex(prior)["net_return"].dropna()
            if len(hist) < args.min_history_months:
                continue
            eligible.append(
                (
                    geo(hist),
                    float((hist > 0).mean()),
                    cfg,
                )
            )

        if not eligible:
            continue

        eligible.sort(
            key=lambda z: (-z[0], -z[1], str(z[2]))
        )
        selected_geo, selected_positive, chosen = eligible[0]
        realized = returns[chosen].get("net_return", pd.Series()).get(
            month, np.nan
        )
        realized_frame = returns[chosen]
        realized_turnover = realized_frame.loc[month, "turnover"]
        realized_cost = realized_frame.loc[month, "cost"]
        realized_gross = realized_frame.loc[month, "gross_return"]

        rows.append(
            {
                "month_end": month,
                "history_start": prior[0],
                "history_end": prior[-1],
                "selected_geo": selected_geo,
                "selected_positive": selected_positive,
                "factor": chosen[0],
                "direction": chosen[1],
                "k": chosen[2],
                "run_id": run_id,
                "selected_formula_uid": identity_by_config[chosen]["formula_uid"],
                "gross_return": realized_gross,
                "turnover": realized_turnover,
                "transaction_cost": realized_cost,
                "realized_return": realized,
            }
        )

    ledger = pd.DataFrame(rows)
    ledger.to_csv(out / "adaptive_selection_ledger.csv", index=False)
    identity_catalog_path = out / "candidate-catalog.v2.json"
    identity_catalog_path.write_text(
        json.dumps(formula_identity_catalog, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    result = (
        ledger["realized_return"].dropna()
        if not ledger.empty
        else pd.Series(dtype=float)
    )
    summary = {
        "status": "COMPLETED",
        "engine": "luna-monthly-walk-forward-adaptive-v1",
        "pit_membership": args.membership,
        "pit_excluded_rows": int(pit_excluded_rows),
        "candidate_count_evaluated": len(returns),
        "pit_active_symbols": int(pit_active_symbols),
        "run_id": run_id,
        "experiment_sha256": formula_identity_catalog["manifest"]["experiment_sha256"],
        "formula_identity_schema": formula_identity_catalog["identity_schema"],
        "formula_catalog_v2": str(identity_catalog_path),
        "formula_catalog_sha256": formula_identity_catalog["catalog_sha256"],
        "git_commit_sha": os.getenv("GITHUB_SHA"),
        "dataset_sha256": dataset_sha256,
        "pit_membership_sha256": membership_sha256,
        "months_traded": int(len(result)),
        "geometric_monthly_return": geo(result),
        "cumulative_return": (
            float((1.0 + result).prod() - 1.0) if len(result) else -1.0
        ),
        "positive_month_pct": (
            float((result > 0).mean()) if len(result) else 0.0
        ),
        "months_ge_7pct": int((result >= 0.07).sum()),
        "min_monthly_return": float(result.min()) if len(result) else None,
        "max_monthly_return": float(result.max()) if len(result) else None,
        "average_turnover": (
            float(ledger["turnover"].mean()) if not ledger.empty else 0.0
        ),
        "total_transaction_cost": (
            float(ledger["transaction_cost"].sum())
            if not ledger.empty
            else 0.0
        ),
        "lookback_months": args.lookback_months,
        "min_history_months": args.min_history_months,
        "cost_bps_per_one_way_turnover": args.cost_bps,
        "selection_rule": (
            "select by trailing geometric net return, then positive-month "
            "ratio, using strictly prior months only"
        ),
        "transaction_cost_model": (
            "one-way turnover = 1 - portfolio overlap/K; "
            "cost = turnover * cost_bps / 10000"
        ),
        "leakage_guard": (
            "candidate selection uses only prior realized months; "
            "current formation ranking does not depend on forward-return availability"
        ),
        "forward_return_definition": (
            "same-symbol next calendar month only; gaps are NaN and never treated as one-month returns"
        ),
        "outcome_integrity_guard": (
            "selected holdings with missing next-month outcomes fail closed; "
            "defensible terminal/delisting returns or quarantine are required"
        ),
    }
    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
