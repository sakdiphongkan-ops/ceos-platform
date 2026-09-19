import json, math, time
from datetime import datetime, timezone
import requests, pandas as pd

SYMS=["ADVANC","AOT","CPALL","DELTA","GULF","KBANK","PTT","SCB","TOP","TRUE"]
START=int(datetime(2026,7,22,tzinfo=timezone.utc).timestamp())
END=int(datetime(2026,9,19,tzinfo=timezone.utc).timestamp())
INITIAL=1_000_000
COST=45/10000
SL=50/10000
TP=100/10000
HOLD=4
MAXPOS=5
MAXNOT=INITIAL*.20

S=requests.Session()
S.headers.update({"User-Agent":"Mozilla/5.0"})

def yahoo(sym):
    u=f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}.BK?period1={START}&period2={END}&interval=15m&includePrePost=false"
    j=S.get(u,timeout=30).json()["chart"]["result"][0]
    q=j["indicators"]["quote"][0]
    rows=[]
    for i,t in enumerate(j["timestamp"]):
        vals=[q[k][i] for k in ("open","high","low","close")]
        if all(v is not None and math.isfinite(v) for v in vals):
            rows.append((t,*vals))
    return pd.DataFrame(rows,columns=["ts","open","high","low","close"])

def norm(v,lo,hi,inv=False):
    if v is None or not math.isfinite(v): return 50
    x=max(0,min(100,(v-lo)/(hi-lo)*100))
    return 100-x if inv else x

def fundamentals():
    base="https://www.finnomena.com/market-info/api/public"
    r=S.get(base+"/stock/list?exchange=TH",timeout=30); r.raise_for_status()
    arr=r.json().get("data",[])
    ids={x.get("name"):x.get("security_id") for x in arr}
    out={}
    for s in SYMS:
        if s not in ids: continue
        r=S.get(f"{base}/stock/summary/{ids[s]}",timeout=30)
        if not r.ok: continue
        rows=r.json().get("data",[])
        usable=[x for x in rows if str(x.get("fiscal","")).isdigit() and int(x["fiscal"])<=2025]
        if not usable: continue
        usable.sort(key=lambda x:(float(x.get("fiscal") or 0),float(x.get("quarter") or 0)),reverse=True)
        x=usable[0]
        def n(k):
            try:
                return float(str(x.get(k)).replace(",","").replace("%",""))
            except: return float("nan")
        q=sum([norm(n("roe"),0,25),norm(n("roa"),0,15),norm(n("npm"),0,20),norm(n("debt_to_equity"),0,3,True)])/4
        g=sum([norm(n("revenue_yoy"),-20,30),norm(n("net_profit_yoy"),-30,40),norm(n("earning_per_share_yoy"),-30,40)])/3
        v=sum([norm(n("price_earning_ratio"),5,35,True),norm(n("price_book_value"),.5,5,True),norm(n("ev_per_ebit_da"),3,25,True)])/3
        risk=norm(n("debt_to_equity"),0,3,True)
        out[s]={"quality":q,"growth":g,"valuation":v,"risk":risk,"fiscal":x.get("fiscal"),"quarter":x.get("quarter")}
    return out

bars={s:yahoo(s) for s in SYMS}
fund=fundamentals()
scores={}
for s,b in bars.items():
    if s not in fund: continue
    closes=b.close.tolist()
    scores[s]=[]
    for i,p in enumerate(closes):
        mom=((p/closes[i-16]-1)*10000) if i>=16 and closes[i-16] else 0
        ms=norm(mom,-150,250)
        f=fund[s]
        scores[s].append(f["quality"]*.35+f["growth"]*.25+f["valuation"]*.20+f["risk"]*.10+ms*.10)

# merge timestamps; trade at next bar open, exits at next bar open after close-trigger.
allts=sorted(set(t for b in bars.values() for t in b.ts))
idx={s:{int(t):i for i,t in enumerate(b.ts)} for s,b in bars.items()}
cash=INITIAL
pos={}
pending={}
trades=[]
peak=INITIAL
maxdd=0

for ti,ts in enumerate(allts[:-1]):
    # execute scheduled exits at this bar open
    for s in list(pending.get(ts,[])):
        if s not in pos: continue
        i=idx[s].get(ts); b=bars[s].iloc[i]
        p=pos.pop(s)
        fill=float(b.open)*(1-0.0005)
        gross=fill*p["qty"]; fees=gross*.0035
        pnl=(gross-fees)-p["cost"]
        cash+=gross-fees
        trades.append({"symbol":s,"pnl":pnl})
    # mark exits based on completed close
    for s,p in list(pos.items()):
        i=idx[s].get(ts)
        if i is None: continue
        close=float(bars[s].iloc[i].close)
        p["bars"]+=1
        if close<=p["avg"]*(1-SL) or close>=p["avg"]*(1+TP) or p["bars"]>=HOLD:
            nxt=int(bars[s].iloc[i+1].ts) if i+1<len(bars[s]) else None
            if nxt is not None: pending.setdefault(nxt,[]).append(s)
    # rank candidates and enter at next open, max 5 total
    candidates=[]
    for s,b in bars.items():
        i=idx[s].get(ts)
        if i is None or i<16 or i+1>=len(b) or s in pos or s not in scores: continue
        a=scores[s][i]
        if a>=60: candidates.append((a,s))
    candidates.sort(reverse=True)
    for a,s in candidates:
        if len(pos)>=MAXPOS: break
        b=bars[s]; i=idx[s][ts]; nxt=b.iloc[i+1]
        fill=float(nxt.open)*(1+0.0005)
        qty=math.floor(min(MAXNOT,cash)/(fill*1.0025))
        if qty<=0: continue
        notional=fill*qty; fee=notional*.0025
        cash-=notional+fee
        pos[s]={"qty":qty,"avg":(notional+fee)/qty,"cost":notional+fee,"bars":0}
    mv=sum(p["qty"]*float(bars[s].iloc[idx[s][ts]].close) for s,p in pos.items() if ts in idx[s])
    eq=cash+mv
    peak=max(peak,eq); maxdd=max(maxdd,peak-eq)

# liquidate
lastts=allts[-1]
for s,p in list(pos.items()):
    b=bars[s].iloc[-1]
    fill=float(b.close)*(1-0.0005); gross=fill*p["qty"]; fees=gross*.0035
    cash+=gross-fees
    trades.append({"symbol":s,"pnl":(gross-fees)-p["cost"]})

wins=[x for x in trades if x["pnl"]>0]
loss=[x for x in trades if x["pnl"]<0]
gp=sum(x["pnl"] for x in wins); gl=abs(sum(x["pnl"] for x in loss))
result={
 "status":"COMPLETED",
 "period":{"start":"2026-07-22","end":"2026-09-18","sessions":40},
 "universe":SYMS,
 "fundamental_symbols":len(fund),
 "bars":sum(len(b) for b in bars.values()),
 "formula":"Quality 35% + Growth 25% + Valuation 20% + Risk 10% + Momentum 10%",
 "initial_capital":INITIAL,
 "final_equity":round(cash,2),
 "net_pnl":round(cash-INITIAL,2),
 "return_pct":round((cash/INITIAL-1)*100,4),
 "max_drawdown":round(maxdd,2),
 "trades":len(trades),
 "win_rate_pct":round(len(wins)/len(trades)*100,2) if trades else 0,
 "profit_factor":round(gp/gl,3) if gl else 999,
 "warning":"Snapshot proxy: fundamentals latest fiscal <= FY2025, not point-in-time filing availability."
}
print(json.dumps(result,ensure_ascii=False,indent=2))
