export const runtime="nodejs";
export const dynamic="force-dynamic";

const SYMBOLS=[
"ADVANC","AOT","AWC","BANPU","BBL","BCP","BDMS","BEM","BH","BJC","CCET","COM7","CPALL","CPF","CPN","CRC","DELTA","EGCO","GPSC","GULF","HMPRO","IVL","KBANK","KKP","KTB","KTC","LH","MINT","MRDIYT","MTC","OR","OSP","PTT","PTTEP","PTTGC","RATCH","SCB","SCC","SCGP","TCAP","TFG","THAI","TIDLOR","TISCO","TLI","TOP","TRUE","TTB","TU","WHA"
];
const INITIAL=1_000_000, MAX_POSITION_PCT=.20, ENTRY_PCT=.20, MAX_GROSS_PCT=1;
const FEE_BPS=25, SELL_TAX_BPS=10, SLIPPAGE_BPS=5, MAX_CANDIDATES=5, TZ="Asia/Bangkok";
const MAX_HOLD_BARS=4, STOP_BPS=50, TAKE_BPS=100;

type Bar={ts:number;open:number;high:number;low:number;close:number;volume:number};
type Position={qty:number;avg:number;entryIndex:number};
type Trade={ts:string;symbol:string;side:"BUY"|"SELL";qty:number;ref:number;fill:number;fee:number;slippage:number;pnl:number;reason:string};
type Strategy={id:number;family:string;name:string;source:string;p:Record<string,number>;entry:(i:number,s:Series)=>{ok:boolean;score:number};exit:(i:number,s:Series)=>boolean};
type Series={bars:Bar[];ema:Map<number,number[]>;sma:Map<number,number[]>;rsi:Map<number,number[]>;atr:Map<number,number[]>;bb:Map<number,{mid:number[];upper:number[];lower:number[]}>;macd:Map<string,{line:number[];signal:number[]}>;stoch:Map<number,{k:number[];d:number[]}>;vwap:Map<number,number[]>;donchian:Map<number,{high:number[];low:number[]}>;orb:Map<number,{high:number[];low:number[]}>};

function mean(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function sma(a:number[],n:number){const r:number[]=[];let sum=0;for(let i=0;i<a.length;i++){sum+=a[i];if(i>=n)sum-=a[i-n];r.push(i+1>=n?sum/n:NaN)}return r}
function ema(a:number[],n:number){const r:number[]=[],k=2/(n+1);let e=NaN;for(let i=0;i<a.length;i++){e=Number.isFinite(e)?e+(a[i]-e)*k:a[i];r.push(e)}return r}
function stdev(a:number[],n:number){const r:number[]=[];for(let i=0;i<a.length;i++){if(i+1<n){r.push(NaN);continue}const w=a.slice(i-n+1,i+1),m=mean(w);r.push(Math.sqrt(mean(w.map(x=>(x-m)*(x-m)))))}return r}
function rsi(a:number[],n:number){const r:number[]=[],g:number[]=[],l:number[]=[];for(let i=0;i<a.length;i++){const d=i?a[i]-a[i-1]:0;g.push(Math.max(d,0));l.push(Math.max(-d,0));if(i<n){r.push(NaN);continue}const ag=mean(g.slice(i-n+1,i+1)),al=mean(l.slice(i-n+1,i+1));r.push(al===0?100:100-100/(1+ag/al))}return r}
function atr(b:Bar[],n:number){const tr:number[]=[];for(let i=0;i<b.length;i++){const prev=i?b[i-1].close:b[i].close;tr.push(Math.max(b[i].high-b[i].low,Math.abs(b[i].high-prev),Math.abs(b[i].low-prev)))}return sma(tr,n)}
function boll(a:number[],n:number,k:number){const m=sma(a,n),sd=stdev(a,n);return {mid:m,upper:m.map((x,i)=>x+k*sd[i]),lower:m.map((x,i)=>x-k*sd[i])}}
function macd(a:number[],f:number,s:number,sg:number){const fast=ema(a,f),slow=ema(a,s),line=a.map((_,i)=>fast[i]-slow[i]),signal=ema(line,sg);return {line,signal}}
function stochastic(b:Bar[],n:number,dn:number){const k:number[]=[];for(let i=0;i<b.length;i++){if(i+1<n){k.push(NaN);continue}const w=b.slice(i-n+1,i+1),hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low));k.push(hi===lo?50:(b[i].close-lo)/(hi-lo)*100)}return {k,d:sma(k.filter(Number.isFinite),dn)}}
function rollingVwap(b:Bar[],n:number){const r:number[]=[];for(let i=0;i<b.length;i++){const w=b.slice(Math.max(0,i-n+1),i+1),pv=w.reduce((s,x)=>s+x.close*x.volume,0),v=w.reduce((s,x)=>s+x.volume,0);r.push(v?pv/v:b[i].close)}return r}
function donchian(b:Bar[],n:number){const hi:number[]=[],lo:number[]=[];for(let i=0;i<b.length;i++){if(i<n){hi.push(NaN);lo.push(NaN);continue}const w=b.slice(i-n,i);hi.push(Math.max(...w.map(x=>x.high)));lo.push(Math.min(...w.map(x=>x.low)))}return {high:hi,low:lo}}
function openingRange(b:Bar[],n:number){const hi:number[]=Array(b.length).fill(NaN),lo:number[]=Array(b.length).fill(NaN);let cur="",rh=NaN,rl=NaN,count=0;for(let i=0;i<b.length;i++){const d=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(b[i].ts*1000));if(d!==cur){cur=d;count=0;rh=NaN;rl=NaN}if(count<n){rh=Number.isFinite(rh)?Math.max(rh,b[i].high):b[i].high;rl=Number.isFinite(rl)?Math.min(rl,b[i].low):b[i].low;count++}hi[i]=count>=n?rh:NaN;lo[i]=count>=n?rl:NaN}return {high:hi,low:lo}}
export function buildSeries(b:Bar[]):Series{const close=b.map(x=>x.close);const s:Series={bars:b,ema:new Map(),sma:new Map(),rsi:new Map(),atr:new Map(),bb:new Map(),macd:new Map(),stoch:new Map(),vwap:new Map(),donchian:new Map(),orb:new Map()};for(const n of [1,2,3,4,5,6,7,8,9,10,12,14,15,16,20,24,30,40,50]){s.ema.set(n,ema(close,n));s.sma.set(n,sma(close,n));s.rsi.set(n,rsi(close,n));s.atr.set(n,atr(b,n));s.vwap.set(n,rollingVwap(b,n));s.stoch.set(n,stochastic(b,n,3));s.donchian.set(n,donchian(b,n));s.orb.set(n,openingRange(b,n));for(const k of [1.5,2,2.5])s.bb.set(n*10+Math.round(k*10),boll(close,n,k))}for(const f of [3,5,8,10])for(const sl of [12,20,30])for(const sg of [3,5,9])s.macd.set(`${f}-${sl}-${sg}`,macd(close,f,sl,sg));return s}
function day(ts:number){return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts*1000))}
function money(n:number){return Number(n.toFixed(2))}
function crossUp(a:number[],b:number[],i:number){return i>0&&Number.isFinite(a[i])&&Number.isFinite(b[i])&&Number.isFinite(a[i-1])&&Number.isFinite(b[i-1])&&a[i]>b[i]&&a[i-1]<=b[i-1]}
function crossDown(a:number[],b:number[],i:number){return i>0&&Number.isFinite(a[i])&&Number.isFinite(b[i])&&Number.isFinite(a[i-1])&&Number.isFinite(b[i-1])&&a[i]<b[i]&&a[i-1]>=b[i-1]}
function prev(a:number[],i:number,n=1){return a[i-n]}
function momentum(s:Series,i:number,n:number){const c=s.bars.map(x=>x.close);const p=prev(c,i,n);return p?((c[i]/p)-1)*10000:0}

export function makeStrategies():Strategy[]{
 const out:Strategy[]=[];let id=1;
 const add=(family:string,name:string,source:string,p:Record<string,number>,entry:(i:number,s:Series)=>{ok:boolean;score:number},exit:(i:number,s:Series)=>boolean)=>out.push({id:id++,family,name,source,p,entry,exit});
 const emaPairs=[[3,10],[3,20],[5,12],[5,20],[5,30],[8,20],[8,30],[10,20],[10,30],[12,30]];
 for(const [f,l] of emaPairs)add("EMA","EMA cross "+f+"/"+l,"Brock-style moving-average rule",{f,l},(i,s)=>{const a=s.ema.get(f)!,b=s.ema.get(l)!;const m=momentum(s,i,2);return{ok:a[i]>b[i]&&m>=4,score:m+(a[i]/b[i]-1)*10000}},(i,s)=>{const a=s.ema.get(f)!,b=s.ema.get(l)!;return a[i]<b[i]});
 const don=[5,8,10,12,14,16,20,24,30,40];
 for(const n of don)add("DONCHIAN","Donchian breakout "+n,"Turtle/Donchian trend following",{n},(i,s)=>{const d=s.donchian.get(n)!,m=momentum(s,i,2);return{ok:Number.isFinite(d.high[i])&&s.bars[i].close>d.high[i]&&m>0,score:m}},(i,s)=>{const d=s.donchian.get(n)!;return Number.isFinite(d.low[i])&&s.bars[i].close<d.low[i]});
 const orbN=[1,2,3,4,5,6,8,10,12,15];
 for(const n of orbN)add("ORB","Opening range breakout "+n,"Intraday breakout family",{n},(i,s)=>{const o=s.orb.get(n)!;return{ok:Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i],score:((s.bars[i].close/o.high[i])-1)*10000}},(i,s)=>{const o=s.orb.get(n)!;return Number.isFinite(o.low[i])&&s.bars[i].close<o.low[i]});
 const vw=[3,5,8,10,12,14,20,30,40,50];
 for(const n of vw)add("VWAP","Rolling VWAP momentum "+n,"VWAP / price-volume benchmark family",{n},(i,s)=>{const v=s.vwap.get(n)!,m=momentum(s,i,2);return{ok:s.bars[i].close>v[i]&&m>5,score:m+((s.bars[i].close/v[i])-1)*10000}},(i,s)=>s.bars[i].close<s.vwap.get(n)![i]);
 const rsiMean=[[5,25,55],[7,25,55],[9,30,55],[10,30,50],[12,28,50],[14,25,50],[14,30,55],[16,28,55],[20,30,55],[20,35,55]];
 for(const [n,lo,ex] of rsiMean)add("RSI-MEANREV",`RSI mean reversion ${n}/${lo}`,"De Bondt-Thaler overreaction / short-horizon reversal",{n,lo,ex},(i,s)=>{const r=s.rsi.get(n)!;return{ok:r[i]<lo,score:lo-r[i]}},(i,s)=>s.rsi.get(n)![i]>=ex);
 const rsiMom=[[5,60],[7,60],[9,60],[10,60],[12,60],[14,55],[14,60],[14,65],[16,60],[20,60]];
 for(const [n,th] of rsiMom)add("RSI-MOM",`RSI momentum ${n}/${th}`,"Momentum / trend confirmation family",{n,th},(i,s)=>{const r=s.rsi.get(n)!;const e=s.ema.get(20)!;return{ok:r[i]>th&&s.bars[i].close>e[i],score:r[i]-th}},(i,s)=>s.rsi.get(n)![i]<50);
 const bb=[[10,1.5],[10,2],[14,1.5],[14,2],[14,2.5],[20,1.5],[20,2],[20,2.5],[30,2],[30,2.5]];
 for(const [n,k] of bb){const key=n*10+Math.round(k*10);add("BB","Bollinger breakout "+n+"/"+k,"Breakout / volatility expansion family",{n,k},(i,s)=>{const b=s.bb.get(key)!;return{ok:s.bars[i].close>b.upper[i],score:((s.bars[i].close/b.upper[i])-1)*10000}},(i,s)=>{const b=s.bb.get(key)!;return s.bars[i].close<b.mid[i]});}
 const macds=[[3,12,3],[3,12,5],[3,20,5],[5,20,3],[5,20,5],[5,30,5],[8,20,3],[8,30,5],[10,30,5],[10,30,9]];
 for(const [f,l,sg] of macds){const key=`${f}-${l}-${sg}`;add("MACD",`MACD ${key}`,"Moving-average trend/momentum family",{f,l,sg},(i,s)=>{const m=s.macd.get(key)!;return{ok:m.line[i]>m.signal[i]&&m.line[i]>0,score:m.line[i]-m.signal[i]}},(i,s)=>{const m=s.macd.get(key)!;return m.line[i]<m.signal[i]});}
 const st=[[5,20],[5,30],[7,20],[7,30],[9,20],[9,30],[12,20],[12,30],[14,20],[14,30]];
 for(const [n,lo] of st)add("STOCH","Stochastic reversal "+n+"/"+lo,"Classic oscillator mean reversion family",{n,lo},(i,s)=>{const x=s.stoch.get(n)!;return{ok:x.k[i]<lo&&x.k[i]>x.d[i],score:lo-x.k[i]}},(i,s)=>{const x=s.stoch.get(n)!;return x.k[i]>70&&x.k[i]<x.d[i]});
 const atrs=[[5,0.5],[5,1],[5,1.5],[8,0.5],[8,1],[8,1.5],[10,0.5],[10,1],[14,0.5],[14,1]];
 for(const [n,mult] of atrs)add("ATR-BREAK","ATR volatility breakout "+n+"/"+mult,"Volatility breakout / Turtle risk sizing family",{n,mult},(i,s)=>{const d=s.donchian.get(n)!,a=s.atr.get(n)!;return{ok:Number.isFinite(d.high[i])&&Number.isFinite(a[i])&&s.bars[i].close>d.high[i]+mult*a[i],score:Number.isFinite(a[i])?a[i]/s.bars[i].close*10000:0}},(i,s)=>{const d=s.donchian.get(n)!,a=s.atr.get(n)!;return Number.isFinite(a[i])&&s.bars[i].close<d.low[i]});
 return out
}

export async function fetchBars(symbol:string,start:number,end:number){const url=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.BK?period1=${start}&period2=${end}&interval=15m&includePrePost=false&events=div%2Csplits`;const res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},cache:"no-store"});if(!res.ok)throw new Error(`Yahoo HTTP ${res.status}`);const j=await res.json(),r=j?.chart?.result?.[0];if(!r)throw new Error("Yahoo missing result");const q=r.indicators?.quote?.[0]??{};return(r.timestamp??[]).map((t:number,i:number)=>({ts:t,open:Number(q.open?.[i]),high:Number(q.high?.[i]),low:Number(q.low?.[i]),close:Number(q.close?.[i]),volume:Number(q.volume?.[i]??0)})).filter((b:Bar)=>[b.open,b.high,b.low,b.close].every(Number.isFinite)&&b.close>0)}

export function runSignalStudy(strategy:Strategy,data:Map<string,Bar[]>,seriesMap:Map<string,Series>,costBps=2*SLIPPAGE_BPS+FEE_BPS+SELL_TAX_BPS){const rows:{r:number;win:boolean}[]=[];for(const [sym,bars] of Array.from(data.entries())){const s=seriesMap.get(sym)!;for(let i=1;i<bars.length-4;i++){const q=strategy.entry(i,s);if(!q.ok)continue;const entry=bars[i+1].open;if(!Number.isFinite(entry)||entry<=0)continue;const exit=bars[i+4].open;if(!Number.isFinite(exit)||exit<=0)continue;const gross=(exit/entry-1)*10000;const costs=costBps;const net=gross-costs;rows.push({r:net,win:net>0})}}const sorted=rows.map(x=>x.r).sort((a,b)=>a-b);const wins=rows.filter(x=>x.win).length,losses=rows.length-wins,gp=rows.filter(x=>x.r>0).reduce((s,x)=>s+x.r,0),gl=Math.abs(rows.filter(x=>x.r<0).reduce((s,x)=>s+x.r,0));return{signals:rows.length,winRate:money(rows.length?wins/rows.length*100:0),avgNetBps:money(mean(rows.map(x=>x.r))),medianNetBps:money(sorted.length?sorted[Math.floor(sorted.length/2)]:0),profitFactor:money(gl?gp/gl:999),positiveSignals:wins,negativeSignals:losses,totalNetBps:money(rows.reduce((s,x)=>s+x.r,0)),p10Bps:money(sorted[Math.max(0,Math.floor(sorted.length*.1)-1)]??0),p90Bps:money(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.9))]??0)}}


type MarketSnapshot={avgRet2:number;avgRet8:number;breadth2:number;volExpansion:number};
function buildMarketSnapshots(data:Map<string,Bar[]>):Map<number,MarketSnapshot>{
  const byTs=new Map<number,{ret2:number;ret8:number;atr5Pct:number;atr20Pct:number}[]>();
  for(const [sym,bars] of Array.from(data.entries())){
    const s=buildSeries(bars);
    for(let i=20;i<bars.length;i++){
      const c=bars[i].close,p2=bars[i-2]?.close,p8=bars[i-8]?.close;
      const a5=s.atr.get(5)![i],a20=s.atr.get(20)![i];
      if(!Number.isFinite(p2)||!Number.isFinite(p8)||!Number.isFinite(a5)||!Number.isFinite(a20)||!c)continue;
      const row={ret2:(c/p2-1)*10000,ret8:(c/p8-1)*10000,atr5Pct:a5/c,atr20Pct:a20/c};
      const arr=byTs.get(bars[i].ts)??[];arr.push(row);byTs.set(bars[i].ts,arr);
    }
  }
  const out=new Map<number,MarketSnapshot>();
  for(const [ts,rows] of Array.from(byTs.entries())){
    const avgRet2=mean(rows.map(x=>x.ret2)),avgRet8=mean(rows.map(x=>x.ret8));
    const breadth2=rows.length?rows.filter(x=>x.ret2>0).length/rows.length:0.5;
    const atr5=mean(rows.map(x=>x.atr5Pct)),atr20=mean(rows.map(x=>x.atr20Pct));
    out.set(ts,{avgRet2,avgRet8,breadth2,volExpansion:atr20>0?atr5/atr20:1});
  }
  return out;
}
export function runLuna2SignalStudy(data:Map<string,Bar[]>,seriesMap:Map<string,Series>,costBps:number){
  const market=buildMarketSnapshots(data);
  const rows:{r:number;win:boolean;regime:string;symbol:string;ts:number;gross:number}[]=[];
  for(const [sym,bars] of Array.from(data.entries())){
    const s=seriesMap.get(sym)!;
    const priorVols=bars.map(x=>x.volume);
    for(let i=20;i<bars.length-4;i++){
      const ms=market.get(bars[i].ts); if(!ms)continue;
      const c=bars[i].close,p2=bars[i-2]?.close,p8=bars[i-8]?.close;
      const a5=s.atr.get(5)![i],a20=s.atr.get(20)![i],e10=s.ema.get(10)![i],v10=s.vwap.get(10)![i],r5=s.rsi.get(5)![i],d8=s.donchian.get(8)!;
      if(!Number.isFinite(c)||!Number.isFinite(p2)||!Number.isFinite(p8)||![a5,a20,e10,v10,r5,d8.high[i]].every(Number.isFinite))continue;
      const avgVol=mean(priorVols.slice(Math.max(0,i-20),i));
      const volumeRatio=avgVol>0?bars[i].volume/avgVol:1;
      const rel2=(c/p2-1)*10000-ms.avgRet2;
      const ret8=(c/p8-1)*10000;
      const trend=Math.abs(ms.avgRet8)>=35 && ((ms.avgRet8>0&&ms.breadth2>=.60)||(ms.avgRet8<0&&ms.breadth2<=.40));
      const highVol=ms.volExpansion>=1.25;
      const lowVol=ms.volExpansion<=.80;
      const regime=lowVol?"LOW_VOL":highVol?"HIGH_VOL":trend?"TREND":"RANGE";
      const expectedMove=Math.max(a5*4/c*10000,Math.abs(c-v10)/c*10000);
      if(expectedMove<costBps+20 || volumeRatio<1.05 || lowVol)continue;
      let ok=false,score=-Infinity;
      if(trend){
        ok=ms.avgRet8>0 && rel2>=15 && ret8>=20 && c>e10 && c>v10;
        score=rel2+ret8*.35+Math.max(0,volumeRatio-1)*20;
      }else if(highVol){
        ok=c>d8.high[i] && ret8>10 && rel2>0;
        score=(c/d8.high[i]-1)*10000+Math.max(0,ms.volExpansion-1)*60+rel2*.25;
      }else{
        ok=r5<=30 && c>bars[i].open && rel2>-25;
        score=(30-r5)+Math.max(0,rel2)*.25;
      }
      if(!ok)continue;
      const entry=bars[i+1].open,exit=bars[i+4].open;
      if(!Number.isFinite(entry)||!Number.isFinite(exit)||entry<=0||exit<=0)continue;
      const gross=(exit/entry-1)*10000,net=gross-costBps;
      rows.push({r:net,win:net>0,regime,symbol:sym,ts:bars[i].ts,gross});
    }
  }
  const sorted=rows.map(x=>x.r).sort((a,b)=>a-b),wins=rows.filter(x=>x.win).length;
  const gp=rows.filter(x=>x.r>0).reduce((s,x)=>s+x.r,0),gl=Math.abs(rows.filter(x=>x.r<0).reduce((s,x)=>s+x.r,0));
  const byRegime=Object.values(rows.reduce((m,x)=>(m[x.regime]??=[],m[x.regime].push(x),m),{} as Record<string,typeof rows>)).map((x:any[])=>({regime:x[0].regime,signals:x.length,winRate:money(x.filter(y=>y.win).length/x.length*100),avgGrossBps:money(mean(x.map(y=>y.gross))),avgNetBps:money(mean(x.map(y=>y.r))),totalNetBps:money(x.reduce((s,y)=>s+y.r,0))}));
  return {signals:rows.length,winRate:money(rows.length?wins/rows.length*100:0),avgGrossBps:money(mean(rows.map(x=>x.gross))),avgNetBps:money(mean(rows.map(x=>x.r))),medianNetBps:money(sorted.length?sorted[Math.floor(sorted.length/2)]:0),profitFactor:money(gl?gp/gl:999),positiveSignals:wins,negativeSignals:rows.length-wins,totalNetBps:money(rows.reduce((s,x)=>s+x.r,0)),p10Bps:money(sorted[Math.max(0,Math.floor(sorted.length*.1)-1)]??0),p90Bps:money(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.9))]??0),byRegime,signalLog:rows.slice(0,100)};
}
export function costCurve(strategy:Strategy,data:Map<string,Bar[]>,seriesMap:Map<string,Series>,costs:number[]){
  return costs.map(costBps=>{const r=runSignalStudy(strategy,data,seriesMap,costBps);return{costBps,...r}});
}

export function runStrategy(strategy:Strategy,data:Map<string,Bar[]>,seriesMap:Map<string,Series>){const positions=new Map<string,Position>(),trades:Trade[]=[],pending=new Map<number,{symbol:string;side:"BUY"|"SELL";score:number;reason:string}[]>();let cash=INITIAL;const eq:{ts:number;equity:number}[]=[];const allTimes=Array.from(new Set(Array.from(data.values()).flat().map(b=>b.ts))).sort((a,b)=>a-b);const idxMap=new Map<string,Map<number,number>>();for(const [sym,bars] of Array.from(data.entries())){const m=new Map<number,number>();bars.forEach((b,i)=>m.set(b.ts,i));idxMap.set(sym,m)}
 for(let ti=0;ti<allTimes.length;ti++){const ts=allTimes[ti],cur=allTimes[ti+1];const batch=Array.from(data.entries()).map(([symbol,bars])=>({symbol,bar:bars[idxMap.get(symbol)!.get(ts)??-1]})).filter(x=>x.bar);const currBars=new Map(batch.map(x=>[x.symbol,x.bar]));const orders=pending.get(ts)??[];
  for(const o of orders){const b=currBars.get(o.symbol),p=positions.get(o.symbol);if(!b)continue;if(o.side==="SELL"&&p){const fill=b.open*(1-SLIPPAGE_BPS/10000),notional=fill*p.qty,fee=notional*((FEE_BPS+SELL_TAX_BPS)/10000),pnl=(notional-fee)-p.avg*p.qty;cash+=notional-fee;trades.push({ts:new Date(ts*1000).toISOString(),symbol:o.symbol,side:"SELL",qty:p.qty,ref:b.open,fill,fee,slippage:Math.abs(b.open-fill)*p.qty,pnl,reason:o.reason});positions.delete(o.symbol)}}
  const buys=orders.filter(o=>o.side==="BUY").sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));let gross=Array.from(positions.entries()).reduce((s,[sym,p])=>s+p.qty*(currBars.get(sym)?.close??p.avg),0);let chosen=0;
  for(const o of buys){if(chosen>=MAX_CANDIDATES||positions.has(o.symbol))continue;const b=currBars.get(o.symbol);if(!b)continue;const fill=b.open*(1+SLIPPAGE_BPS/10000),maxNotional=INITIAL*MAX_POSITION_PCT,target=INITIAL*ENTRY_PCT,budget=Math.min(maxNotional,target,INITIAL*MAX_GROSS_PCT-gross,cash);const qty=Math.floor(Math.max(0,budget)/(fill*(1+FEE_BPS/10000)));if(qty<=0)continue;const notional=fill*qty,fee=notional*FEE_BPS/10000;if(notional+fee>cash)continue;cash-=notional+fee;positions.set(o.symbol,{qty,avg:(notional+fee)/qty,entryIndex:ti});gross+=notional;trades.push({ts:new Date(ts*1000).toISOString(),symbol:o.symbol,side:"BUY",qty,ref:b.open,fill,fee,slippage:Math.abs(b.open-fill)*qty,pnl:0,reason:o.reason});chosen++}
  if(cur===undefined)break;
  for(const {symbol,bar} of batch){const s=seriesMap.get(symbol)!,i=idxMap.get(symbol)!.get(ts)!;const p=positions.get(symbol);if(p){const stop=p.avg*(1-STOP_BPS/10000),take=p.avg*(1+TAKE_BPS/10000);if(bar.close<=stop)pending.set(cur,[...(pending.get(cur)??[]),{symbol,side:"SELL",score:1e9,reason:"STOP_LOSS"}]);else if(bar.close>=take)pending.set(cur,[...(pending.get(cur)??[]),{symbol,side:"SELL",score:1e9,reason:"TAKE_PROFIT"}]);else if(ti-p.entryIndex>=MAX_HOLD_BARS||strategy.exit(i,s))pending.set(cur,[...(pending.get(cur)??[]),{symbol,side:"SELL",score:1e8,reason:ti-p.entryIndex>=MAX_HOLD_BARS?"MAX_HOLD":"STRATEGY_EXIT"}])}else{const q=strategy.entry(i,s);if(q.ok)pending.set(cur,[...(pending.get(cur)??[]),{symbol,side:"BUY",score:q.score,reason:strategy.name}])}}
  let mv=0;for(const [sym,p] of Array.from(positions.entries()))mv+=p.qty*(currBars.get(sym)?.close??p.avg);eq.push({ts,equity:cash+mv})
 }
 const lastTs=allTimes[allTimes.length-1];const lastBars=new Map(Array.from(data.entries()).map(([sym,bars])=>[sym,bars[bars.length-1]]));for(const [sym,p] of Array.from(positions.entries())){const b=lastBars.get(sym);if(!b)continue;const fill=b.close*(1-SLIPPAGE_BPS/10000),notional=fill*p.qty,fee=notional*((FEE_BPS+SELL_TAX_BPS)/10000),pnl=(notional-fee)-p.avg*p.qty;cash+=notional-fee;trades.push({ts:new Date(lastTs*1000).toISOString(),symbol:sym,side:"SELL",qty:p.qty,ref:b.close,fill,fee,slippage:Math.abs(b.close-fill)*p.qty,pnl,reason:"END_OF_WINDOW"})}
 const wins=trades.filter(t=>t.side==="SELL"&&t.pnl>0),losses=trades.filter(t=>t.side==="SELL"&&t.pnl<0),grossProfit=wins.reduce((s,t)=>s+t.pnl,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));let peak=INITIAL,maxDD=0;for(const x of eq){peak=Math.max(peak,x.equity);maxDD=Math.max(maxDD,peak-x.equity)}
 return {id:strategy.id,family:strategy.family,name:strategy.name,source:strategy.source,finalEquity:money(cash),netPnl:money(cash-INITIAL),returnPct:money((cash/INITIAL-1)*100),maxDrawdown:money(maxDD),closedTrades:wins.length+losses.length,wins:wins.length,losses:losses.length,winRate:money((wins.length+losses.length)?wins.length/(wins.length+losses.length)*100:0),profitFactor:money(grossLoss?grossProfit/grossLoss:999),fees:money(trades.reduce((s,t)=>s+t.fee,0)),slippage:money(trades.reduce((s,t)=>s+t.slippage,0))}}

export {SYMBOLS,INITIAL,FEE_BPS,SELL_TAX_BPS,SLIPPAGE_BPS};
