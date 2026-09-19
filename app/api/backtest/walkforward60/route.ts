import {NextResponse} from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";

const SYMBOLS=[
"ADVANC","AOT","AWC","BANPU","BBL","BCP","BDMS","BEM","BH","BJC","CCET","COM7","CPALL","CPF","CPN","CRC","DELTA","EGCO","GPSC","GULF","HMPRO","IVL","KBANK","KKP","KTB","KTC","LH","MINT","MRDIYT","MTC","OR","OSP","PTT","PTTEP","PTTGC","RATCH","SCB","SCC","SCGP","TCAP","TFG","THAI","TIDLOR","TISCO","TLI","TOP","TRUE","TTB","TU","WHA"
];

const TZ="Asia/Bangkok";
const FEE_BPS=25, SELL_TAX_BPS=10, SLIPPAGE_BPS=5, COST_BPS=FEE_BPS+SELL_TAX_BPS+2*SLIPPAGE_BPS;
const HOLD_BARS=4;
type Bar={ts:number;open:number;high:number;low:number;close:number;volume:number};
type Series={bars:Bar[];ema:Map<number,number[]>;rsi:Map<number,number[]>;atr:Map<number,number[]>;bb:Map<string,{mid:number[];upper:number[]}>;macd:Map<string,{line:number[];signal:number[]}>;stoch:Map<number,{k:number[];d:number[]}>;vwap:Map<number,number[]>;donchian:Map<number,{high:number[];low:number[]}>;orb:Map<number,{high:number[];low:number[]}>};
type Strategy={id:number;family:string;name:string;entry:(i:number,s:Series)=>{ok:boolean;score:number}};
type Trade={strategyId:number;family:string;name:string;symbol:string;ts:number;netBps:number;grossBps:number;fold?:number;split?:string};

function mean(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function sma(a:number[],n:number){const r:number[]=Array(a.length).fill(NaN);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)r[i]=s/n}return r}
function ema(a:number[],n:number){const r:number[]=[],k=2/(n+1);let e=NaN;for(let i=0;i<a.length;i++){e=Number.isFinite(e)?e+(a[i]-e)*k:a[i];r.push(e)}return r}
function stdev(a:number[],n:number){const r:number[]=Array(a.length).fill(NaN);for(let i=n-1;i<a.length;i++){const w=a.slice(i-n+1,i+1),m=mean(w);r[i]=Math.sqrt(mean(w.map(x=>(x-m)*(x-m))))}return r}
function rsi(a:number[],n:number){const r:number[]=Array(a.length).fill(NaN),g:number[]=[],l:number[]=[];for(let i=0;i<a.length;i++){const d=i?a[i]-a[i-1]:0;g.push(Math.max(d,0));l.push(Math.max(-d,0));if(i>=n){const ag=mean(g.slice(i-n+1,i+1)),al=mean(l.slice(i-n+1,i+1));r[i]=al===0?100:100-100/(1+ag/al)}}return r}
function atr(b:Bar[],n:number){const tr=b.map((x,i)=>{const p=i?b[i-1].close:x.close;return Math.max(x.high-x.low,Math.abs(x.high-p),Math.abs(x.low-p))});return sma(tr,n)}
function boll(c:number[],n:number,k:number){const m=sma(c,n),sd=stdev(c,n);return{mid:m,upper:m.map((x,i)=>x+k*sd[i])}}
function macd(c:number[],f:number,s:number,sg:number){const a=ema(c,f),b=ema(c,s),line=c.map((_,i)=>a[i]-b[i]);return{line,signal:ema(line,sg)}}
function stochastic(b:Bar[],n:number,dn:number){const k:number[]=Array(b.length).fill(NaN),d:number[]=Array(b.length).fill(NaN);for(let i=n-1;i<b.length;i++){const w=b.slice(i-n+1,i+1),hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low));k[i]=hi===lo?50:(b[i].close-lo)/(hi-lo)*100}for(let i=dn-1;i<b.length;i++)d[i]=mean(k.slice(i-dn+1,i+1).map(x=>Number.isFinite(x)?x:50));return{k,d}}
function rollingVwap(b:Bar[],n:number){return b.map((_,i)=>{const w=b.slice(Math.max(0,i-n+1),i+1),pv=w.reduce((s,x)=>s+x.close*x.volume,0),v=w.reduce((s,x)=>s+x.volume,0);return v?pv/v:b[i].close})}
function donchian(b:Bar[],n:number){const high:number[]=Array(b.length).fill(NaN),low:number[]=Array(b.length).fill(NaN);for(let i=n;i<b.length;i++){const w=b.slice(i-n,i);high[i]=Math.max(...w.map(x=>x.high));low[i]=Math.min(...w.map(x=>x.low))}return{high,low}}
function day(ts:number){return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts*1000))}
function openingRange(b:Bar[],n:number){const high:number[]=Array(b.length).fill(NaN),low:number[]=Array(b.length).fill(NaN);let d="",hi=-Infinity,lo=Infinity,c=0;for(let i=0;i<b.length;i++){const dd=day(b[i].ts);if(dd!==d){d=dd;hi=-Infinity;lo=Infinity;c=0}if(c<n){hi=Math.max(hi,b[i].high);lo=Math.min(lo,b[i].low);c++}if(c>=n){high[i]=hi;low[i]=lo}}return{high,low}}
function buildSeries(b:Bar[]):Series{
 const c=b.map(x=>x.close),s:Series={bars:b,ema:new Map(),rsi:new Map(),atr:new Map(),bb:new Map(),macd:new Map(),stoch:new Map(),vwap:new Map(),donchian:new Map(),orb:new Map()};
 for(const n of [3,5,7,8,9,10,12,14,16,20,24,30,40,50]){s.ema.set(n,ema(c,n));s.rsi.set(n,rsi(c,n));s.atr.set(n,atr(b,n));s.vwap.set(n,rollingVwap(b,n));s.stoch.set(n,stochastic(b,n,3));s.donchian.set(n,donchian(b,n));s.orb.set(n,openingRange(b,n));}
 for(const [n,k] of [[10,1.5],[10,2],[10,2.5],[14,1.5],[14,2],[14,2.5],[20,1.5],[20,2],[20,2.5],[30,2],[30,2.5]])s.bb.set(`${n}-${k}`,boll(c,n,k));
 for(const [f,l,sg] of [[3,12,3],[3,12,5],[3,20,5],[5,20,3],[5,20,5],[5,30,5],[8,20,3],[8,30,5],[10,30,5],[10,30,9]])s.macd.set(`${f}-${l}-${sg}`,macd(c,f,l,sg));
 return s;
}
function makeStrategies():Strategy[]{
 const out:Strategy[]=[];let id=1;const add=(family:string,name:string,entry:(i:number,s:Series)=>{ok:boolean;score:number})=>out.push({id:id++,family,name,entry});
 const emaPairs=[[3,10],[3,20],[5,12],[5,20],[5,30],[8,20],[8,30],[10,20],[10,30],[12,30]];
 for(const [f,l] of emaPairs)add("EMA",`EMA ${f}/${l}`,(i,s)=>{const a=s.ema.get(f)!,b=s.ema.get(l)!;const m=i>=2?(s.bars[i].close/s.bars[i-2].close-1)*10000:0;return{ok:a[i]>b[i]&&m>=4,score:m+(a[i]/b[i]-1)*10000}});
 for(const n of [5,8,10,12,14,16,20,24,30,40])add("DONCHIAN",`Donchian ${n}`,(i,s)=>{const d=s.donchian.get(n)!;const m=i>=2?(s.bars[i].close/s.bars[i-2].close-1)*10000:0;return{ok:Number.isFinite(d.high[i])&&s.bars[i].close>d.high[i]&&m>0,score:m}});
 for(const n of [1,2,3,4,5,6,8,10,12,15])add("ORB",`ORB ${n}`,(i,s)=>{const o=s.orb.get(n)!;return{ok:Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i],score:((s.bars[i].close/o.high[i])-1)*10000}});
 for(const n of [3,5,8,10,12,14,20,30,40,50])add("VWAP",`VWAP momentum ${n}`,(i,s)=>{const v=s.vwap.get(n)!;const m=i>=2?(s.bars[i].close/s.bars[i-2].close-1)*10000:0;return{ok:s.bars[i].close>v[i]&&m>5,score:m+((s.bars[i].close/v[i])-1)*10000}});
 for(const [n,lo] of [[5,25],[7,25],[9,30],[10,30],[12,28],[14,25],[14,30],[16,28],[20,30],[20,35]])add("RSI-MEANREV",`RSI MR ${n}/${lo}`,(i,s)=>{const r=s.rsi.get(n)!;return{ok:r[i]<lo,score:lo-r[i]}});
 for(const [n,th] of [[5,60],[7,60],[9,60],[10,60],[12,60],[14,55],[14,60],[14,65],[16,60],[20,60]])add("RSI-MOM",`RSI MOM ${n}/${th}`,(i,s)=>{const r=s.rsi.get(n)!;const e=s.ema.get(20)!;return{ok:r[i]>th&&s.bars[i].close>e[i],score:r[i]-th}});
 for(const [n,k] of [[10,1.5],[10,2],[14,1.5],[14,2],[14,2.5],[20,1.5],[20,2],[20,2.5],[30,2],[30,2.5]])add("BB",`BB breakout ${n}/${k}`,(i,s)=>{const z=s.bb.get(`${n}-${k}`)!;return{ok:s.bars[i].close>z.upper[i],score:((s.bars[i].close/z.upper[i])-1)*10000}});
 for(const [f,l,sg] of [[3,12,3],[3,12,5],[3,20,5],[5,20,3],[5,20,5],[5,30,5],[8,20,3],[8,30,5],[10,30,5],[10,30,9]])add("MACD",`MACD ${f}/${l}/${sg}`,(i,s)=>{const m=s.macd.get(`${f}-${l}-${sg}`)!;return{ok:m.line[i]>m.signal[i]&&m.line[i]>0,score:m.line[i]-m.signal[i]}});
 for(const [n,lo] of [[5,20],[5,30],[7,20],[7,30],[9,20],[9,30],[12,20],[12,30],[14,20],[14,30]])add("STOCH",`Stoch ${n}/${lo}`,(i,s)=>{const x=s.stoch.get(n)!;return{ok:x.k[i]<lo&&x.k[i]>x.d[i],score:lo-x.k[i]}});
 for(const [n,m] of [[5,.5],[5,1],[5,1.5],[8,.5],[8,1],[8,1.5],[10,.5],[10,1],[14,.5],[14,1]])add("ATR-BREAK",`ATR breakout ${n}/${m}`,(i,s)=>{const d=s.donchian.get(n)!,a=s.atr.get(n)!;return{ok:Number.isFinite(d.high[i])&&Number.isFinite(a[i])&&s.bars[i].close>d.high[i]+m*a[i],score:Number.isFinite(a[i])?a[i]/s.bars[i].close*10000:0}});
 return out;
}

async function fetchBars(symbol:string,start:number,end:number){
 const url=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.BK?period1=${start}&period2=${end}&interval=15m&includePrePost=false&events=div%2Csplits`;
 const res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},cache:"no-store"});
 if(!res.ok)throw new Error(`Yahoo HTTP ${res.status}`);
 const j=await res.json(),r=j?.chart?.result?.[0];if(!r)throw new Error("Yahoo missing result");
 const q=r.indicators?.quote?.[0]??{};
 return (r.timestamp??[]).map((t:number,i:number)=>({ts:t,open:Number(q.open?.[i]),high:Number(q.high?.[i]),low:Number(q.low?.[i]),close:Number(q.close?.[i]),volume:Number(q.volume?.[i]??0)})).filter((b:Bar)=>[b.open,b.high,b.low,b.close].every(Number.isFinite)&&b.close>0);
}

function sessionsFromData(data:Map<string,Bar[]>){const counts=new Map<string,number>();for(const bars of Array.from(data.values()))for(const b of bars)counts.set(day(b.ts),(counts.get(day(b.ts))??0)+1);return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0])).filter(x=>x[1]>=5).map(x=>x[0])}
function summarize(rows:Trade[]){
 const nets=rows.map(x=>x.netBps),wins=rows.filter(x=>x.netBps>0),losses=rows.filter(x=>x.netBps<0),gp=wins.reduce((s,x)=>s+x.netBps,0),gl=Math.abs(losses.reduce((s,x)=>s+x.netBps,0)),sorted=[...nets].sort((a,b)=>a-b);
 return{signals:rows.length,winRate:+(rows.length?wins.length/rows.length*100:0).toFixed(2),avgNetBps:+mean(nets).toFixed(2),medianNetBps:+(sorted.length?sorted[Math.floor(sorted.length/2)]:0).toFixed(2),profitFactor:+(gl?gp/gl:999).toFixed(2),totalNetBps:+nets.reduce((s,x)=>s+x,0).toFixed(2),p10Bps:+(sorted[Math.max(0,Math.floor(sorted.length*.1)-1)]??0).toFixed(2),p90Bps:+(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.9))]??0).toFixed(2)};
}
function tradesFor(strategy:Strategy,data:Map<string,Bar[]>){
 const out:Trade[]=[];
 for(const [symbol,bars] of Array.from(data.entries())){
  const s=buildSeries(bars);
  for(let i=20;i<bars.length-HOLD_BARS;i++){
   const q=strategy.entry(i,s);if(!q.ok)continue;
   const entry=bars[i+1].open,exit=bars[i+HOLD_BARS].open;if(!Number.isFinite(entry)||!Number.isFinite(exit)||entry<=0||exit<=0)continue;
   const gross=(exit/entry-1)*10000;out.push({strategyId:strategy.id,family:strategy.family,name:strategy.name,symbol,ts:bars[i].ts,grossBps:gross,netBps:gross-COST_BPS});
  }
 }
 return out;
}
function monteCarlo(rows:Trade[],iterations=3000){
 if(!rows.length)return{iterations,probPositive:0,p5FinalBps:0,p50FinalBps:0,p95FinalBps:0,p95MaxDrawdownBps:0};
 const r=rows.map(x=>x.netBps),n=r.length, finals:number[]=[],dds:number[]=[];
 for(let k=0;k<iterations;k++){
  let equity=0,peak=0,maxdd=0;
  for(let i=0;i<n;i++){const v=r[Math.floor(Math.random()*n)];equity+=v;peak=Math.max(peak,equity);maxdd=Math.max(maxdd,peak-equity)}
  finals.push(equity);dds.push(maxdd);
 }
 finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);
 return{iterations,probPositive:+(finals.filter(x=>x>0).length/iterations*100).toFixed(2),p5FinalBps:+finals[Math.floor(iterations*.05)].toFixed(2),p50FinalBps:+finals[Math.floor(iterations*.5)].toFixed(2),p95FinalBps:+finals[Math.floor(iterations*.95)].toFixed(2),p95MaxDrawdownBps:+dds[Math.floor(iterations*.95)].toFixed(2)};
}

export async function GET(req:Request){
 const u=new URL(req.url);
 const batch=Math.max(0,Math.min(4,Number(u.searchParams.get("batch")??"0")));
 const requestedLookbackDays=Math.max(30,Math.min(60,Number(u.searchParams.get("days")??"60")));
 const lookbackDays=Math.min(59,requestedLookbackDays);
 const start=Math.floor((Date.now()-lookbackDays*86400000)/1000),end=Math.floor(Date.now()/1000);
 const selected=SYMBOLS.slice(batch*10,batch*10+10);
 const fetched=await Promise.allSettled(selected.map(s=>fetchBars(s,start,end)));
 const data=new Map<string,Bar[]>();const errors:string[]=[];
 fetched.forEach((x,i)=>x.status==="fulfilled"?data.set(selected[i],x.value):errors.push(selected[i]));
 const strategies=makeStrategies();
 const sessions=sessionsFromData(data);
 const trainSessions=20,testSessions=5,step=5;
 const folds:{fold:number;train:string[];test:string[]}[]=[];
 for(let p=0,f=1;p+trainSessions+testSessions<=sessions.length;p+=step,f++)folds.push({fold:f,train:sessions.slice(p,p+trainSessions),test:sessions.slice(p+trainSessions,p+trainSessions+testSessions)});
 const foldResults:any[]=[];const oosAll:Record<number,Trade[]>={};
 for(const fold of folds){
  const trainStart=fold.train[0],trainEnd=fold.train.at(-1)!,testStart=fold.test[0],testEnd=fold.test.at(-1)!;
  const trainRows=new Map<number,Trade[]>(),testRows=new Map<number,Trade[]>();
  for(const s of strategies){const rows=tradesFor(s,data);trainRows.set(s.id,rows.filter(r=>{const d=day(r.ts);return d>=trainStart&&d<=trainEnd}));testRows.set(s.id,rows.filter(r=>{const d=day(r.ts);return d>=testStart&&d<=testEnd}));}
  const ranking=strategies.map(s=>({s,metric:summarize(trainRows.get(s.id)??[])})).filter(x=>x.metric.signals>=10).sort((a,b)=>b.metric.totalNetBps-a.metric.totalNetBps).slice(0,10);
  const selectedOos=ranking.map(x=>{const rows=testRows.get(x.s.id)??[];const a=summarize(rows);(oosAll[x.s.id]??=[]).push(...rows);return{id:x.s.id,name:x.s.name,family:x.s.family,train:x.metric,oos:a}});
  foldResults.push({fold:fold.fold,train:{start:trainStart,end:trainEnd,sessions:fold.train.length},test:{start:testStart,end:testEnd,sessions:fold.test.length},selected:selectedOos});
 }
 const oosSummary=Object.values(oosAll).map((rows:Trade[])=>({id:rows[0]?.strategyId??0,name:rows[0]?.name??"",family:rows[0]?.family??"",...summarize(rows),monteCarlo:monteCarlo(rows)})).sort((a,b)=>b.totalNetBps-a.totalNetBps);
 return NextResponse.json({
  status:"COMPLETED",mode:"RESEARCH_ONLY",testType:"60D-WALK-FORWARD-100-STRATEGY",
  period:{requestedLookbackDays,effectiveLookbackDays:lookbackDays,sessions:sessions.length,start:sessions[0]??null,end:sessions.at(-1)??null},
  data:{batch,universeSize:SYMBOLS.length,requestedSymbols:selected,symbolsReturned:[...data.keys()],symbolsFailed:errors,bars15m:[...data.values()].reduce((n,a)=>n+a.length,0)},
  rules:{interval:"15m",entry:"completed 15m close -> next 15m open",exit:"4 bars after entry",costBps:COST_BPS,walkForward:"20 train sessions -> 5 OOS sessions, step 5",selection:"top 10 by train total net bps; no OOS peeking",minTrainSignals:10},
  strategiesTested:strategies.length,folds:foldResults.length,foldResults,oosSummary:oosSummary.slice(0,20)
 });
}
