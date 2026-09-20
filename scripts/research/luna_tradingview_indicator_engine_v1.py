#!/usr/bin/env python3
"""LUNA TradingView Indicator Engine v1.

Implements a causal, LUNA-native translation of TradingView's documented
Technical Ratings logic and adds research-only indicators useful for strategy
evolution: Supertrend, ATRP, Bollinger %B/bandwidth, squeeze, VWMA, anchored
week/month VWAP, OBV, Donchian, RSI(2/7/9/14/21), and multi-timeframe ratings.

Important:
- This is a translation from public TradingView documentation, not TradingView
  proprietary source code.
- M1 selection remains independent: bottom K by 20-day adjusted-close momentum.
- All calculations are causal and use only data available on/before the bar.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd


def rma(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def wma(s: pd.Series, n: int) -> pd.Series:
    wt = np.arange(1, n + 1, dtype=float)
    return s.rolling(n, min_periods=n).apply(
        lambda x: float(np.dot(x, wt) / wt.sum()), raw=True
    )


def hma(s: pd.Series, n: int = 9) -> pd.Series:
    return wma(2 * wma(s, max(1, n // 2)) - wma(s, n), max(1, int(np.sqrt(n))))


def true_range(df: pd.DataFrame) -> pd.Series:
    pc = df["close"].shift(1)
    return pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - pc).abs(),
            (df["low"] - pc).abs(),
        ],
        axis=1,
    ).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return rma(true_range(df), n)


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    gain = d.clip(lower=0)
    loss = -d.clip(upper=0)
    ag = rma(gain, n)
    al = rma(loss, n)
    rs = ag / al.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).where(al.ne(0), 100.0)


def stochastic(df: pd.DataFrame, n=14, ks=3, ds=3):
    lo = df["low"].rolling(n, min_periods=n).min()
    hi = df["high"].rolling(n, min_periods=n).max()
    raw = 100 * (df["close"] - lo) / (hi - lo).replace(0, np.nan)
    k = raw.rolling(ks, min_periods=ks).mean()
    d = k.rolling(ds, min_periods=ds).mean()
    return k, d


def cci(df: pd.DataFrame, n=20):
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    ma = tp.rolling(n, min_periods=n).mean()
    mad = tp.rolling(n, min_periods=n).apply(
        lambda x: float(np.mean(np.abs(x - np.mean(x)))), raw=True
    )
    return (tp - ma) / (0.015 * mad.replace(0, np.nan))


def dmi_adx(df: pd.DataFrame, n=14):
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)
    tr = true_range(df)
    atr_r = rma(tr, n)
    pdi = 100 * rma(plus_dm, n) / atr_r.replace(0, np.nan)
    mdi = 100 * rma(minus_dm, n) / atr_r.replace(0, np.nan)
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    adx = rma(dx, n)
    return adx, pdi, mdi


def macd(s: pd.Series):
    m = ema(s, 12) - ema(s, 26)
    sig = ema(m, 9)
    return m, sig, m - sig


def stoch_rsi(s: pd.Series):
    rr = rsi(s, 14)
    lo = rr.rolling(14, min_periods=14).min()
    hi = rr.rolling(14, min_periods=14).max()
    raw = 100 * (rr - lo) / (hi - lo).replace(0, np.nan)
    k = raw.rolling(3, min_periods=3).mean()
    d = k.rolling(3, min_periods=3).mean()
    return k, d, rr


def ultimate_oscillator(df: pd.DataFrame):
    pc = df["close"].shift(1)
    bp = df["close"] - pd.concat([pc, df["low"]], axis=1).min(axis=1)
    tr = true_range(df)
    a7 = bp.rolling(7, min_periods=7).sum() / tr.rolling(7, min_periods=7).sum()
    a14 = bp.rolling(14, min_periods=14).sum() / tr.rolling(14, min_periods=14).sum()
    a28 = bp.rolling(28, min_periods=28).sum() / tr.rolling(28, min_periods=28).sum()
    return (4 * a7 + 2 * a14 + a28) / 7 * 100


def bb(df: pd.DataFrame, n=20, mult=2.0):
    mid = sma(df["close"], n)
    sd = df["close"].rolling(n, min_periods=n).std(ddof=0)
    upper = mid + mult * sd
    lower = mid - mult * sd
    pctb = (df["close"] - lower) / (upper - lower).replace(0, np.nan)
    bandwidth = (upper - lower) / mid.replace(0, np.nan)
    return mid, upper, lower, pctb, bandwidth

def keltner(df: pd.DataFrame, n=20, atr_n=14, mult=1.5):
    basis=ema(df["close"],n)
    a=atr(df,atr_n)
    upper=basis+mult*a
    lower=basis-mult*a
    return basis,upper,lower


def ichimoku(df: pd.DataFrame):
    h9 = df["high"].rolling(9, min_periods=9).max()
    l9 = df["low"].rolling(9, min_periods=9).min()
    conv = (h9 + l9) / 2
    h26 = df["high"].rolling(26, min_periods=26).max()
    l26 = df["low"].rolling(26, min_periods=26).min()
    base = (h26 + l26) / 2
    h52 = df["high"].rolling(52, min_periods=52).max()
    l52 = df["low"].rolling(52, min_periods=52).min()
    span_b = (h52 + l52) / 2
    span_a = (conv + base) / 2
    return conv, base, span_a, span_b


def supertrend(df: pd.DataFrame, n=10, factor=3.0):
    a = atr(df, n)
    hl2 = (df["high"] + df["low"]) / 2.0
    bu = hl2 + factor * a
    bl = hl2 - factor * a
    ub = bu.copy()
    lb = bl.copy()
    direction = pd.Series(index=df.index, dtype=float)
    st = pd.Series(index=df.index, dtype=float)
    for i in range(len(df)):
        if i == 0 or not np.isfinite(a.iloc[i]):
            direction.iloc[i] = -1
            st.iloc[i] = np.nan
            continue
        prev_ub = ub.iloc[i - 1]
        prev_lb = lb.iloc[i - 1]
        ub.iloc[i] = bu.iloc[i] if (bu.iloc[i] < prev_ub or df["close"].iloc[i - 1] > prev_ub) else prev_ub
        lb.iloc[i] = bl.iloc[i] if (bl.iloc[i] > prev_lb or df["close"].iloc[i - 1] < prev_lb) else prev_lb
        prev_st = st.iloc[i - 1]
        prev_dir = direction.iloc[i - 1]
        if prev_dir == -1:
            direction.iloc[i] = 1 if df["close"].iloc[i] > ub.iloc[i] else -1
        else:
            direction.iloc[i] = -1 if df["close"].iloc[i] < lb.iloc[i] else 1
        st.iloc[i] = lb.iloc[i] if direction.iloc[i] == 1 else ub.iloc[i]
    return st, direction


def obv(df: pd.DataFrame):
    change = df["close"].diff()
    signed = np.where(change > 0, df["volume"], np.where(change < 0, -df["volume"], 0.0))
    return pd.Series(signed, index=df.index).cumsum()


def anchored_vwap(df: pd.DataFrame, anchor: str):
    typ = (df["high"] + df["low"] + df["close"]) / 3.0
    key = df["date"].dt.to_period(anchor)
    pv = typ * df["volume"]
    return pv.groupby(key).cumsum() / df["volume"].groupby(key).cumsum().replace(0, np.nan)


def score_bool(buy: pd.Series, sell: pd.Series) -> pd.Series:
    out = pd.Series(0.0, index=buy.index)
    out = out.mask(buy.fillna(False), 1.0)
    out = out.mask(sell.fillna(False), -1.0)
    return out


def compute_tv_ratings(df: pd.DataFrame) -> pd.DataFrame:
    x = df.copy()
    p = x["close"]

    ma = []
    for n in [10, 20, 30, 50, 100, 200]:
        s = sma(p, n)
        e = ema(p, n)
        x[f"SMA{n}"] = s
        x[f"EMA{n}"] = e
        ma.extend([
            score_bool(s < p, s > p),
            score_bool(e < p, e > p)
        ])

    conv, base, span_a, span_b = ichimoku(x)
    h9 = hma(p, 9)
    vwma20 = (p * x["volume"]).rolling(20, min_periods=20).sum() / x["volume"].rolling(20, min_periods=20).sum()
    x["HMA9"] = h9
    x["VWMA20"] = vwma20
    x["ICHIMOKU_CONV"] = conv
    x["ICHIMOKU_BASE"] = base
    x["ICHIMOKU_SPAN_A"] = span_a
    x["ICHIMOKU_SPAN_B"] = span_b
    x["ICHIMOKU_BULL"] = (
        (span_a > span_b) & (base > span_a) & (conv > base) & (p > conv)
    ).astype(int)
    x["ICHIMOKU_BEAR"] = (
        (span_a < span_b) & (base < span_a) & (conv < base) & (p < conv)
    ).astype(int)
    ma.extend([
        score_bool(x["HMA9"] < p, x["HMA9"] > p),
        score_bool(x["VWMA20"] < p, x["VWMA20"] > p),
        score_bool(x["ICHIMOKU_BULL"] == 1, x["ICHIMOKU_BEAR"] == 1),
    ])
    x["TV_MA_RATING"] = pd.concat(ma, axis=1).mean(axis=1)

    osc = []
    rr = rsi(p, 14)
    x["RSI14"] = rr
    osc.append(score_bool((rr < 30) & (rr > rr.shift(1)), (rr > 70) & (rr < rr.shift(1))))

    sk, sd = stochastic(x)
    x["STOCH_K"], x["STOCH_D"] = sk, sd
    osc.append(score_bool((sk < 20) & (sd < 20) & (sk > sd), (sk > 80) & (sd > 80) & (sk < sd)))

    cc = cci(x)
    x["CCI20"] = cc
    osc.append(score_bool((cc < -100) & (cc > cc.shift(1)), (cc > 100) & (cc < cc.shift(1))))

    adx, pdi, mdi = dmi_adx(x)
    x["ADX14"], x["PLUS_DI14"], x["MINUS_DI14"] = adx, pdi, mdi
    # Exact documented TradingView asymmetry: buy requires rising ADX;
    # sell requires falling ADX.
    osc.append(score_bool(
        (pdi > mdi) & (adx > 20) & (adx > adx.shift(1)),
        (pdi < mdi) & (adx > 20) & (adx < adx.shift(1)),
    ))

    med = (x["high"] + x["low"]) / 2.0
    ao = sma(med, 5) - sma(med, 34)
    ao_buy = (ao > 0) & (
        ((ao.shift(1) > 0) & (ao > ao.shift(1)) & (ao.shift(1) < ao.shift(2)))
        | ((ao.shift(1) <= 0) & (ao > 0))
    )
    ao_sell = (ao < 0) & (
        ((ao.shift(1) < 0) & (ao < ao.shift(1)) & (ao.shift(1) > ao.shift(2)))
        | ((ao.shift(1) >= 0) & (ao < 0))
    )
    x["AO"] = ao
    osc.append(score_bool(ao_buy, ao_sell))

    mom10 = p - p.shift(10)
    x["MOM10"] = mom10
    osc.append(score_bool(mom10 > mom10.shift(1), mom10 < mom10.shift(1)))

    mac, sig, hist = macd(p)
    x["MACD"], x["MACD_SIGNAL"], x["MACD_HIST"] = mac, sig, hist
    osc.append(score_bool(mac > sig, mac < sig))

    srk, srd, rsbase = stoch_rsi(p)
    x["STOCH_RSI_K"], x["STOCH_RSI_D"] = srk, srd
    downtrend = p < ema(p, 50)
    uptrend = p > ema(p, 50)
    osc.append(score_bool(
        downtrend & (srk < 20) & (srd < 20) & (srk > srd),
        uptrend & (srk > 80) & (srd > 80) & (srk < srd),
    ))

    hh14 = x["high"].rolling(14, min_periods=14).max()
    ll14 = x["low"].rolling(14, min_periods=14).min()
    wr = -100 * (hh14 - p) / (hh14 - ll14).replace(0, np.nan)
    x["WPR14"] = wr
    osc.append(score_bool((wr < -80) & (wr > wr.shift(1)), (wr > -20) & (wr < wr.shift(1))))

    e50 = ema(p, 50)
    bull = x["high"] - e50
    bear = x["low"] - e50
    x["BULL_POWER"], x["BEAR_POWER"] = bull, bear
    osc.append(score_bool(
        (p > e50) & (bear < 0) & (bear > bear.shift(1)),
        (p < e50) & (bull > 0) & (bull < bull.shift(1)),
    ))

    uo = ultimate_oscillator(x)
    x["UO"] = uo
    osc.append(score_bool(uo > 70, uo < 30))

    x["TV_OSC_RATING"] = pd.concat(osc, axis=1).mean(axis=1)
    x["TV_ALL_RATING"] = (x["TV_MA_RATING"] + x["TV_OSC_RATING"]) / 2.0
    x["TV_ALL_STRONG_BUY"] = (x["TV_ALL_RATING"] > 0.5).astype(int)
    x["TV_ALL_BUY"] = (x["TV_ALL_RATING"] > 0.1).astype(int)
    x["TV_ALL_SELL"] = (x["TV_ALL_RATING"] < -0.1).astype(int)
    x["TV_ALL_STRONG_SELL"] = (x["TV_ALL_RATING"] < -0.5).astype(int)
    return x


def add_research_indicators(df: pd.DataFrame) -> pd.DataFrame:
    x = compute_tv_ratings(df)
    x["M1_MOM20_ADJ"] = x["adj_close"].pct_change(20)
    sma60 = sma(x["close"], 60)
    x["DIST_MA60"] = x["close"] / sma60.replace(0, np.nan) - 1.0

    for n in [2, 7, 9, 14, 21]:
        x[f"RSI{n}"] = rsi(x["close"], n)
        x[f"RSI{n}_SLOPE3"] = x[f"RSI{n}"].diff(3)

    x["ATR14"] = atr(x, 14)
    x["ATRP14"] = x["ATR14"] / x["close"].replace(0, np.nan)
    x["ATRP14_RANK60"] = x["ATRP14"].rolling(60, min_periods=60).rank(pct=True)

    mid, upper, lower, pctb, bandwidth = bb(x, 20, 2.0)
    x["BB_MID20"], x["BB_UPPER20"], x["BB_LOWER20"] = mid, upper, lower
    x["BB_PCTB20"], x["BB_BANDWIDTH20"] = pctb, bandwidth
    x["BB_BANDWIDTH20_PCTL120"] = bandwidth.rolling(120, min_periods=60).rank(pct=True)
    x["BB_REENTRY_UP"] = ((pctb > 0) & (pctb.shift(1) <= 0)).astype(int)
    x["BB_REENTRY_MID"] = ((pctb > 0.5) & (pctb.shift(1) <= 0.5)).astype(int)

    # Squeeze proxy: Bollinger width below its rolling 120-day 20th percentile.
    bwq = bandwidth.rolling(120, min_periods=60).quantile(0.2)
    x["SQUEEZE_ON"] = (bandwidth < bwq).astype(int)
    x["SQUEEZE_RELEASE"] = ((x["SQUEEZE_ON"].shift(1).fillna(0) == 1) & (bandwidth > bwq)).astype(int)

    for kmult in [1.5,2.0]:
        _, kcu, kcl = keltner(x,20,14,kmult)
        tag=str(kmult).replace(".","")
        x[f"KC_UPPER20_{tag}"]=kcu
        x[f"KC_LOWER20_{tag}"]=kcl
        # True squeeze: both Bollinger envelopes sit inside Keltner envelopes.
        x[f"SQUEEZE_KC_{tag}"]=((upper<kcu)&(lower>kcl)).astype(int)
        x[f"SQUEEZE_KC_RELEASE_{tag}"]=(
            (x[f"SQUEEZE_KC_{tag}"].shift(1).fillna(0)==1)
            & ((upper>=kcu)|(lower<=kcl))
        ).astype(int)

    for n, fac in [(10,3.0),(7,2.0),(14,3.0)]:
        st, direc = supertrend(x, n, fac)
        tag=f"ST{n}X{fac:.1f}".replace(".","")
        x[f"{tag}_LINE"]=st
        x[f"{tag}_DIR"]=direc
        x[f"{tag}_FLIP_UP"]=((direc==1)&(direc.shift(1)==-1)).astype(int)
        x[f"{tag}_FLIP_DOWN"]=((direc==-1)&(direc.shift(1)==1)).astype(int)

    x["VWMA20"] = (x["close"]*x["volume"]).rolling(20,min_periods=20).sum()/x["volume"].rolling(20,min_periods=20).sum()
    x["PRICE_VWMA20_GAP"] = x["close"]/x["VWMA20"]-1.0
    x["VWAP_WEEK"] = anchored_vwap(x, "W")
    x["VWAP_MONTH"] = anchored_vwap(x, "M")
    x["PRICE_VWAP_WEEK_GAP"] = x["close"]/x["VWAP_WEEK"]-1.0
    x["PRICE_VWAP_MONTH_GAP"] = x["close"]/x["VWAP_MONTH"]-1.0

    x["OBV"] = obv(x)
    x["OBV_SLOPE20"] = x["OBV"].diff(20)
    x["OBV_Z20"] = (x["OBV_SLOPE20"] - x["OBV_SLOPE20"].rolling(60,min_periods=30).mean()) / x["OBV_SLOPE20"].rolling(60,min_periods=30).std(ddof=0).replace(0,np.nan)

    for n in [20,55,252]:
        hi=x["high"].rolling(n,min_periods=n).max()
        lo=x["low"].rolling(n,min_periods=n).min()
        x[f"DONCHIAN_HIGH{n}"]=hi
        x[f"DONCHIAN_LOW{n}"]=lo
        x[f"DONCHIAN_POS{n}"]=(x["close"]-lo)/(hi-lo).replace(0,np.nan)
        x[f"BREAKOUT{n}"]=(x["close"]>hi.shift(1)).astype(int)
        x[f"BREAKDOWN{n}"]=(x["close"]<lo.shift(1)).astype(int)

    # Causal divergence proxies.
    x["PRICE_MOM20"] = x["close"].pct_change(20)
    x["RSI14_DELTA20"] = x["RSI14"].diff(20)
    x["RSI_BULL_DIV_PROXY"] = ((x["PRICE_MOM20"]<0)&(x["RSI14_DELTA20"]>0)&(x["RSI14_SLOPE3"]>0)).astype(int)

    # Reversal candle confirmations.
    body=(x["close"]-x["open"]).abs()
    rng=(x["high"]-x["low"]).replace(0,np.nan)
    uw=x["high"]-x[["open","close"]].max(axis=1)
    lw=x[["open","close"]].min(axis=1)-x["low"]
    x["HAMMER"]=((lw>=2*body)&(uw<=body)&((body/rng)<=0.4)).astype(int)
    prev_open=x["open"].shift(1)
    prev_close=x["close"].shift(1)
    x["BULL_ENGULF"]=((prev_close<prev_open)&(x["close"]>x["open"])&(x["open"]<=prev_close)&(x["close"]>=prev_open)).astype(int)
    x["BULL_REVERSAL"]=(x["HAMMER"]|x["BULL_ENGULF"]).astype(int)

    return x.replace([np.inf,-np.inf],np.nan)


def load(path: str) -> pd.DataFrame:
    df=pd.read_csv(path,parse_dates=["date"])
    need={"date","symbol","open","high","low","close","volume","adj_close"}
    missing=sorted(need-set(df.columns))
    if missing:
        raise SystemExit(f"missing columns: {missing}")
    for c in need-{"date","symbol"}:
        df[c]=pd.to_numeric(df[c],errors="coerce")
    df["symbol"]=df["symbol"].astype(str).str.upper().str.strip()
    df=df.sort_values(["symbol","date"]).drop_duplicates(["symbol","date"]).reset_index(drop=True)
    # Use adjusted price for return/momentum computations while indicators use OHLCV.
    return df


def resample_ohlcv(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    z=(
        df.set_index("date")
          .sort_index()
          .resample(rule, label="right", closed="right")
          .agg(
              open=("open","first"),
              high=("high","max"),
              low=("low","min"),
              close=("close","last"),
              adj_close=("adj_close","last"),
              volume=("volume","sum")
          )
          .dropna(subset=["close"])
          .reset_index()
    )
    return z

def add_mtf_ratings(daily: pd.DataFrame, raw: pd.DataFrame) -> pd.DataFrame:
    z=daily.sort_values("date").copy()
    for label, rule in [("W","W-FRI"),("M","ME")]:
        rs=compute_tv_ratings(resample_ohlcv(raw,rule))
        rs=rs[["date","TV_MA_RATING","TV_OSC_RATING","TV_ALL_RATING"]].sort_values("date")
        rs=rs.rename(columns={
            "TV_MA_RATING":f"TV_MA_{label}",
            "TV_OSC_RATING":f"TV_OSC_{label}",
            "TV_ALL_RATING":f"TV_ALL_{label}"
        })
        z=pd.merge_asof(z,rs,on="date",direction="backward")
    z["TV_MA_D"]=z["TV_MA_RATING"]
    z["TV_OSC_D"]=z["TV_OSC_RATING"]
    z["TV_ALL_D"]=z["TV_ALL_RATING"]
    z["TV_MTF_ALL_POSITIVE"]=(
        (z["TV_ALL_D"]>0.1)&(z["TV_ALL_W"]>0.1)&(z["TV_ALL_M"]>0.1)
    ).astype(int)
    z["TV_MTF_OSC_POSITIVE"]=(
        (z["TV_OSC_D"]>0.1)&(z["TV_OSC_W"]>0.1)&(z["TV_OSC_M"]>0.1)
    ).astype(int)
    return z

def monthly_snapshot(df: pd.DataFrame) -> pd.DataFrame:
    out=df.copy()
    out["month_end"]=out["date"].dt.to_period("M").dt.to_timestamp("M")
    return (
        out.sort_values(["symbol","date"])
           .groupby(["symbol","month_end"],as_index=False)
           .tail(1)
           .reset_index(drop=True)
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)

    df=load(args.input)
    parts=[]
    for symbol,g in df.groupby("symbol",sort=False):
        z=add_research_indicators(g.copy())
        z=add_mtf_ratings(z,g.copy())
        parts.append(z)
    daily=pd.concat(parts,ignore_index=True)
    daily.to_parquet(out/"daily_indicators.parquet",index=False)
    monthly=monthly_snapshot(daily)
    monthly.to_csv(out/"monthly_indicator_panel.csv",index=False)

    summary={
        "status":"COMPLETED",
        "engine":"luna-tradingview-indicator-engine-v1",
        "data_sha256":hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "symbols":int(daily.symbol.nunique()),
        "daily_rows":int(len(daily)),
        "monthly_rows":int(len(monthly)),
        "tv_technical_rating_constituents":26,
        "tv_ma_constituents":15,
        "tv_oscillator_constituents":11,
        "research_extensions":[
            "RSI2/7/9/14/21","ATR14/ATRP14","Bollinger %B/bandwidth",
            "Bollinger squeeze/release","Supertrend 10x3, 7x2, 14x3",
            "VWMA20","anchored week/month VWAP","OBV slope/z-score",
            "Donchian 20/55/252","RSI bullish divergence proxy",
            "Hammer/Bullish Engulfing"
        ],
        "tv_translation_notes":[
            "TradingView public documented rules are implemented where published.",
            "Stoch RSI trend state uses a causal price-vs-EMA50 proxy.",
            "Bull/Bear Power uptrend/downtrend uses price-vs-EMA50, matching the Bull/Bear Power anchor used by the research translation.",
            "These two proxy definitions are recorded hypotheses, not claims of byte-identical proprietary implementation."
        ]
    }
    (out/"summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")
    print(json.dumps(summary,indent=2))


if __name__=="__main__":
    main()
