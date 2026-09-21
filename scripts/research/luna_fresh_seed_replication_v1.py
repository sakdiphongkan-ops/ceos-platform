#!/usr/bin/env python3
"""LUNA fresh-seed replication runner v1.

Re-runs the same search specification under independent random seeds. No
holdout data is passed into selection; each child search preserves its own
frozen holdout internally.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--benchmark", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--seeds", default="20260922,20260923,20260924")
    ap.add_argument("--formula-count", type=int, default=5000)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--cost-bps", type=float, default=20)
    ap.add_argument("--lookback-months", type=int, default=24)
    ap.add_argument("--inner-train-months", type=int, default=12)
    ap.add_argument("--inner-valid-months", type=int, default=6)
    ap.add_argument("--outer-holdout-months", type=int, default=12)
    ap.add_argument("--min-history-months", type=int, default=9)
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    seeds = [int(x.strip()) for x in args.seeds.split(",") if x.strip()]
    if len(seeds) < 2:
        raise SystemExit("need at least two independent seeds")

    records = []
    for seed in seeds:
        child = out / f"seed-{seed}"
        child.mkdir(parents=True, exist_ok=True)
        cmd = [
            "python", "scripts/research/luna_failure_driven_search_v1.py",
            "--input", args.input,
            "--benchmark", args.benchmark,
            "--output", str(child),
            "--formula-count", str(args.formula_count),
            "--seed", str(seed),
            "--k", str(args.k),
            "--cost-bps", str(args.cost_bps),
            "--lookback-months", str(args.lookback_months),
            "--inner-train-months", str(args.inner_train_months),
            "--inner-valid-months", str(args.inner_valid_months),
            "--outer-holdout-months", str(args.outer_holdout_months),
            "--min-history-months", str(args.min_history_months),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        summary_path = child / "summary.json"
        if proc.returncode != 0 or not summary_path.exists():
            records.append({
                "seed": seed,
                "status": "FAILED",
                "returncode": proc.returncode,
                "stderr_tail": proc.stderr[-3000:],
            })
            continue
        s = json.loads(summary_path.read_text(encoding="utf-8"))
        records.append({
            "seed": seed,
            "status": s.get("status"),
            "formula_id": s.get("final_formula", {}).get("id"),
            "outer_oos_geo": s.get("outer_oos_stats", {}).get("geo"),
            "holdout_geo": s.get("frozen_holdout", {}).get("geo"),
            "holdout_cum": s.get("frozen_holdout", {}).get("cum"),
            "holdout_months": s.get("frozen_holdout", {}).get("months"),
        })

    valid = [r for r in records if r.get("status") == "COMPLETED"]
    replication_pass = (
        len(valid) == len(records)
        and len(valid) >= 2
        and all(float(r.get("outer_oos_geo", -1)) > 0 for r in valid)
        and all(float(r.get("holdout_geo", -1)) > 0 for r in valid)
    )

    result = {
        "status": "COMPLETED",
        "engine": "luna-fresh-seed-replication-v1",
        "seeds": seeds,
        "formula_count": args.formula_count,
        "specification": {
            "k": args.k,
            "cost_bps": args.cost_bps,
            "lookback_months": args.lookback_months,
            "inner_train_months": args.inner_train_months,
            "inner_valid_months": args.inner_valid_months,
            "outer_holdout_months": args.outer_holdout_months,
            "min_history_months": args.min_history_months,
        },
        "runs": records,
        "replication_pass": replication_pass,
        "interpretation": (
            "Pass requires every independent seed to remain positive on both "
            "nested outer OOS and its frozen holdout. This is intentionally "
            "strict and is not used to tune any formula."
        ),
    }
    (out / "replication.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
