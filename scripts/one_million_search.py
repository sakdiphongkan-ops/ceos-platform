#!/usr/bin/env python3
"""
LUNA / CEOS one-million strategy search engine.

Purpose:
- Deterministically enumerate up to 1,000,000 stock-selection rules.
- Evaluate them only on point-in-time features and forward returns.
- Use walk-forward OOS windows, explicit transaction costs and a locked holdout.
- Produce a trial ledger so the number of tested candidates cannot be hidden.

Input CSV schema:
date,symbol,<factor columns...>,fwd_return
date must be the feature/decision timestamp. fwd_return is the return available
AFTER that timestamp. Never put future information into factor columns.

Example:
python scripts/one_million_search.py --input data/research/pit_daily.csv \
  --output data/results/one_million --max-trials 1000000
"""

from __future__ import annotations
import argparse, hashlib, json, math, os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


FEATURES = [
    "PE","PBV","EV_EBITDA","FCF_YIELD","EARNINGS_YIELD","DIV_YIELD",
    "ROE","ROA","ROIC","GPM","NPM","CFO_MARGIN",
    "REV_G","EPS_G","NI_G","FCF_G",
    "MOM_5","MOM_10","MOM_20","MOM_60","MOM_120","REL_MOM",
    "VOL_10","VOL_20","BETA","MAXDD_60","ATR_PCT",
    "ADV20","TURNOVER","AMOUNT",
    "ASSET_G","CAPEX_G","INVESTMENT_RATE",
    "DIV_G","PAYOUT","BUYBACK",
    "DE","NET_DEBT_EBITDA","INTEREST_COVER","CURRENT_RATIO",
    "RSI14","DIST_MA20","DIST_MA60","BREAKOUT20","BREAKOUT55",
]

LOWER_IS_BETTER = {
    "PE","PBV","EV_EBITDA","DE","NET_DEBT_EBITDA","VOL_10","VOL_20",
    "BETA","MAXDD_60","ATR_PCT","PAYOUT"
}

@dataclass(frozen=True)
class Rule:
    feature: str
    direction: str       # top or bottom
    quantile: float
    op: str              # single / and / or
    feature2: str = ""
    direction2: str = ""
    quantile2: float = 0.0

    @property
    def id(self) -> str:
        raw = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

def generate_rules(features: list[str], max_trials: int) -> list[Rule]:
    qs = [0.05, 0.10, 0.20, 0.30, 0.40]
    out: list[Rule] = []
    for f in features:
        for q in qs:
            for d in ("top","bottom"):
                out.append(Rule(f,d,q,"single"))
    base = list(out)
    # Deterministic pairwise expansion. Stop exactly at requested trial count.
    for a in base:
        for b in base:
            if a.feature >= b.feature:
                continue
            for op in ("and","or"):
                out.append(Rule(a.feature,a.direction,a.quantile,op,
                                b.feature,b.direction,b.quantile))
                if len(out) >= max_trials:
                    return out[:max_trials]
    return out[:max_trials]

def quantile_mask(s: pd.Series, direction: str, q: float) -> pd.Series:
    # Cross-sectional selection within a date.
    if s.notna().sum() < 3:
        return pd.Series(False, index=s.index)
    cutoff = s.quantile(1-q if direction == "top" else q)
    return s >= cutoff if direction == "top" else s <= cutoff

def rule_mask(g: pd.DataFrame, r: Rule) -> pd.Series:
    a = quantile_mask(g[r.feature], r.direction, r.quantile)
    if r.op == "single":
        return a
    b = quantile_mask(g[r.feature2], r.direction2, r.quantile2)
    return a & b if r.op == "and" else a | b

def evaluate(df: pd.DataFrame, r: Rule, cost_bps: float,
             min_names: int = 1) -> dict:
    gross = []
    dates = []
    selected_counts = []
    for dt, g in df.groupby("date", sort=True):
        m = rule_mask(g, r)
        selected = g.loc[m, "fwd_return"].dropna()
        if len(selected) < min_names:
            continue
        # Equal-weight cross-section. fwd_return is decimal.
        gross.append(float(selected.mean()) - cost_bps/10000.0)
        dates.append(dt)
        selected_counts.append(int(len(selected)))
    if not gross:
        return {"rule_id":r.id,"trades":0,"return":0.0,"win_rate":0.0,
                "profit_factor":0.0,"max_drawdown":1.0,"days":0}
    x = np.asarray(gross, dtype=float)
    equity = np.cumprod(1+x)
    peak = np.maximum.accumulate(equity)
    dd = 1 - equity/peak
    pos = x[x > 0].sum()
    neg = -x[x < 0].sum()
    return {
        "rule_id": r.id, "trades": int(len(x)), "return": float(equity[-1]-1),
        "win_rate": float((x > 0).mean()),
        "profit_factor": float(pos/neg) if neg > 0 else float("inf"),
        "max_drawdown": float(dd.max()),
        "days": int(len(x)),
        "avg_names": float(np.mean(selected_counts)),
    }

def walk_forward(df: pd.DataFrame, r: Rule, cost_bps: float,
                 train_days: int, oos_days: int, holdout_days: int) -> dict:
    days = sorted(pd.Series(df["date"].unique()).tolist())
    if len(days) < train_days + oos_days + holdout_days:
        raise ValueError("Not enough dates for requested walk-forward/holdout windows")
    oos_rows = []
    fold_rows = []
    # Parameters are fixed; train is deliberately used only for eligibility.
    # We do not tune the rule on the OOS slice.
    end = train_days
    fold = 0
    while end + oos_days <= len(days) - holdout_days:
        train = df[df.date.isin(days[end-train_days:end])]
        oos = df[df.date.isin(days[end:end+oos_days])]
        tr = evaluate(train, r, cost_bps)
        oo = evaluate(oos, r, cost_bps)
        fold_rows.append({"fold":fold, "train_return":tr["return"], **{f"oos_{k}":v for k,v in oo.items() if k!="rule_id"}})
        if oo["trades"]:
            oos_rows.append(oo)
        fold += 1
        end += oos_days
    # Locked holdout is never used for rule selection; it is reported separately.
    holdout = df[df.date.isin(days[-holdout_days:])]
    ho = evaluate(holdout, r, cost_bps)
    total_oos = float(sum(x["return"] for x in oos_rows))
    return {
        "rule_id": r.id,
        "folds": fold,
        "oos_trades": int(sum(x["trades"] for x in oos_rows)),
        "oos_return_sum": total_oos,
        "oos_positive_folds": int(sum(x["oos_return"] > 0 for x in fold_rows)),
        "oos_max_drawdown_max": float(max([x["oos_max_drawdown"] for x in fold_rows], default=1.0)),
        "oos_profit_factor_mean": float(np.mean([x["oos_profit_factor"] for x in fold_rows if np.isfinite(x["oos_profit_factor"])] or [0])),
        "holdout_return": float(ho["return"]),
        "holdout_trades": int(ho["trades"]),
        "folds_detail": fold_rows,
    }

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--max-trials", type=int, default=1_000_000)
    ap.add_argument("--cost-bps", type=float, default=45.0)
    ap.add_argument("--train-days", type=int, default=120)
    ap.add_argument("--oos-days", type=int, default=20)
    ap.add_argument("--holdout-days", type=int, default=40)
    ap.add_argument("--min-trades", type=int, default=30)
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    required = {"date","symbol","fwd_return"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"Missing columns: {sorted(missing)}")
    df["date"] = pd.to_datetime(df["date"]).dt.date
    available = [f for f in FEATURES if f in df.columns]
    if len(available) < 3:
        raise SystemExit("Need at least 3 recognized factor columns.")
    df = df.replace([np.inf,-np.inf], np.nan).sort_values(["date","symbol"])
    rules = generate_rules(available, args.max_trials)

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    ledger_path = out / "trial_ledger.jsonl"
    result_path = out / "results.csv"

    with ledger_path.open("w", encoding="utf-8") as ledger:
        rows = []
        for i, r in enumerate(rules, 1):
            rec = {"trial":i, **asdict(r), "rule_id":r.id, "status":"tested"}
            try:
                res = walk_forward(df, r, args.cost_bps, args.train_days, args.oos_days, args.holdout_days)
                rec.update({k:v for k,v in res.items() if k!="folds_detail"})
                rec["eligible"] = bool(
                    res["oos_trades"] >= args.min_trades
                    and res["oos_positive_folds"] >= 3
                    and res["oos_return_sum"] > 0
                    and res["holdout_trades"] >= max(10, args.min_trades//2)
                )
                rec["status"] = "passed_gate" if rec["eligible"] else "rejected"
                rec["folds_detail"] = res["folds_detail"]
            except Exception as e:
                rec["status"] = "error"
                rec["error"] = str(e)
            ledger.write(json.dumps(rec, default=str) + "\n")
            rows.append({k:v for k,v in rec.items() if k != "folds_detail"})
            if i % 10000 == 0:
                pd.DataFrame(rows).to_csv(result_path, index=False)

    pd.DataFrame(rows).to_csv(result_path, index=False)
    passed = pd.DataFrame(rows)
    if not passed.empty and "eligible" in passed:
        passed = passed[passed.eligible == True].sort_values(
            ["oos_return_sum","oos_positive_folds","oos_trades"], ascending=False
        )
    passed.to_csv(out / "passed.csv", index=False)
    manifest = {
        "trials_committed": len(rules),
        "max_trials_requested": args.max_trials,
        "cost_bps": args.cost_bps,
        "train_days": args.train_days,
        "oos_days": args.oos_days,
        "holdout_days": args.holdout_days,
        "features_used": available,
        "input_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "warning": "Results are research evidence only; a million trials requires multiple-testing correction and independent validation."
    }
    (out/"manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    print(json.dumps({"trials":len(rules),"passed":int(len(passed))}, indent=2))

if __name__ == "__main__":
    main()
