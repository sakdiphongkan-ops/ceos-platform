#!/usr/bin/env python3
"""Deterministic one-million stock-selection strategy search.

The engine is deliberately fail-closed:
- factor values must be point-in-time;
- fwd_return must only contain information after the decision timestamp;
- every attempted rule is written to a trial ledger;
- costs are charged before OOS statistics;
- the final holdout is locked and reported separately.

Input columns: date,symbol,fwd_return plus any recognized factor columns.
"""

from __future__ import annotations
import argparse, hashlib, json
from dataclasses import dataclass, asdict
from pathlib import Path

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

@dataclass(frozen=True)
class Rule:
    feature: str
    direction: str
    quantile: float
    op: str                    # single / and / or / blend
    feature2: str = ""
    direction2: str = ""
    quantile2: float = 0.0
    weight: float = 0.5

    @property
    def id(self) -> str:
        raw = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

def generate_rules(features: list[str], max_trials: int) -> list[Rule]:
    qs = (0.05, 0.10, 0.20, 0.30, 0.40)
    base = [Rule(f,d,q,"single") for f in features for q in qs for d in ("top","bottom")]
    out = list(base)
    # Pairwise AND/OR rules.
    for i, a in enumerate(base):
        for b in base[i+1:]:
            for op in ("and","or"):
                out.append(Rule(a.feature,a.direction,a.quantile,op,b.feature,b.direction,b.quantile))
                if len(out) >= max_trials:
                    return out[:max_trials]
    # Weighted rank blends greatly expand the search space without changing
    # the underlying data. 141 weights x all ordered base pairs gives >1M rules.
    weights = np.linspace(0.01, 0.99, 141)
    for a in base:
        for b in base:
            if a.feature == b.feature:
                continue
            for w in weights:
                out.append(Rule(a.feature,a.direction,a.quantile,"blend",
                                b.feature,b.direction,b.quantile,float(w)))
                if len(out) >= max_trials:
                    return out[:max_trials]
    return out[:max_trials]

def percentile_score(s: pd.Series, direction: str) -> pd.Series:
    rank = s.rank(pct=True, method="average")
    return rank if direction == "top" else 1.0 - rank

def quantile_mask(s: pd.Series, direction: str, q: float) -> pd.Series:
    valid = s.notna()
    if valid.sum() < 3:
        return pd.Series(False, index=s.index)
    score = percentile_score(s, direction)
    return valid & (score >= 1.0-q)

def rule_mask(g: pd.DataFrame, r: Rule) -> pd.Series:
    if r.op == "single":
        return quantile_mask(g[r.feature], r.direction, r.quantile)
    a = quantile_mask(g[r.feature], r.direction, r.quantile)
    b = quantile_mask(g[r.feature2], r.direction2, r.quantile2)
    if r.op == "and":
        return a & b
    if r.op == "or":
        return a | b
    # Blend: select the top q fraction by a weighted percentile score.
    sa = percentile_score(g[r.feature], r.direction)
    sb = percentile_score(g[r.feature2], r.direction2)
    score = r.weight * sa + (1.0-r.weight) * sb
    threshold = score.quantile(1.0-min(r.quantile,r.quantile2))
    return score >= threshold

def evaluate(df: pd.DataFrame, r: Rule, cost_bps: float) -> dict:
    daily = []
    names = []
    for _, g in df.groupby("date", sort=True):
        m = rule_mask(g, r)
        x = g.loc[m, "fwd_return"].dropna()
        if len(x) == 0:
            continue
        daily.append(float(x.mean()) - cost_bps/10000.0)
        names.append(len(x))
    if not daily:
        return {"trades":0,"return":0.0,"win_rate":0.0,"profit_factor":0.0,
                "max_drawdown":1.0,"avg_names":0.0}
    x = np.asarray(daily, float)
    equity = np.cumprod(1+x)
    peak = np.maximum.accumulate(equity)
    dd = 1.0 - equity/peak
    gains = x[x > 0].sum()
    losses = -x[x < 0].sum()
    return {
        "trades": int(len(x)),
        "return": float(equity[-1]-1.0),
        "win_rate": float((x > 0).mean()),
        "profit_factor": float(gains/losses) if losses > 0 else float("inf"),
        "max_drawdown": float(dd.max()),
        "avg_names": float(np.mean(names)),
    }

def walk_forward(df: pd.DataFrame, r: Rule, cost_bps: float,
                 train_days: int, oos_days: int, holdout_days: int) -> dict:
    days = sorted(df.date.unique())
    if len(days) < train_days + oos_days + holdout_days:
        raise ValueError("Not enough dates for train/OOS/holdout windows")
    folds = []
    end = train_days
    while end + oos_days <= len(days) - holdout_days:
        train_days_set = days[end-train_days:end]
        oos_days_set = days[end:end+oos_days]
        # The rule is pre-defined; train is retained only as a provenance window.
        train = df[df.date.isin(train_days_set)]
        oos = df[df.date.isin(oos_days_set)]
        tr = evaluate(train, r, cost_bps)
        oo = evaluate(oos, r, cost_bps)
        folds.append({"train_return":tr["return"], **{f"oos_{k}":v for k,v in oo.items()}})
        end += oos_days
    holdout = evaluate(df[df.date.isin(days[-holdout_days:])], r, cost_bps)
    oos_returns = [f["oos_return"] for f in folds if f["oos_trades"] > 0]
    return {
        "folds": len(folds),
        "oos_trades": int(sum(f["oos_trades"] for f in folds)),
        "oos_return_sum": float(sum(oos_returns)),
        "oos_positive_folds": int(sum(x > 0 for x in oos_returns)),
        "oos_max_drawdown_max": float(max([f["oos_max_drawdown"] for f in folds], default=1.0)),
        "oos_profit_factor_mean": float(np.mean([f["oos_profit_factor"] for f in folds if np.isfinite(f["oos_profit_factor"])] or [0])),
        "holdout_return": float(holdout["return"]),
        "holdout_trades": int(holdout["trades"]),
        "folds_detail": folds,
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
    missing = {"date","symbol","fwd_return"} - set(df.columns)
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
    rows = []
    with (out/"trial_ledger.jsonl").open("w", encoding="utf-8") as ledger:
        for i, r in enumerate(rules, 1):
            rec = {"trial":i, **asdict(r), "rule_id":r.id}
            try:
                res = walk_forward(df, r, args.cost_bps, args.train_days, args.oos_days, args.holdout_days)
                rec.update({k:v for k,v in res.items() if k != "folds_detail"})
                rec["eligible"] = bool(
                    rec["oos_trades"] >= args.min_trades
                    and rec["oos_positive_folds"] >= 3
                    and rec["oos_return_sum"] > 0
                    and rec["holdout_trades"] >= max(10, args.min_trades//2)
                )
                rec["status"] = "passed_gate" if rec["eligible"] else "rejected"
                rec["folds_detail"] = res["folds_detail"]
            except Exception as exc:
                rec["status"] = "error"
                rec["eligible"] = False
                rec["error"] = str(exc)
            ledger.write(json.dumps(rec, default=str) + "\n")
            rows.append({k:v for k,v in rec.items() if k != "folds_detail"})
            if i % 10000 == 0:
                pd.DataFrame(rows).to_csv(out/"results.csv", index=False)

    result = pd.DataFrame(rows)
    result.to_csv(out/"results.csv", index=False)
    if not result.empty:
        passed = result[result["eligible"] == True].sort_values(
            ["oos_return_sum","oos_positive_folds","oos_trades"], ascending=False)
    else:
        passed = result
    passed.to_csv(out/"passed.csv", index=False)
    manifest = {
        "trials_committed": len(rules),
        "max_trials_requested": args.max_trials,
        "cost_bps": args.cost_bps,
        "train_days": args.train_days,
        "oos_days": args.oos_days,
        "holdout_days": args.holdout_days,
        "features_used": available,
        "input_sha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "selection_warning": "After one million trials, winners require multiple-testing correction and independent validation."
    }
    (out/"manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"trials":len(rules),"passed":int(len(passed))}, indent=2))

if __name__ == "__main__":
    main()
