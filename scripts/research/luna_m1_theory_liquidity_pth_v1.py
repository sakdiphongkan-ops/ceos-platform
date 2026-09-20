#!/usr/bin/env python3
"""LUNA M1 theory lab v1: liquidity / microstructure conditioning.

Keeps M1's core rule locked: monthly rebalance, rank recent 1M losers,
equal-weight top-K=20, and forward next-month return. It tests only the
liquidity/52-week-high conditioning family before touching other theories.

Selection is frozen on TRAIN+DEV. OOS and HOLDOUT are descriptive only.
Costs are evaluated at 20/40/60 bps per turnover unit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd


BASE_REQUIRED = {
    "symbol", "month_end", "adj_close",
    "mom1", "high52_ratio", "avg_amount20",
}


@dataclass(frozen=True)
class Candidate:
    name: str
    rev_w: float
    liq_w: float
    pth_w: float
    interaction: bool
    liquidity_style: str
    amount_floor: float
    pth_focus: bool
    k: int = 20

    def terms(self):
        return {
            "rev_w": self.rev_w,
            "liq_w": self.liq_w,
            "pth_w": self.pth_w,
            "interaction": self.interaction,
            "liquidity_style": self.liquidity_style,
            "amount_floor": self.amount_floor,
            "pth_focus": self.pth_focus,
            "k": self.k,
        }


def geo(a) -> float:
    x = pd.Series(a, dtype=float).dropna()
    if x.empty or (x <= -1).any():
        return -1.0
    return float(np.expm1(np.log1p(x).mean()))


def perf(s: pd.Series) -> dict:
    x = pd.to_numeric(s, errors="coerce").dropna().astype(float)
    if x.empty:
        return {
            "months": 0, "geo_monthly": -1.0, "cumulative": -1.0,
            "positive_month_pct": 0.0, "worst_month": None,
            "best_month": None, "max_drawdown_pct": None,
            "cagr": -1.0,
        }
    eq = (1.0 + x).cumprod()
    peak = eq.cummax()
    dd = eq / peak - 1.0
    g = geo(x)
    return {
        "months": int(len(x)),
        "geo_monthly": g,
        "cumulative": float(eq.iloc[-1] - 1.0),
        "positive_month_pct": float((x > 0).mean()),
        "worst_month": float(x.min()),
        "best_month": float(x.max()),
        "max_drawdown_pct": float(dd.min()),
        "cagr": float((1.0 + g) ** 12 - 1.0),
    }


def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    missing = sorted(BASE_REQUIRED - set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")

    df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    df["month_end"] = pd.to_datetime(df["month_end"])
    for c in ["adj_close", "mom1", "high52_ratio", "avg_amount20"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df = (
        df.sort_values(["month_end", "symbol"])
          .drop_duplicates(["month_end", "symbol"])
          .reset_index(drop=True)
    )

    df["fwd1"] = (
        df.groupby("symbol")["adj_close"].shift(-1)
        / df["adj_close"] - 1.0
    )
    next_month = df.groupby("symbol")["month_end"].shift(-1)
    expected = df["month_end"] + pd.offsets.MonthEnd(1)
    df.loc[next_month.ne(expected), "fwd1"] = np.nan
    return df


def rank_monthly(df: pd.DataFrame) -> pd.DataFrame:
    for c in ["mom1", "high52_ratio", "avg_amount20"]:
        df[f"R_{c}"] = df.groupby("month_end")[c].rank(
            pct=True, method="average"
        )
    # M1 core: lower recent 1M return is better.
    df["REV"] = 1.0 - df["R_mom1"]
    # Liquidity-safe: favor more liquid names.
    df["LQ_SAFE"] = df["R_avg_amount20"]
    # Contrarian liquidity: favor less liquid names, but still cap via optional floor.
    df["LQ_CONTRA"] = 1.0 - df["R_avg_amount20"]
    # Price-to-52W-high conditioning: lower ratio means farther below the high.
    df["PTH"] = 1.0 - df["R_high52_ratio"]
    return df


def make_candidates(k: int) -> list[Candidate]:
    out = [
        Candidate(
            name="M1_REV_K20", rev_w=1.0, liq_w=0.0, pth_w=0.0,
            interaction=False, liquidity_style="SAFE", amount_floor=0.0,
            pth_focus=False, k=k,
        )
    ]
    idx = 0
    for rev_w in (0.60, 0.75, 0.90):
        for liq_w in (0.05, 0.10, 0.20, 0.30):
            for pth_w in (0.00, 0.10, 0.20):
                for interaction in (False, True):
                    for style in ("SAFE", "CONTRARIAN"):
                        for amount_floor in (0.00, 0.20, 0.40):
                            for pth_focus in (False, True):
                                if pth_focus and pth_w == 0.0:
                                    continue
                                total = rev_w + liq_w + pth_w
                                if total <= 0:
                                    continue
                                idx += 1
                                out.append(
                                    Candidate(
                                        name=(
                                            f"LQ{idx:04d}_RW{rev_w:.2f}"
                                            f"_LW{liq_w:.2f}_PW{pth_w:.2f}"
                                            f"_I{int(interaction)}_{style}"
                                            f"_AF{amount_floor:.2f}_PH{int(pth_focus)}"
                                        ),
                                        rev_w=rev_w / total,
                                        liq_w=liq_w / total,
                                        pth_w=pth_w / total,
                                        interaction=interaction,
                                        liquidity_style=style,
                                        amount_floor=amount_floor,
                                        pth_focus=pth_focus,
                                        k=k,
                                    )
                                )
    return out


def score_one(df: pd.DataFrame, c: Candidate) -> pd.DataFrame:
    x = df[[
        "month_end", "symbol", "fwd1",
        "REV", "LQ_SAFE", "LQ_CONTRA", "PTH",
        "R_avg_amount20", "R_high52_ratio",
    ]].copy()

    if c.amount_floor > 0:
        x = x[
            x.groupby("month_end")["R_avg_amount20"]
             .transform("rank", pct=True) >= c.amount_floor
        ]

    liq = x["LQ_SAFE"] if c.liquidity_style == "SAFE" else x["LQ_CONTRA"]
    core = (
        c.rev_w * x["REV"]
        + c.liq_w * liq
        + c.pth_w * x["PTH"]
    )

    if c.interaction:
        core = core + 0.25 * (x["REV"] * liq)

    if c.pth_focus:
        # A mild preference for deeper below-high names, without replacing M1.
        core = core + 0.15 * (x["REV"] * x["PTH"])

    x["score"] = core
    x = x.dropna(subset=["score", "fwd1"])
    x = x.sort_values(
        ["month_end", "score", "symbol"],
        ascending=[True, False, True],
    )
    top = x.groupby("month_end", sort=True).head(c.k)

    gross = top.groupby("month_end")["fwd1"].mean()
    turnovers = []
    prev = set()
    for month, part in top.groupby("month_end", sort=True):
        cur = set(part["symbol"])
        t = 1.0 if not prev else 1.0 - len(cur & prev) / float(c.k)
        turnovers.append((month, t))
        prev = cur

    turnover = pd.Series(dict(turnovers), dtype=float)
    return pd.DataFrame({"gross": gross, "turnover": turnover}).sort_index()


def net_returns(base: pd.DataFrame, bps: float) -> pd.Series:
    return base["gross"] - base["turnover"] * (bps / 10000.0)


def select_robust(results: pd.DataFrame, ref_bps: float, stress_bps: float) -> pd.DataFrame:
    wide = results[
        ["candidate", "bps", "DEV_geo_monthly",
         "DEV_positive_month_pct", "DEV_max_drawdown_pct"]
    ].copy()
    geo_p = wide.pivot_table(
        index="candidate", columns="bps",
        values="DEV_geo_monthly", aggfunc="first"
    )
    pos_p = wide.pivot_table(
        index="candidate", columns="bps",
        values="DEV_positive_month_pct", aggfunc="first"
    )
    dd = (
        wide[wide["bps"] == ref_bps]
        .set_index("candidate")["DEV_max_drawdown_pct"]
    )

    meta = pd.DataFrame(index=geo_p.index)
    meta["dev_geo_ref"] = geo_p.get(ref_bps, np.nan)
    meta["dev_geo_stress"] = geo_p.get(stress_bps, np.nan)
    meta["dev_geo_worst"] = meta[["dev_geo_ref", "dev_geo_stress"]].min(axis=1)
    meta["dev_pos_ref"] = pos_p.get(ref_bps, np.nan)
    meta["dev_pos_stress"] = pos_p.get(stress_bps, np.nan)
    meta["dev_dd_ref"] = dd
    meta["robust_score"] = (
        meta["dev_geo_worst"] - 0.25 * meta["dev_dd_ref"].abs()
    )
    meta["candidate"] = meta.index
    return meta.sort_values(
        ["robust_score", "dev_pos_ref", "dev_pos_stress", "candidate"],
        ascending=[False, False, False, True],
    )


def period(s: pd.Series, start: str, end: str) -> pd.Series:
    idx = pd.to_datetime(s.index)
    return s[(idx >= pd.Timestamp(start)) & (idx <= pd.Timestamp(end))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--costs", default="20,40,60")
    args = ap.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    df = rank_monthly(load_data(args.input))
    candidates = make_candidates(args.k)

    (out / "candidate_catalog.json").write_text(
        json.dumps(
            [{"name": c.name, **c.terms()} for c in candidates],
            indent=2,
        ),
        encoding="utf-8",
    )

    rows = []
    series_cache: dict[tuple[str, float], pd.Series] = {}
    for c in candidates:
        base = score_one(df, c)
        for bps in [float(z) for z in args.costs.split(",")]:
            net = net_returns(base, bps)
            series_cache[(c.name, bps)] = net
            train = period(net, "2021-10-01", "2023-12-31")
            dev = period(net, "2024-01-01", "2024-12-31")
            oos = period(net, "2025-01-01", "2025-12-31")
            hold = period(net, "2026-01-01", "2026-12-31")
            row = {
                "candidate": c.name,
                "bps": bps,
                "regime": "LIQUIDITY_PTH",
            }
            for label, s in [
                ("TRAIN", train), ("DEV", dev),
                ("OOS", oos), ("HOLDOUT", hold),
            ]:
                p = perf(s)
                row.update({f"{label}_{k}": v for k, v in p.items()})
            rows.append(row)

    all_df = pd.DataFrame(rows)
    all_df.to_csv(out / "candidate_results.csv", index=False)

    ref_bps = float(args.costs.split(",")[0])
    stress_bps = float(args.costs.split(",")[-1])
    robust = select_robust(all_df, ref_bps, stress_bps)
    robust.to_csv(out / "robust_ranking.csv", index=False)

    chosen_name = "M1_REV_K20"
    if not robust.empty:
        chosen_name = str(robust.iloc[0]["candidate"])

    chosen_ref = all_df[
        (all_df["candidate"] == chosen_name) &
        (all_df["bps"] == ref_bps)
    ].iloc[0].to_dict()

    m1_ref = all_df[
        (all_df["candidate"] == "M1_REV_K20") &
        (all_df["bps"] == ref_bps)
    ].iloc[0].to_dict()

    candidate_train = all_df[
        (all_df["bps"] == ref_bps) &
        (all_df["candidate"].isin(robust.head(12)["candidate"].tolist()))
    ].copy()

    summary = {
        "status": "COMPLETED",
        "engine": "luna-m1-theory-liquidity-pth-v1",
        "as_of": "2026-09-20",
        "data_sha256": hashlib.sha256(
            Path(args.input).read_bytes()
        ).hexdigest(),
        "universe": {
            "symbols": int(df["symbol"].nunique()),
            "rows": int(len(df)),
            "start": str(df["month_end"].min().date()),
            "end": str(df["month_end"].max().date()),
        },
        "candidate_count": int(len(candidates)),
        "k": args.k,
        "costs_bps": [float(z) for z in args.costs.split(",")],
        "split": {
            "TRAIN": "2021-10-01_to_2023-12-31",
            "DEV": "2024-01-01_to_2024-12-31",
            "OOS": "2025-01-01_to_2025-12-31",
            "HOLDOUT": "2026-01-01_to_2026-12-31",
        },
        "selection_rule": (
            "Robust DEV-only selection using reference/stress geometric return "
            "and DEV drawdown. OOS/HOLDOUT never used for selection."
        ),
        "theory_tested": [
            "liquidity conditioning of short-term reversal",
            "safe-liquidity versus contrarian-illiquidity direction",
            "52-week-high distance conditioning",
            "reversal x liquidity interaction",
            "reversal x below-high interaction",
            "minimum liquidity floor",
        ],
        "selected_candidate": chosen_ref,
        "m1_baseline": m1_ref,
        "delta_selected_vs_m1": {
            "DEV_geo_monthly": float(
                chosen_ref["DEV_geo_monthly"] - m1_ref["DEV_geo_monthly"]
            ),
            "OOS_geo_monthly": float(
                chosen_ref["OOS_geo_monthly"] - m1_ref["OOS_geo_monthly"]
            ),
            "HOLDOUT_geo_monthly": float(
                chosen_ref["HOLDOUT_geo_monthly"] - m1_ref["HOLDOUT_geo_monthly"]
            ),
            "HOLDOUT_cumulative": float(
                chosen_ref["HOLDOUT_cumulative"] - m1_ref["HOLDOUT_cumulative"]
            ),
        },
        "hurdle": {
            "target_geometric_monthly_return": 0.07,
            "selected_oos_pass": bool(chosen_ref["OOS_geo_monthly"] >= 0.07),
            "selected_holdout_pass": bool(chosen_ref["HOLDOUT_geo_monthly"] >= 0.07),
            "m1_oos_pass": bool(m1_ref["OOS_geo_monthly"] >= 0.07),
            "m1_holdout_pass": bool(m1_ref["HOLDOUT_geo_monthly"] >= 0.07),
        },
        "promotion_rule": (
            "Do not promote unless HOLDOUT improves versus M1 and remains "
            "positive under cost stress; holdout is blind and descriptive here."
        ),
        "next_theory": "volatility/regime conditioning, kept separate from this experiment",
    }
    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str),
        encoding="utf-8",
    )

    # Compact audit of the frozen shortlist at all tested costs.
    shortlist = robust.head(12)["candidate"].tolist()
    all_df[all_df["candidate"].isin(shortlist)].to_csv(
        out / "shortlist_all_costs.csv", index=False
    )


if __name__ == "__main__":
    main()
