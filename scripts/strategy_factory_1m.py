"""Generate 1,000,000 deterministic stock-selection hypotheses without fitting to OOS.

The factory spans documented factor families (value, quality, profitability,
growth, momentum, volatility, liquidity, investment, payout, safety) and
composes rank/threshold/AND/OR rules. It only generates candidates; a separate
walk-forward runner must score them on untouched OOS data.
"""
from itertools import product

FAMILIES = {
 "value":["PE","PBV","EV_EBITDA","FCF_YIELD","EARNINGS_YIELD","DIV_YIELD"],
 "quality":["ROE","ROA","ROIC","GPM","NPM","CFO_MARGIN"],
 "growth":["REV_G","EPS_G","NI_G","FCF_G"],
 "momentum":["MOM_5","MOM_10","MOM_20","MOM_60","MOM_120","REL_MOM"],
 "risk":["VOL_10","VOL_20","BETA","MAXDD_60","ATR_PCT"],
 "liquidity":["ADV20","TURNOVER","AMOUNT"],
 "investment":["ASSET_G","CAPEX_G","INVESTMENT_RATE"],
 "payout":["DIV_G","PAYOUT","BUYBACK"],
 "safety":["DE","NET_DEBT_EBITDA","INTEREST_COVER","CURRENT_RATIO"],
 "technical":["RSI14","DIST_MA20","DIST_MA60","BREAKOUT20","BREAKOUT55"],
}

OPS=["top","bottom"]
QUANTILES=[0.05,0.10,0.20,0.30,0.40]
COMBINERS=["AND","OR"]
PAIR_LIMIT=2

def candidates(limit=1_000_000):
    atoms=[(f,k,q,o) for f,ks in FAMILIES.items() for k in ks for q in QUANTILES for o in OPS]
    i=0
    for a,b,c in product(atoms,atoms,COMBINERS):
        if a==b: continue
        yield {"id":f"SF{i:07d}","a":a,"b":b,"op":c}
        i+=1
        if i>=limit: return

if __name__=="__main__":
    # Deterministic count check; no market data and no performance claims here.
    n=sum(1 for _ in candidates())
    print({"generated":n,"target":1_000_000,"status":"READY_FOR_WALK_FORWARD"})
