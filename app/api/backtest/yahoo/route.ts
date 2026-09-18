import {NextResponse} from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";

const SYMBOLS=[
"ADVANC","AOT","AWC","BANPU","BBL","BCP","BDMS","BEM","BH","BJC","CCET","COM7","CPALL","CPF","CPN","CRC","DELTA","EGCO","GPSC","GULF","HMPRO","IVL","KBANK","KKP","KTB","KTC","LH","MINT","MRDIYT","MTC","OR","OSP","PTT","PTTEP","PTTGC","RATCH","SCB","SCC","SCGP","TCAP","TFG","THAI","TIDLOR","TISCO","TLI","TOP","TRUE","TTB","TU","WHA"
];

const INITIAL=1_000_000;
const MAX_POSITION_PCT=0.20;
const ENTRY_PCT=0.20;
const MAX_GROSS_PCT=1.00;
const FEE_BPS=25;
const SELL_TAX_BPS=10;
const SLIPPAGE_BPS=5;
const FAST=5, SLOW=20;
const MIN_MOMENTUM_BPS=8;
const MAX_HOLD_BARS=4;
const STOP_BPS=50;
const TAKE_BPS=100;
const MAX_CANDIDATES=5;
const TZ="Asia/Bangkok";

type Bar={ts:number;open:number;high:number;low:number;close:number;volume:number};
type Position={qty:number;avg:number;entryIndex:number};
type Trade={ts:string;symbol:string;side:"BUY"|"SELL";qty:number;ref:number;fill:number;fee:number;slippage:number;pnl:number;reason:string};

function ema(prev:number|null,v:number,p:number){if(prev===null)return v;const k=2/(p+1);return prev+(v-prev)*k;}
function day(ts:number){return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts*1000));}
function money(n:number){return Number(n.toFixed(2));}
function maxDrawdown(eq:{ts:number;equity:number}[]){let peak=-Infinity,max=0;for(const p of eq){peak=Math.max(peak,p.equity);max=Math.max(max,peak-p.equity);}return max;}
async function fetchBars(symbol:string,start:number,end:number){
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.BK?period1=${start}&period2=${end}&interval=15m&includePrePost=false&events=div%2Csplits`;
  const res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},cache:"no-store"});
  if(!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j=await res.json();
  const r=j?.chart?.result?.[0]; if(!r) throw new Error("Yahoo missing result");
  const q=r.indicators?.quote?.[0]??{};
  return (r.timestamp??[]).map((t:number,i:number)=>({
    ts:t,open:Number(q.open?.[i]),high:Number(q.high?.[i]),low:Number(q.low?.[i]),close:Number(q.close?.[i]),volume:Number(q.volume?.[i]??0)
  })).filter((b:Bar)=>[b.open,b.high,b.low,b.close].every(Number.isFinite)&&b.close>0);
}

function runProxy(data:Map<string,Bar[]>){
  const positions=new Map<string,Position>();
  const priceStates=new Map<string,{ef:number|null;es:number|null;prevClose:number|null;lastDecision:number}>();
  const trades:Trade[]=[];
  let cash=INITIAL;
  const eq:{ts:number;equity:number}[]=[];
  const sessions=new Set<string>();
  const all=new Map<number,{symbol:string;bar:Bar}[]>();

  for(const [symbol,bars] of Array.from(data.entries())){
    for(const b of bars){sessions.add(day(b.ts));const a=all.get(b.ts)??[];a.push({symbol,bar:b});all.set(b.ts,a);}
  }
  const times=Array.from(all.keys()).sort((a,b)=>a-b);

  function markValue(){
    let mv=0;
    for(const [s,p] of Array.from(positions.entries())){const last=data.get(s)?.find(b=>b.ts===currentTs)?.close??p.avg;mv+=p.qty*last;}
    return mv;
  }
  let currentTs=times[0]??0;
  let currentBars=new Map<string,Bar>();

  for(let i=0;i<times.length;i++){
    currentTs=times[i];
    const batch=all.get(currentTs)??[];
    currentBars=new Map(batch.map(x=>[x.symbol,x.bar]));

    // Signals are computed from the completed bar and executed only at next bar OPEN.
    const nextTs=times[i+1];
    if(nextTs===undefined) break;
    const nextBatch=all.get(nextTs)??[];
    const nextBars=new Map(nextBatch.map(x=>[x.symbol,x.bar]));
    const buys:{symbol:string;score:number;reason:string}[]=[];
    const sells:{symbol:string;reason:string}[]=[];

    for(const {symbol,bar} of batch){
      const st=priceStates.get(symbol)??{ef:null,es:null,prevClose:null,lastDecision:-Infinity};
      st.ef=ema(st.ef,bar.close,FAST);
      st.es=ema(st.es,bar.close,SLOW);
      const momentum=st.prevClose?((bar.close/st.prevClose)-1)*10000:0;
      const pos=positions.get(symbol);
      if(pos){
        const stop=pos.avg*(1-STOP_BPS/10000), take=pos.avg*(1+TAKE_BPS/10000);
        if(bar.close<=stop) sells.push({symbol,reason:"STOP_LOSS"});
        else if(bar.close>=take) sells.push({symbol,reason:"TAKE_PROFIT"});
        else if(st.ef!==null&&st.es!==null&&st.ef<st.es) sells.push({symbol,reason:"EMA_TREND_BREAK"});
        else if(i-(pos.entryIndex)>=MAX_HOLD_BARS) sells.push({symbol,reason:"MAX_HOLD_BARS"});
      }else if(st.ef!==null&&st.es!==null&&st.ef>st.es&&momentum>=MIN_MOMENTUM_BPS){
        buys.push({symbol,score:momentum,reason:`EMA_UP momentum=${momentum.toFixed(2)}bps`});
      }
      st.prevClose=bar.close;
      priceStates.set(symbol,st);
    }

    for(const {symbol,reason} of sells){
      const nb=nextBars.get(symbol); const p=positions.get(symbol);
      if(!nb||!p) continue;
      const ref=nb.open, fill=ref*(1-SLIPPAGE_BPS/10000);
      const notional=fill*p.qty, fee=notional*((FEE_BPS+SELL_TAX_BPS)/10000);
      const pnl=(notional-fee)-p.avg*p.qty;
      cash+=notional-fee;
      trades.push({ts:new Date(nextTs*1000).toISOString(),symbol,side:"SELL",qty:p.qty,ref,fill,fee,slippage:Math.abs(ref-fill)*p.qty,pnl,reason});
      positions.delete(symbol);
    }

    buys.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
    let chosen=0;
    let gross=Array.from(positions.entries()).reduce((s,[symbol,p])=>s+p.qty*(currentBars.get(symbol)?.close??p.avg),0);
    for(const {symbol,reason} of buys){
      if(chosen>=MAX_CANDIDATES) break;
      const nb=nextBars.get(symbol); if(!nb) continue;
      const ref=nb.open, fill=ref*(1+SLIPPAGE_BPS/10000);
      const currentPrice=currentBars.get(symbol)?.close??ref;
      const currentNotional=(positions.get(symbol)?.qty??0)*currentPrice;
      const maxNotional=INITIAL*MAX_POSITION_PCT;
      const remaining=Math.max(0,maxNotional-currentNotional);
      const target=INITIAL*ENTRY_PCT;
      const budget=Math.min(remaining,target,INITIAL*MAX_GROSS_PCT-gross);
      const feeRate=FEE_BPS/10000;
      const qty=Math.floor(Math.max(0,Math.min(budget, cash/(1+SLIPPAGE_BPS/10000)/(fill*(1+feeRate))))/ref);
      if(qty<=0) continue;
      const notional=fill*qty, fee=notional*feeRate;
      if(notional+fee>cash) continue;
      cash-=notional+fee;
      positions.set(symbol,{qty,avg:(notional+fee)/qty,entryIndex:i+1});
      gross+=notional;
      trades.push({ts:new Date(nextTs*1000).toISOString(),symbol,side:"BUY",qty,ref,fill,fee,slippage:Math.abs(fill-ref)*qty,pnl:0,reason});
      chosen++;
    }

    let mv=0;
    for(const [s,p] of Array.from(positions.entries())) mv+=p.qty*(nextBars.get(s)?.open??p.avg);
    eq.push({ts:nextTs,equity:cash+mv});
  }

  // Force close at the final available bar using that bar's close.
  const finalTs=times.at(-1)??0;
  const finalBars=new Map((all.get(finalTs)??[]).map(x=>[x.symbol,x.bar]));
  for(const [symbol,p] of Array.from(positions.entries())){
    const b=finalBars.get(symbol); if(!b) continue;
    const ref=b.close, fill=ref*(1-SLIPPAGE_BPS/10000), notional=fill*p.qty, fee=notional*((FEE_BPS+SELL_TAX_BPS)/10000);
    const pnl=(notional-fee)-p.avg*p.qty; cash+=notional-fee;
    trades.push({ts:new Date(finalTs*1000).toISOString(),symbol,side:"SELL",qty:p.qty,ref,fill,fee,slippage:Math.abs(ref-fill)*p.qty,pnl,reason:"END_OF_WINDOW"});
    positions.delete(symbol);
  }

  const finalEquity=cash;
  const byDay=new Map<string,number>();
  for(const t of trades){const d=day(Date.parse(t.ts)/1000);byDay.set(d,(byDay.get(d)??0)+(t.side==="SELL"?t.pnl:0)-(t.side==="BUY"?t.fee:0));}
  const wins=trades.filter(t=>t.side==="SELL"&&t.pnl>0).length;
  const losses=trades.filter(t=>t.side==="SELL"&&t.pnl<0).length;
  return {
    initialCapital:INITIAL,finalEquity:money(finalEquity),netPnl:money(finalEquity-INITIAL),
    returnPct:money((finalEquity/INITIAL-1)*100),maxDrawdown:money(maxDrawdown(eq)),
    trades:trades.length,closedTrades:wins+losses,wins,losses,winRate:money((wins+losses)?wins/(wins+losses)*100:0),
    fees:money(trades.reduce((s,t)=>s+t.fee,0)),slippage:money(trades.reduce((s,t)=>s+t.slippage,0)),
    dailyPnl:Array.from(byDay.entries()).map(([date,pnl])=>({date,pnl:money(pnl)})),
    tradeLog:trades.map(t=>({...t,pnl:money(t.pnl),fee:money(t.fee),slippage:money(t.slippage),ref:money(t.ref),fill:money(t.fill)}))
  };
}

export async function GET(){
  const end=Math.floor(Date.parse("2026-09-19T00:00:00+07:00")/1000);
  const start=Math.floor(Date.parse("2026-09-09T17:00:00Z")/1000);
  const results=await Promise.allSettled(SYMBOLS.map(s=>fetchBars(s,start,end)));
  const data=new Map<string,Bar[]>();
  const errors:{symbol:string;error:string}[]=[];
  results.forEach((r,i)=>{if(r.status==="fulfilled")data.set(SYMBOLS[i],r.value);else errors.push({symbol:SYMBOLS[i],error:String(r.reason)})});
  const bars=Array.from(data.values()).reduce((n,a)=>n+a.length,0);
  const sessions=new Set(Array.from(data.values()).flat().map(b=>day(b.ts)));
  const backtest=runProxy(data);
  return NextResponse.json({
    status:"COMPLETED",
    mode:"RESEARCH_ONLY",
    testType:"LUNA-15M-PRICE-ONLY-PROXY",
    exactLunaStatus:"NOT_EXACT_LUNA: historical Yahoo data has OHLCV but not historical SET bid/ask sizes/order-book imbalance.",
    period:{start:"2026-09-10",end:"2026-09-18",tradingSessions:Array.from(sessions).sort()},
    universe:{name:"SET50 H2 2026 proxy",symbols:SYMBOLS,count:SYMBOLS.length},
    data:{symbolsReturned:data.size,symbolsFailed:errors.length,bars15m:bars,errors},
    strategy:{
      timeframe:"15m",emaFast:FAST,emaSlow:SLOW,minMomentumBps:MIN_MOMENTUM_BPS,
      maxHoldBars:MAX_HOLD_BARS,stopLossBps:STOP_BPS,takeProfitBps:TAKE_BPS,
      maxPositionPct:MAX_POSITION_PCT,entryPct:ENTRY_PCT,maxGrossPct:MAX_GROSS_PCT,
      feesBps:FEE_BPS,sellTaxBps:SELL_TAX_BPS,slippageBps:SLIPPAGE_BPS,
      maxCandidatesPerTimestamp:MAX_CANDIDATES,
      execution:"signal on completed 15m close -> next 15m bar open; no look-ahead"
    },
    result:backtest
  });
}
