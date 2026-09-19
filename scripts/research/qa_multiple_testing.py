#!/usr/bin/env python3
"""Conservative multiple-testing diagnostics for LUNA finalist statistics.

This report does not change strategy eligibility. It uses the full number of
hypotheses as the family size, because only a subset of finalists receive exact
OOS/holdout evaluation after the 1M screen.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import pandas as pd


def normal_two_sided_p(z: float) -> float:
    if not math.isfinite(z):
        return 0.0 if z != 0 else 1.0
    return math.erfc(abs(z) / math.sqrt(2.0))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    df = pd.read_csv(args.results)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    m = int(manifest.get("max_trials_requested") or manifest.get("trials_committed") or 1)

    oos_t = pd.to_numeric(df.get("oos_t_stat"), errors="coerce")
    hold_t = pd.to_numeric(df.get("holdout_t_stat"), errors="coerce")

    oos_p = oos_t.map(normal_two_sided_p)
    hold_p = hold_t.map(normal_two_sided_p)

    out = {
        "family_size_hypotheses": m,
        "finalists_evaluated": int(len(df)),
        "diagnostic_method": "two-sided normal approximation from reported t-statistics; conservative family-wise correction uses all 1M hypotheses",
        "bonferroni_alpha_0_05": 0.05 / m,
        "oos_min_bonferroni_p": float(min((p for p in oos_p.dropna()), default=1.0)),
        "holdout_min_bonferroni_p": float(min((p for p in hold_p.dropna()), default=1.0)),
        "oos_max_positive_t": float(oos_t[oos_t > 0].max()) if (oos_t > 0).any() else None,
        "holdout_max_positive_t": float(hold_t[hold_t > 0].max()) if (hold_t > 0).any() else None,
        "oos_finalists_below_bonferroni_alpha": int((oos_p < 0.05 / m).sum()),
        "holdout_finalists_below_bonferroni_alpha": int((hold_p < 0.05 / m).sum()),
        "warning": "This is a diagnostic, not a formal dependent-data p-value. Serial correlation, data-mining dependence, and the staged screen can make ordinary t-statistics anti-conservative.",
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
