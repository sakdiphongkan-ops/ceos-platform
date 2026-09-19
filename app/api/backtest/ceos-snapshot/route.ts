import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INITIAL = 1_000_000;
const MAX_POSITION_PCT = 0.20;
const MAX_CANDIDATES = 5;
const FEE_BPS = 25;
const SELL_TAX_BPS = 10;
const SLIPPAGE_BPS = 5;
const COST_BPS = FEE_BPS + SELL_TAX_BPS + 2 * SLIPPAGE_BPS;
const STOP_BPS = 50;
const TAKE_BPS = 100;
const HOLD_BARS = 4;
const TZ = "Asia/Bangkok";
const SYMBOLS = ["ADVANC","AOT","CPALL","DELTA","GULF","KBANK","PTT","SCB","TOP","TRUE"];

type Bar = { ts:number; open:number; high:number; low:number; close:number; volume:number };
type Fundamental = Record<string, number>;

function mean(a:number[]) { return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function pct(a:number,b:number) { return b ? (a/b-1)*100 : 0; }
function num(v:any) {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(String(v).replace(/,/g,"").replace(/%/g,""));
  return Number.isFinite(n) ? n : NaN;
}
function scoreHigher(v:number,min:number,max:number) {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0,Math.min(100,(v-min)/(max-min)*100));
}
function scoreLower(v:number,min:number,max:number) {
  if (!Number.isFinite(v)) return 50;
  return 100-scoreHigher(v,min,max);
}
function day(ts:number) {
  return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts*1000));
}
function sma(a:number[],n:number) {
  const r:number[]=[]; let sum=0;
  for(let i=0;i<a.length;i++){sum+=a[i];if(i>=n)sum-=a[i-n];r.push(i+1>=n?sum/n:NaN);}
  return r;
}
function atr(b:Bar[],n:number) {
  const tr:number[]=[];
  for(let i=0;i<b.length;i++){const p=i?b[i-1].close:b[i].close;tr.push(Math.max(b[i].high-b[i].low,Math.abs(b[i].high-p),Math.abs(b[i].low-p)));}
  return sma(tr,n);
}
function rsi(a:number[],n:number) {
  const r:number[]=[];
  for(let i=0;i<a.length;i++){
    if(i<n){r.push(NaN);continue;}
    let g=0,l=0;
    for(let j=i-n+1;j<=i;j++){const d=j?a[j]-a[j-1]:0;g+=Math.max(d,0);l+=Math.max(-d,0);}
    g/=n;l/=n;r.push(l===0?100:100-100/(1+g/l));
  }
  return r;
}
function momentum(a:number[],i:number,n:number) {
  return i>=n && a[i-n]>0 ? (a[i]/a[i-n]-1)*10000 : 0;
}

async function fetchBars(symbol:string,start:number,end:number) {
  const u=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.BK?period1=${start}&period2=${end}&interval=15m&includePrePost=false&events=div%2Csplits`;
  const res=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},cache:"no-store"});
  if(!res.ok) throw new Error(`Yahoo ${res.status}`);
  const j=await res.json(),q=j?.chart?.result?.[0]?.indicators?.quote?.[0]??{};
  return (j?.chart?.result?.[0]?.timestamp??[]).map((t:number,i:number)=>({
    ts:t,open:num(q.open?.[i]),high:num(q.high?.[i]),low:num(q.low?.[i]),close:num(q.close?.[i]),volume:num(q.volume?.[i])
  })).filter((b:Bar)=>[b.open,b.high,b.low,b.close].every(Number.isFinite)&&b.close>0);
}

async function fetchFundamentals() {
  const base="https://www.finnomena.com/market-info/api/public";
  const listRes=await fetch(`${base}/stock/list?exchange=TH`,{headers:{"User-Agent":"Mozilla/5.0"},cache:"no-store"});
  if(!listRes.ok) throw new Error(`Finnomena list ${listRes.status}`);
  const list=await listRes.json();
  const ids=new Map<string,string>((list.data??[]).map((x:any)=>[x.name,x.security_id]));
  const out=new Map<string,any>();
  await Promise.all(SYMBOLS.map(async s=>{
    const id=ids.get(s); if(!id) return;
    const r=await fetch(`${base}/stock/summary/${id}`,{headers:{"User-Agent":"Mozilla/5.0"},cache:"no-store"});
    if(r.ok){const j=await r.json();out.set(s,j?.data??[]);}
  }));
  return out;
}

function buildStaticScores(rows:any[]) {
  const usable=rows.filter(x=>num(x.fiscal)<=2025);
  const pick=usable.sort((a,b)=>num(b.fiscal)-num(a.fiscal)||num(b.quarter)-num(a.quarter))[0];
  if(!pick) return null;
  return {
    quality: mean([
      scoreHigher(num(pick.roe),0,25),
      scoreHigher(num(pick.roa),0,15),
      scoreHigher(num(pick.npm),0,20),
      scoreLower(num(pick.debt_to_equity),0,3)
    ]),
    growth: mean([
      scoreHigher(num(pick.revenue_yoy),-20,30),
      scoreHigher(num(pick.net_profit_yoy),-30,40),
      scoreHigher(num(pick.earning_per_share_yoy),-30,40)
    ]),
    valuation: mean([
      scoreLower(num(pick.price_earning_ratio),5,35),
      scoreLower(num(pick.price_book_value),0.5,5),
      scoreLower(num(pick.ev_per_ebit_da),3,25)
    ]),
    risk: scoreLower(num(pick.debt_to_equity),0,3),
    sourceFiscal: num(pick.fiscal),
    sourceQuarter: num(pick.quarter),
    pe:num(pick.price_earning_ratio),
    pb:num(pick.price_book_value),
    roe:num(pick.roe),
    de:num(pick.debt_to_equity)
  };
}

function ceosAlpha(staticScore:any, bars:Bar[], i:number) {
  const closes=bars.map(x=>x.close);
  const mom=scoreHigher(momentum(closes,i,16),-150,250);
  return staticScore.quality*.35 + staticScore.growth*.25 + staticScore.valuation*.20 + staticScore.risk*.10 + mom*.10;
}

function run(data:Map<string,Bar[]>, scores:Map<string,any>) {
  const positions=new Map<string,{qty:number;avg:number;entry:number}>();
  const pending=new Map<number,{symbol:string;score:number}[]>();
  let cash=INITIAL;
  const trades:any[]=[];
  const allTimes=Array.from(new Set(Array.from(data.values()).flat().map(x=>x.ts))).sort((a,b)=>a-b);
  const idx=new Map<string,Map<number,number>>();
  data.forEach((b,s)=>{
    const m=new Map<number,number>();
    b.forEach((x,i)=>m.set(x.ts,i));
    idx.set(s,m);
  });
  let peak=INITIAL,maxDD=0;
  for(let ti=0;ti<allTimes.length;ti++){
    const ts=allTimes[ti],next=allTimes[ti+1];
    const batch=Array.from(data.entries()).map(([symbol,bars])=>({symbol,bar:bars[idx.get(symbol)!.get(ts)??-1]})).filter(x=>x.bar);
    const curr=new Map(batch.map(x=>[x.symbol,x.bar]));
    for(const o of pending.get(ts)??[]){
      const b=curr.get(o.symbol),p=positions.get(o.symbol); if(!b||!p) continue;
      const fill=b.open*(1-SLIPPAGE_BPS/10000),notional=fill*p.qty,fee=notional*(FEE_BPS+SELL_TAX_BPS)/10000;
      const pnl=(notional-fee)-p.avg*p.qty; cash+=notional-fee;
      trades.push({symbol:o.symbol,exit:b.ts,pnl,reason:"EXIT"});
      positions.delete(o.symbol);
    }
    const buys=(pending.get(ts)??[]).filter(()=>false);
    void buys;
    if(next!==undefined){
      const candidates:Array<{symbol:string;score:number}>=[];
      data.forEach((bars,symbol)=>{
        const i=idx.get(symbol)!.get(ts); if(i===undefined||i<16||positions.has(symbol)) return;
        const sc=scores.get(symbol); if(!sc) return;
        const alpha=ceosAlpha(sc,bars,i);
        if(alpha>=60) candidates.push({symbol,score:alpha});
      });
      candidates.sort((a,b)=>b.score-a.score);
      for(const c of candidates.slice(0,MAX_CANDIDATES)){
        const b=data.get(c.symbol)![idx.get(c.symbol)!.get(ts)!+1]; if(!b) continue;
        const fill=b.open*(1+SLIPPAGE_BPS/10000),maxNotional=INITIAL*MAX_POSITION_PCT;
        const qty=Math.floor(Math.min(maxNotional,cash)/(fill*(1+FEE_BPS/10000)));
        if(qty<=0) continue;
        const notional=fill*qty,fee=notional*FEE_BPS/10000; cash-=notional+fee;
        positions.set(c.symbol,{qty,avg:(notional+fee)/qty,entry:ti});
      }
      for(const [symbol,p] of positions){
        const b=curr.get(symbol); if(!b) continue;
        const stop=p.avg*(1-STOP_BPS/10000),take=p.avg*(1+TAKE_BPS/10000);
        const i=idx.get(symbol)!.get(ts)!;
        if(b.close<=stop||b.close>=take||ti-p.entry>=HOLD_BARS){
          pending.set(next,[...(pending.get(next)??[]),{symbol,score:1e9}]);
        }
      }
    }
    let mv=0;for(const [s,p] of positions)mv+=p.qty*(curr.get(s)?.close??p.avg);
    const eq=cash+mv;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);
  }
  const last=allTimes[allTimes.length-1];
  for(const [s,p] of positions){const b=data.get(s)![data.get(s)!.length-1],fill=b.close*(1-SLIPPAGE_BPS/10000),notional=fill*p.qty,fee=notional*(FEE_BPS+SELL_TAX_BPS)/10000;cash+=notional-fee;trades.push({symbol:s,exit:last,pnl:(notional-fee)-p.avg*p.qty,reason:"END"});}
  const wins=trades.filter(x=>x.pnl>0),losses=trades.filter(x=>x.pnl<0),gp=wins.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(losses.reduce((s,x)=>s+x.pnl,0));
  return {
    finalEquity:Number(cash.toFixed(2)),netPnl:Number((cash-INITIAL).toFixed(2)),
    returnPct:Number(((cash/INITIAL-1)*100).toFixed(4)),maxDrawdown:Number(maxDD.toFixed(2)),
    trades:trades.length,winRate:Number((trades.length?wins.length/trades.length*100:0).toFixed(2)),
    profitFactor:Number((gl?gp/gl:999).toFixed(3)),feesAndSlippageBps:COST_BPS,
    tradesDetail:trades.slice(-100)
  };
}

export async function GET() {
  const end=Math.floor(Date.parse("2026-09-19T00:00:00+07:00")/1000);
  const start=Math.floor(Date.parse("2026-07-22T00:00:00+07:00")/1000);
  const [fund, ...bars] = await Promise.all([
    fetchFundamentals(),
    ...SYMBOLS.map(s=>fetchBars(s,start,end))
  ]);
  const data=new Map<string,Bar[]>();
  bars.forEach((b:any,i)=>data.set(SYMBOLS[i],b));
  const scores=new Map<string,any>();
  for(const [s,rows] of fund) { const x=buildStaticScores(rows); if(x) scores.set(s,x); }
  const result=run(data,scores);
  return NextResponse.json({
    status:"COMPLETED",
    testType:"CEOS-INTRADAY-SNAPSHOT-PROXY",
    warning:"This is not a point-in-time SETSMART backtest. Fundamentals are taken from the latest available fiscal period <= FY2025 through a public Finnomena endpoint, then held static. It is a leakage-controlled proxy relative to using FY2026 Q2 data, but filing-date availability is not modeled.",
    period:{start:"2026-07-22",end:"2026-09-18",sessions:40},
    universe:SYMBOLS,
    data:{bars15m:Array.from(data.values()).reduce((n,a)=>n+a.length,0),fundamentalSymbols:scores.size},
    rules:{initialCapital:INITIAL,maxPositionPct:MAX_POSITION_PCT,maxCandidates:MAX_CANDIDATES,entry:"15m close -> next 15m open",holdBars:HOLD_BARS,stopBps:STOP_BPS,takeBps:TAKE_BPS,costBps:COST_BPS},
    ceosFormula:"Quality 35% + Growth 25% + Valuation 20% + Risk 10% + Momentum 10%",
    source:"Public financial endpoint via thaifin/Finnomena; replaceable by SETSMART API key",
    scores:Object.fromEntries(scores),
    result
  });
}
