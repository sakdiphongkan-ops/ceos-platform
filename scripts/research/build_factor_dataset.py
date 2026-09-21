#!/usr/bin/env python3
"""Build the point-in-time factor matrix consumed by the 1M search engine."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

FUND_COLS = {
    "PE":"pe","PBV":"pbv","EV_EBITDA":"ev_ebitda","FCF_YIELD":"fcf_yield",
    "EARNINGS_YIELD":"earnings_yield","DIV_YIELD":"div_yield","ROE":"roe",
    "ROA":"roa","ROIC":"roic","GPM":"gpm","NPM":"npm","CFO_MARGIN":"cfo_margin",
    "REV_G":"rev_g","EPS_G":"eps_g","NI_G":"ni_g","FCF_G":"fcf_g",
    "ASSET_G":"asset_g","CAPEX_G":"capex_g","INVESTMENT_RATE":"investment_rate",
    "DIV_G":"div_g","PAYOUT":"payout","BUYBACK":"buyback","DE":"de",
    "NET_DEBT_EBITDA":"net_debt_ebitda","INTEREST_COVER":"interest_cover",
    "CURRENT_RATIO":"current_ratio","ADV20":"adv20","TURNOVER":"turnover","AMOUNT":"amount",
}

OUT_COLS = [
    "date","symbol","market","decision_ts","available_at","adj_close",
    "PE","PBV","EV_EBITDA","FCF_YIELD","EARNINGS_YIELD","DIV_YIELD",
    "ROE","ROA","ROIC","GPM","NPM","CFO_MARGIN","REV_G","EPS_G","NI_G","FCF_G",
    "MOM_5","MOM_10","MOM_20","MOM_40","MOM_60","MOM_80","MOM_120","MOM_252","REL_MOM",
    "VOL_10","VOL_20","BETA","MAXDD_60","ATR_PCT","ADV20","TURNOVER","AMOUNT",
    "ASSET_G","CAPEX_G","INVESTMENT_RATE","DIV_G","PAYOUT","BUYBACK","DE",
    "NET_DEBT_EBITDA","INTEREST_COVER","CURRENT_RATIO","RSI14",
    "DIST_MA20","DIST_MA60","DIST_HIGH_252","BREAKOUT20","BREAKOUT55","SKEW_20","SKEW_60","ATR_PCT","ILLIQ_20","QUALITY_SCORE","VALUE_QUALITY","MOM_BLEND","CONSERVATIVE_SCORE","SAFETY_SCORE","GROWTH_QUALITY","INV_QUALITY",
    "fwd_return","fwd_return_1d","fwd_return_5d","fwd_return_20d",
]

def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0)
    dn = -d.clip(upper=0)
    au = up.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    out = out.where(ad.ne(0), 100.0)
    return out

def true_range(g: pd.DataFrame) -> pd.Series:
    prev = g["close"].shift(1)
    return pd.concat([
        g["high"] - g["low"],
        (g["high"] - prev).abs(),
        (g["low"] - prev).abs(),
    ], axis=1).max(axis=1)

def load_benchmark(path: str | None) -> pd.DataFrame | None:
    if not path:
        return None
    b = pd.read_csv(path)
    need = {"date","close"}
    if not need.issubset(b.columns):
        raise SystemExit(f"benchmark must contain {sorted(need)}")
    b["date"] = pd.to_datetime(b["date"], errors="raise").dt.date
    b["close"] = pd.to_numeric(b["close"], errors="coerce")
    b = b.sort_values("date").dropna(subset=["close"]).drop_duplicates("date")
    b["ret"] = b["close"].pct_change()
    b["mom20"] = b["close"].pct_change(20)
    return b[["date","ret","mom20"]]

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True)
    ap.add_argument("--fundamentals")
    ap.add_argument("--benchmark")
    ap.add_argument("--output", required=True)
    ap.add_argument("--decision-hour", type=int, default=17)
    ap.add_argument("--feature-version", default="luna-features-v1")
    args = ap.parse_args()

    p = pd.read_csv(args.prices)
    need = {"date","symbol","open","high","low","close","volume"}
    if not need.issubset(p.columns):
        raise SystemExit(f"prices missing {sorted(need-set(p.columns))}")
    p["date"] = pd.to_datetime(p["date"], errors="raise").dt.date
    p["symbol"] = p["symbol"].astype("string").str.strip().str.upper()
    for c in ["open","high","low","close","volume","adj_close","amount"]:
        if c in p.columns:
            p[c] = pd.to_numeric(p[c], errors="coerce")
    px = "adj_close" if "adj_close" in p.columns and p["adj_close"].notna().any() else "close"
    p[px] = p[px].where(p[px].gt(0))
    p = p.sort_values(["symbol","date"]).reset_index(drop=True)

    # EOD value is tradable only after the decision cutoff. The next trading day's
    # return is therefore the first forward-return observation.
    dt = pd.to_datetime(p["date"]).dt.tz_localize("Asia/Bangkok") + pd.Timedelta(hours=args.decision_hour)
    p["decision_ts"] = dt.dt.tz_convert("UTC")
    if "available_at" in p.columns:
        p["available_at"] = pd.to_datetime(p["available_at"], utc=True)
    else:
        p["available_at"] = p["decision_ts"]

    if "amount" not in p.columns:
        p["amount"] = p["close"] * p["volume"]

    g = p.groupby("symbol", group_keys=False)
    ret = g[px].pct_change()
    for n in [5,10,20,40,60,80,120,252]:
        p[f"MOM_{n}"] = g[px].pct_change(n)
    p["VOL_10"] = ret.groupby(p["symbol"]).rolling(10, min_periods=10).std().reset_index(level=0, drop=True)
    p["VOL_20"] = ret.groupby(p["symbol"]).rolling(20, min_periods=20).std().reset_index(level=0, drop=True)
    p["SKEW_20"] = ret.groupby(p["symbol"]).rolling(20, min_periods=20).skew().reset_index(level=0, drop=True)
    p["SKEW_60"] = ret.groupby(p["symbol"]).rolling(60, min_periods=60).skew().reset_index(level=0, drop=True)
    p["MAXDD_60"] = p[px] / g[px].rolling(60, min_periods=60).max().reset_index(level=0, drop=True) - 1
    p["DIST_MA20"] = p[px] / g[px].rolling(20, min_periods=20).mean().reset_index(level=0, drop=True) - 1
    p["DIST_MA60"] = p[px] / g[px].rolling(60, min_periods=60).mean().reset_index(level=0, drop=True) - 1
    p["DIST_HIGH_252"] = p[px] / g[px].rolling(252, min_periods=252).max().reset_index(level=0, drop=True) - 1
    p["BREAKOUT20"] = p[px] / g[px].shift(1).rolling(20, min_periods=20).max().reset_index(level=0, drop=True) - 1
    p["BREAKOUT55"] = p[px] / g[px].shift(1).rolling(55, min_periods=55).max().reset_index(level=0, drop=True) - 1
    tr = g.apply(true_range).reset_index(level=0, drop=True)
    p["ATR_PCT"] = tr.groupby(p["symbol"]).rolling(14, min_periods=14).mean().reset_index(level=0, drop=True) / p["close"]
    p["ILLIQ_20"] = (ret.abs() / p["amount"].replace(0, np.nan)).groupby(p["symbol"]).rolling(20, min_periods=20).mean().reset_index(level=0, drop=True)

    def adv(x: pd.Series) -> pd.Series:
        return x.rolling(20, min_periods=20).mean()
    p["AMOUNT"] = g["amount"].apply(adv).reset_index(level=0, drop=True)
    p["ADV20"] = p["AMOUNT"]
    p["TURNOVER"] = np.nan
    p["RSI14"] = g[px].apply(rsi).reset_index(level=0, drop=True)

    bench = load_benchmark(args.benchmark)
    p["REL_MOM"] = np.nan
    p["BETA"] = np.nan
    if bench is not None:
        p = p.merge(bench, on="date", how="left", suffixes=("", "_bench"))
        p["REL_MOM"] = p["MOM_20"] - p["mom20"]
        p["BETA"] = (
            p.groupby("symbol", group_keys=False)
             .apply(lambda z: z["close"].pct_change().rolling(60, min_periods=60).cov(z["ret_bench"])
                    / z["ret_bench"].rolling(60, min_periods=60).var())
             .reset_index(level=0, drop=True)
        )

    # Point-in-time fundamental merge: only values whose publication timestamp is
    # at or before this row's decision timestamp are eligible.
    pit_fundamental_rows = 0
    pit_future_rows = 0
    pit_fundamental_fields = []
    if args.fundamentals:
        f = pd.read_csv(args.fundamentals)
        required = {"symbol","available_at"}
        if not required.issubset(f.columns):
            raise SystemExit("fundamentals require symbol and available_at")
        f["symbol"] = f["symbol"].astype("string").str.strip().str.upper()
        f["available_at"] = pd.to_datetime(f["available_at"], utc=True)
        f = f.rename(columns={"available_at":"fund_available_at"})
        f = f.sort_values(["symbol","fund_available_at"])
        keep = ["symbol","fund_available_at"] + [c for c in f.columns if c.lower() in set(FUND_COLS.values())]
        keep = list(dict.fromkeys([c for c in keep if c in f.columns]))
        f = f[keep].copy()
        p = pd.merge_asof(
            p.sort_values(["decision_ts","symbol"]),
            f.sort_values(["fund_available_at","symbol"]),
            left_on="decision_ts",
            right_on="fund_available_at",
            by="symbol",
            direction="backward",
            suffixes=("", "_fund"),
        )
        for out_name, src in FUND_COLS.items():
            if src in p.columns:
                p[out_name] = pd.to_numeric(p[src], errors="coerce")
            elif out_name not in p.columns:
                p[out_name] = np.nan
        p["available_at"] = p[["available_at","fund_available_at"]].max(axis=1)
        pit_fundamental_rows = int(p["fund_available_at"].notna().sum())
        pit_future_rows = int((p["fund_available_at"] > p["decision_ts"]).fillna(False).sum())
        pit_fundamental_fields = [
            c for c in FUND_COLS if c in p.columns and pd.to_numeric(p[c], errors="coerce").notna().any()
        ]
        if pit_future_rows:
            raise SystemExit(f"point-in-time fundamental leakage detected: {pit_future_rows} rows")
    else:
        for c in [c for c in OUT_COLS if c.isupper() and c not in p.columns]:
            p[c] = np.nan

    # Derived multi-signal composites. Every component is point-in-time and the
    # cross-sectional ranks are computed using only information on the same decision date.
    # They expand the search space without introducing forward data.
    rank_cols = [
        "ROIC","ROE","ROA","GPM","NPM","CFO_MARGIN","REV_G","EPS_G","NI_G","FCF_G",
        "EARNINGS_YIELD","FCF_YIELD","DIV_YIELD","MOM_20","MOM_60","MOM_120","REL_MOM",
        "VOL_20","DE","NET_DEBT_EBITDA","INTEREST_COVER","CURRENT_RATIO",
        "ASSET_G","CAPEX_G","INVESTMENT_RATE","PAYOUT","BUYBACK","SKEW_20","SKEW_60"
    ]
    ranks = {name: p.groupby("date")[name].rank(pct=True) for name in rank_cols if name in p.columns}
    def rr(name: str) -> pd.Series:
        return ranks.get(name, pd.Series(np.nan, index=p.index))
    p["QUALITY_SCORE"] = (rr("ROIC") + rr("ROE") + rr("GPM") + rr("NPM") + rr("CFO_MARGIN") - rr("DE")) / 5.0
    p["VALUE_QUALITY"] = (rr("EARNINGS_YIELD") + rr("FCF_YIELD") + rr("ROIC") + rr("CFO_MARGIN")) / 4.0
    p["MOM_BLEND"] = (rr("MOM_20") + rr("MOM_60") + rr("MOM_120") + rr("REL_MOM")) / 4.0
    p["CONSERVATIVE_SCORE"] = (rr("MOM_120") + rr("DIV_YIELD") + rr("FCF_YIELD") - rr("VOL_20")) / 4.0
    p["SAFETY_SCORE"] = (rr("INTEREST_COVER") + rr("CURRENT_RATIO") + rr("ROIC") - rr("DE") - rr("NET_DEBT_EBITDA")) / 5.0
    p["GROWTH_QUALITY"] = (rr("REV_G") + rr("EPS_G") + rr("FCF_G") + rr("ROIC") + rr("CFO_MARGIN")) / 5.0
    p["INV_QUALITY"] = (rr("ROIC") - rr("ASSET_G") - rr("CAPEX_G") - rr("INVESTMENT_RATE") + rr("FCF_G")) / 5.0

    # Rebuild the groupby after any merge so no stale frame/index can leak into returns.
    g2 = p.groupby("symbol", group_keys=False)
    for h in [1,5,20]:
        p[f"fwd_return_{h}d"] = g2[px].shift(-h) / p[px] - 1
    p["fwd_return"] = p["fwd_return_1d"]

    if "market" not in p.columns:
        p["market"] = np.nan

    keep = [c for c in OUT_COLS if c in p.columns]
    out = p[keep].replace([np.inf,-np.inf], np.nan).sort_values(["date","symbol"])
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)

    manifest = {
        "feature_version": args.feature_version,
        "derived_composites": ["QUALITY_SCORE","VALUE_QUALITY","MOM_BLEND","CONSERVATIVE_SCORE","SAFETY_SCORE","GROWTH_QUALITY","INV_QUALITY"],

        "rows": int(len(out)),
        "symbols": int(out["symbol"].nunique()),
        "start": str(out["date"].min()),
        "end": str(out["date"].max()),
        "price_column": px,
        "fundamentals_point_in_time": bool(args.fundamentals),
        "pit_fundamental_rows": pit_fundamental_rows,
        "pit_future_rows": pit_future_rows,
        "pit_fundamental_fields_covered": pit_fundamental_fields,
        "pit_contract": "fundamentals must provide source availability timestamp; statement as-of date alone is not accepted",
        "benchmark_used": bool(args.benchmark),
        "recognized_factor_count": int(sum(c in out.columns for c in OUT_COLS)),
        "forward_return_definition": "next trading observation relative to decision-day adjusted close",
    }
    Path(args.output).with_suffix(".manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2))

if __name__ == "__main__":
    main()
