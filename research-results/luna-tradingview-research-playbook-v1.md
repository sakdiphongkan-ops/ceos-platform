# LUNA TradingView + Strategy Research Playbook v1

## Purpose

Convert publicly documented TradingView indicator logic and transparent open-source strategy ideas into
LUNA-native, causal research features. This document is a research registry, not a list of trading
recommendations.

## Tier 1 — TradingView Technical Ratings: exact public specification

TradingView Technical Ratings aggregates 26 component indicators:
- 15 MA components: SMA/EMA 10/20/30/50/100/200, Hull MA 9, VWMA 20, Ichimoku 9/26/52.
- 11 oscillator components: RSI14, Stochastic 14/3/3, CCI20, ADX14/14, Awesome Oscillator,
  Momentum10, MACD 12/26/9, Stochastic RSI, Williams %R14, Bull/Bear Power, UO 7/14/28.
- Each component emits +1/0/-1; MA rating and oscillator rating are averages; All is the average
  of the two groups.
- Rating bands: Strong Sell < -0.5; Sell [-0.5,-0.1); Neutral [-0.1,0.1]; Buy (0.1,0.5];
  Strong Buy > 0.5.

Primary references:
- https://www.tradingview.com/support/solutions/43000614331-technical-ratings/
- https://www.tradingview.com/support/solutions/43000475547-what-do-the-ratings-in-the-screener-mean/
- https://www.tradingview.com/script/dHhrROXa-Technical-Ratings-on-Chart/
- https://www.tradingview.com/script/jDWyb5PG-TechnicalRating/

Important source-level detail:
TradingView's open-source TechnicalRating library says the ratings match the Screener/Technicals
gauges. The Nov 2024 library release updated conditions to better align with the Screener. The
library lists Bull/Bear Power period 50 and exposes calcRatingAll()/ratingStatus().

## Tier 2 — Individual indicator mechanisms

### RSI
Use as momentum state, not as a standalone directional oracle.
Candidate mechanisms:
- oversold + rising
- midpoint/regime state
- divergence
- fast/slow RSI agreement
- RSI2 pullback inside long-term trend

Reference:
https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/

### MACD
Candidate mechanisms:
- MACD > signal
- histogram zero cross
- histogram slope
- MACD confirmation after RSI/BB exhaustion

Reference:
https://www.tradingview.com/support/solutions/43000644943-macd-strategy/

### Bollinger Bands
Use both location and volatility:
- %B
- lower-band excursion and re-entry
- bandwidth compression
- trend-aware avoidance of blindly buying lower-band touches

Reference:
https://www.tradingview.com/support/solutions/43000501840-bollinger-bands-bb/
https://www.tradingview.com/support/solutions/43000501971-bollinger-bands-b-b/

### ADX / DMI
Use as a regime classifier:
- weak-trend mean reversion
- strong-trend continuation
- +DI/-DI direction
- ADX acceleration/deceleration

Reference:
https://www.tradingview.com/support/solutions/43000589099-average-directional-index-adx/

### Ichimoku
Use as a multi-condition trend state:
- price/cloud relation
- conversion/base relation
- span A/B relation
- trend confirmation rather than standalone timing

Reference:
https://www.tradingview.com/support/solutions/43000589152-ichimoku-cloud/

### ATR / Supertrend
Use volatility-normalized trend state and risk gates:
- Supertrend direction
- flip events
- ATR%
- ATR-relative breakout magnitude
- volatility-adaptive exits

References:
https://www.tradingview.com/support/solutions/43000634738-supertrend/
https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/

### VWMA / VWAP
Use price-volume relationship:
- price above/below VWMA20
- week/month anchored VWAP gap
- volume-confirmed breakout/reversal

References:
https://www.tradingview.com/support/solutions/43000592293-volume-weighted-moving-average-vwma/
https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/

### Keltner / Squeeze
Use volatility compression followed by directional expansion:
- BB inside KC = squeeze
- squeeze release + momentum confirmation
- avoid treating compression alone as a direction signal

Reference:
https://www.tradingview.com/support/solutions/43000502266-keltner-channels-kc/

## Tier 3 — Strategy archetypes researched

1. Technical Ratings ensemble.
2. RSI mean reversion / RSI2 pullback with 200-MA trend filter.
3. RSI divergence + candlestick confirmation.
4. Bollinger lower-band exhaustion + RSI/MACD confirmation.
5. TTM Squeeze / BB-Keltner compression-release.
6. Supertrend + RSI + long-term MA trend filter.
7. Ichimoku + RSI + MACD confluence.
8. Donchian/Turtle-style breakout + ATR risk.
9. OBV divergence / OBV trend confirmation.
10. VWAP/VWMA price-volume confirmation.
11. Multi-timeframe confirmation.
12. Oscillator-led reversal while MA trend is still weak.
13. Volatility/risk gating via ATR%.
14. Trend-following time-series momentum.
15. Cross-sectional momentum.
16. Reversal / short-term mean reversion.
17. Value + momentum.
18. Quality + momentum.
19. Low-beta / low-risk defensive tilt.
20. Ensemble majority vote.

## External research mechanisms

### SET InvestNow — RSI reversal
The article explicitly distinguishes Trend Following and Mean Reversion, describes bullish/bearish RSI
divergence, and recommends confirmation by reversal candlesticks because divergence alone does not
guarantee reversal.

https://www.setinvestnow.com/th/knowledge/article/612-tsi-rsi-for-stock-reversal-trading

### AQR — Value + Momentum
Value and momentum have been documented across multiple markets and asset classes; the two effects
have historically shown negative correlation, motivating diversified combinations rather than blindly
selecting one style.

https://www.aqr.com/Insights/Research/Journal-Article/Value-and-Momentum-Everywhere

### AQR — Quality Minus Junk
Quality can be decomposed into profitability, growth, safety and payout characteristics. LUNA will
test these only with point-in-time fundamental data, never by backfilling future fundamentals.

https://www.aqr.com/Insights/Research/Working-Paper/Quality-Minus-Junk

### AQR — Betting Against Beta
Low-beta/low-risk exposure is a distinct factor family worth testing as a secondary risk-aware
ranking feature, especially for reducing volatility rather than assuming it maximizes raw return.

https://www.aqr.com/insights/research/journal-article/betting-against-beta

### AQR — Time Series Momentum
Past own-asset returns can predict future returns over intermediate horizons in many markets, while
longer-horizon reversal can occur. This motivates regime/horizon-aware momentum experiments.

https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum

## TradingView open-source strategy ideas incorporated as hypotheses

- SuperTrend strategy: ATR-based trend state; common default 10 ATR / 3 multiplier.
- RSI + Bollinger + ADX + MACD confluence.
- RSI + MACD / mean-reversion majority vote.
- Ichimoku + RSI + MACD.
- Donchian breakout with higher-timeframe MA filter and ATR risk.
- TTM Squeeze with BB/Keltner compression.
- OBV divergence and volume-price divergence.

These are hypotheses sourced from public descriptions, not claims that the authors' historical
results transfer to Thai equities.

## LUNA architecture

### Production control
M1_S0_K20_REV remains unchanged.

### Research layer
TradingView-derived features are tested as:
A. exposure gates on the locked M1 20-name basket;
B. second-stage re-ranking inside a larger M1 reversal pool (K=50/100);
C. regime/risk filters;
D. multi-timeframe confirmation;
E. independent strategy families.

### Promotion
A formula is not promoted from an attractive in-sample result.
Required:
- TRAIN + DEV selection only;
- frozen OOS;
- frozen HOLDOUT;
- 20/40/60 bps cost stress;
- exact comparison to locked M1 monthly return series;
- fresh-seed/period replication;
- no lookahead;
- no use of current TradingView snapshot as historical labels.

## Data separation

1. Live TradingView snapshot: current cross-sectional research only.
2. Historical LUNA daily data: used to reconstruct indicator histories causally.
3. TradingView documentation/open-source logic: used as model specifications.
4. LUNA backtest data: used to test whether those mechanisms add incremental predictive value.

Never use current TradingView ratings to retroactively label historical bars.
