import {NextResponse} from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";

const SYMBOLS=["ADVANC","AOT","CPALL","DELTA","GULF","KBANK","PTT","SCB","TOP","TRUE"];
const TZ="Asia/Bangkok", COST_BPS=45, LOOKBACK_DAYS=59;

type Bar={ts:number;open:number;high:number;low:number;close:number;volume:number};
type Series={bars:Bar[];ema:Map<number,number[]>;rsi:Map<number,number[]>;atr:Map<number,number[]>;bb:Map<string,{mid:number[];upper:number[];width:number[]}>;don:Map<number,{high:number[];low:number[]}>;vwap:number[];orb:Map<number,{high:number[];low:number[]}>;volRatio:number[]};
type Strategy={id:number;tf:number;family:string;name:string;entry:(i:number,s:Series,ctx:Ctx)=>{ok:boolean;score:number}};
type Trade={strategyId:number;tf:number;family:string;name:string;symbol:string;ts:number;netBps:number;grossBps:number};
type Ctx={market:Map<number,{ret5:number;ret12:number;breadth:number}>;higher:Map<string,Series>;symbol:string};

function mean(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function sma(a:number[],n:number){const r:number[]=Array(a.length).fill(NaN);let sum=0;for(let i=0;i<a.length;i++){sum+=a[i];if(i>=n)sum-=a[i-n];if(i>=n-1)r[i]=sum/n}return r}
function ema(a:number[],n:number){const r:number[]=[];const k=2/(n+1);let e=NaN;for(let i=0;i<a.length;i++){e=Number.isFinite(e)?e+(a[i]-e)*k:a[i];r.push(e)}return r}
function rsi(a:number[],n:number){const r:number[]=Array(a.length).fill(NaN);for(let i=n;i<a.length;i++){let g=0,l=0;for(let j=i-n+1;j<=i;j++){const d=a[j]-a[j-1];g+=Math.max(d,0);l+=Math.max(-d,0)}const ag=g/n,al=l/n;r[i]=al===0?100:100-100/(1+ag/al)}return r}
function atr(b:Bar[],n:number){const tr=b.map((x,i)=>{const p=i?b[i-1].close:x.close;return Math.max(x.high-x.low,Math.abs(x.high-p),Math.abs(x.low-p))});return sma(tr,n)}
function boll(c:number[],n:number,k:number){const mid=sma(c,n),upper:number[]=Array(c.length).fill(NaN),width:number[]=Array(c.length).fill(NaN);for(let i=n-1;i<c.length;i++){let ss=0;for(let j=i-n+1;j<=i;j++)ss+=(c[j]-mid[i])**2;const sd=Math.sqrt(ss/n);upper[i]=mid[i]+k*sd;width[i]=mid[i]?((2*k*sd)/mid[i])*10000:NaN}return{mid,upper,width}}
function donchian(b:Bar[],n:number){const high:number[]=Array(b.length).fill(NaN),low:number[]=Array(b.length).fill(NaN);for(let i=n;i<b.length;i++){let hi=-Infinity,lo=Infinity;for(let j=i-n;j<i;j++){hi=Math.max(hi,b[j].high);lo=Math.min(lo,b[j].low)}high[i]=hi;low[i]=lo}return{high,low}}
function local(ts:number){const p=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(ts*1000));const o:any={};for(const z of p)o[z.type]=z.value;return{day:o.year+"-"+o.month+"-"+o.day,hm:Number(o.hour)*60+Number(o.minute)}}
function morning(hm:number){return hm>=600&&hm<750}
function afternoon(hm:number){return hm>=870&&hm<990}
function sessionKey(ts:number){const x=local(ts);return x.day+"-"+(x.hm<750?1:2)}
function resample(bars:Bar[],tf:number){const groups=new Map<string,Bar[]>();for(const b of bars){const x=local(b.ts);if(!(morning(x.hm)||afternoon(x.hm)))continue;const base=x.hm<750?600:870;const bucket=base+Math.floor((x.hm-base)/(tf*60))*tf*60;const key=x.day+"-"+bucket;const a=groups.get(key)||[];a.push(b);groups.set(key,a)}const out:Bar[]=[];for(const a of Array.from(groups.values()).sort((x,y)=>x[0].ts-y[0].ts)){a.sort((x,y)=>x.ts-y.ts);out.push({ts:a[a.length-1].ts,open:a[0].open,high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low)),close:a[a.length-1].close,volume:a.reduce((s,x)=>s+x.volume,0)})}return out}
function openingRange(b:Bar[],n:number){const hi:number[]=Array(b.length).fill(NaN),lo:number[]=Array(b.length).fill(NaN);let d="",rh=-Infinity,rl=Infinity,count=0;for(let i=0;i<b.length;i++){const x=local(b[i].ts);if(x.day!==d){d=x.day;rh=-Infinity;rl=Infinity;count=0}if(morning(x.hm)&&count<n){rh=Math.max(rh,b[i].high);rl=Math.min(rl,b[i].low);count++}hi[i]=morning(x.hm)&&count>=n?rh:NaN;lo[i]=morning(x.hm)&&count>=n?rl:NaN}return{high:hi,low:lo}}
function sessionVwap(b:Bar[]){const out:number[]=Array(b.length).fill(NaN);let key="",pv=0,v=0;for(let i=0;i<b.length;i++){const k=sessionKey(b[i].ts);if(k!==key){key=k;pv=0;v=0}pv+=b[i].close*b[i].volume;v+=b[i].volume;out[i]=v?pv/v:b[i].close}return out}
function volRatio(b:Bar[],n=20){return b.map((x,i)=>{if(i<n)return NaN;const av=mean(b.slice(i-n,i).map(z=>z.volume));return av?x.volume/av:1})}
function bwPct(w:number[],n=40){const out:number[]=Array(w.length).fill(NaN);for(let i=n;i<w.length;i++){const h=w.slice(i-n,i).filter(Number.isFinite);out[i]=h.length?h.filter(x=>x<=w[i]).length/h.length:NaN}return out}
function buildSeries(b:Bar[]):Series{const c=b.map(x=>x.close);const s:Series={bars:b,ema:new Map(),rsi:new Map(),atr:new Map(),bb:new Map(),don:new Map(),vwap:sessionVwap(b),orb:new Map(),volRatio:volRatio(b)};for(const n of [5,8,13,20,21,34,50]){s.ema.set(n,ema(c,n));s.rsi.set(n,rsi(c,n));s.atr.set(n,atr(b,n));s.don.set(n,donchian(b,n))}for(const [n,k] of [[10,1.5],[14,2],[20,2],[20,2.5]])s.bb.set(n+"-"+k,boll(c,n,k));for(const n of [1,2,3,4,6,12])s.orb.set(n,openingRange(b,n));return s}
function momentum(s:Series,i:number,n:number){const p=s.bars[i-n]?.close;return p?((s.bars[i].close/p)-1)*10000:0}
function marketContext(data:Map<string,Bar[]>){const byTs=new Map<number,{r5:number;r12:number;up:boolean}[]>();for(const bars of Array.from(data.values()))for(let i=12;i<bars.length;i++){const a=byTs.get(bars[i].ts)||[];a.push({r5:(bars[i].close/bars[i-5].close-1)*10000,r12:(bars[i].close/bars[i-12].close-1)*10000,up:bars[i].close>bars[i-5].close});byTs.set(bars[i].ts,a)}const out=new Map<number,{ret5:number;ret12:number;breadth:number}>();for(const [ts,a] of Array.from(byTs.entries()))out.set(ts,{ret5:mean(a.map(x=>x.r5)),ret12:mean(a.map(x=>x.r12)),breadth:a.length? a.filter(x=>x.up).length/a.length:.5});return out}

function higherIndex(s:Series,ts:number){let l=0,r=s.bars.length-1,b=-1;while(l<=r){const m=(l+r)>>1;if(s.bars[m].ts<=ts){b=m;l=m+1}else r=m-1}return b}

function makeStrategies(tf:number):Strategy[]{const out:Strategy[]=[];let id=1;const add=(family:string,name:string,entry:(i:number,s:Series,ctx:Ctx)=>{ok:boolean;score:number})=>out.push({id:id++,tf,family,name,entry});
const windows=tf===5?[1,2,3,6,12]:tf===15?[1,2,3,4]:[1,2];
for(const n of windows)add("ORB","ORB "+n+"bar/"+(n*tf)+"m",(i,s)=>{const o=s.orb.get(n)!;return{ok:Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i],score:(s.bars[i].close/o.high[i]-1)*10000}});
for(const n of windows)for(const rv of [1.2,1.5])add("ORB+RVOL","ORB "+n*tf+"m + RVOL "+rv,(i,s)=>{const o=s.orb.get(n)!;return{ok:Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&s.volRatio[i]>=rv,score:(s.bars[i].close/o.high[i]-1)*10000+s.volRatio[i]*10}});
for(const n of windows)for(const th of [0,10,25])add("ORB+RS","ORB "+n*tf+"m + relative strength "+th,(i,s,ctx)=>{const o=s.orb.get(n)!,m=ctx.market.get(s.bars[i].ts);const hn=Math.max(1,Math.round(30/tf));const rel=momentum(s,i,hn)-(m?m.ret5:0);return{ok:Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&rel>=th,score:rel}});
for(const n of windows)for(const pct of [.2,.4])add("ORB+SQUEEZE","ORB "+n*tf+"m + squeeze "+pct,(i,s)=>{const o=s.orb.get(n)!,bb=s.bb.get("20-2")!,p=bwPct(bb.width)[i];return{ok:Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&p<=pct,score:(s.bars[i].close/o.high[i]-1)*10000+(pct-p)*50}});
for(const n of windows.filter(x=>x<=6))add("ORB+RETEST","ORB "+n*tf+"m retest",(i,s)=>{const o=s.orb.get(n)!;if(i<1)return{ok:false,score:0};const br=Number.isFinite(o.high[i-1])&&s.bars[i-1].close>o.high[i-1];const rt=Number.isFinite(o.high[i])&&s.bars[i].low<=o.high[i]*1.001&&s.bars[i].close>o.high[i];return{ok:br&&rt,score:rt?(s.bars[i].close/o.high[i]-1)*10000:0}});
for(const slope of [0,5,15])for(const n of windows)add("ORB+MTF","ORB "+n*tf+"m + HTF slope "+slope,(i,s,ctx)=>{const o=s.orb.get(n)!,h=ctx.higher.get(ctx.symbol);if(!h)return{ok:false,score:0};const j=higherIndex(h,s.bars[i].ts);if(j<21)return{ok:false,score:0};const a=h.ema.get(13)!,b=h.ema.get(34)!;const sc=(a[j]/b[j]-1)*10000;return{ok:Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&sc>=slope,score:sc}});
for(const fast of [5,8])add("EMA-PULLBACK","EMA "+fast+"/21 pullback",(i,s)=>{if(i<2)return{ok:false,score:0};const a=s.ema.get(fast)!,b=s.ema.get(21)!,p=s.bars[i-1],c=s.bars[i];return{ok:a[i]>b[i]&&p.low<=a[i-1]&&c.close>p.high,score:(c.close/a[i]-1)*10000}});
for(const rv of [1.2,1.5])add("SQUEEZE-BREAK","BB squeeze + breakout + RVOL "+rv,(i,s)=>{const bb=s.bb.get("20-2")!,p=bwPct(bb.width)[i];return{ok:Number.isFinite(p)&&p<=.25&&s.bars[i].close>bb.upper[i]&&s.volRatio[i]>=rv,score:(s.bars[i].close/bb.upper[i]-1)*10000}});
for(const th of [0,10,20])add("VWAP","VWAP reclaim + momentum "+th,(i,s)=>{if(i<1)return{ok:false,score:0};const n=Math.max(1,Math.round(15/tf)),v=s.vwap;return{ok:s.bars[i-1].close<=v[i-1]&&s.bars[i].close>v[i]&&momentum(s,i,n)>=th,score:momentum(s,i,n)}});
for(const lo of [20,25,30])add("RSI-REV","RSI "+lo+" reclaim",(i,s)=>{if(i<1)return{ok:false,score:0};const r=s.rsi.get(14)!;return{ok:r[i-1]<lo&&r[i]>=lo,score:r[i]-lo}});
const ds=tf===5?[10,20,30]:tf===15?[5,10,20]:[3,5,10];
for(const n of ds)add("DONCHIAN","Donchian "+n+" bars",(i,s)=>{const d=s.don.get(n)!;const hn=Math.max(1,Math.round(30/tf));return{ok:Number.isFinite(d.high[i])&&s.bars[i].close>d.high[i]&&momentum(s,i,hn)>0,score:momentum(s,i,hn)}});
return out}

function summarize(rows:Trade[]){const r=rows.map(x=>x.netBps),w=r.filter(x=>x>0),l=r.filter(x=>x<0),gp=w.reduce((a,b)=>a+b,0),gl=Math.abs(l.reduce((a,b)=>a+b,0)),s=[...r].sort((a,b)=>a-b);return{signals:r.length,winRate:+(r.length?w.length/r.length*100:0).toFixed(2),avgNetBps:+mean(r).toFixed(2),medianNetBps:+(s.length?s[Math.floor(s.length/2)]:0).toFixed(2),profitFactor:+(gl?gp/gl:999).toFixed(2),totalNetBps:+r.reduce((a,b)=>a+b,0).toFixed(2)}}
function mc(rows:Trade[],n=2000){if(!rows.length)return{probPositive:0,p50:0,p95dd:0};const r=rows.map(x=>x.netBps),f:number[]=[],d:number[]=[];for(let k=0;k<n;k++){let e=0,p=0,m=0;for(let i=0;i<r.length;i++){e+=r[Math.floor(Math.random()*r.length)];p=Math.max(p,e);m=Math.max(m,p-e)}f.push(e);d.push(m)}f.sort((a,b)=>a-b);d.sort((a,b)=>a-b);return{probPositive:+(f.filter(x=>x>0).length/n*100).toFixed(2),p50:+f[Math.floor(n*.5)].toFixed(2),p95dd:+d[Math.floor(n*.95)].toFixed(2)}}
function tradesFor(st:Strategy,sym:string,s:Series,ctx:Ctx,days:Set<string>|undefined){const out:Trade[]=[];const h=Math.max(1,Math.round(60/st.tf));for(let i=50;i<s.bars.length-h-1;i++){if(days&&!days.has(local(s.bars[i].ts).day))continue;const q=st.entry(i,s,{market:ctx.market,higher:ctx.higher,symbol:sym});if(!q.ok)continue;const e=s.bars[i+1]?.open,x=s.bars[i+1+h]?.open;if(!Number.isFinite(e)||!Number.isFinite(x)||e<=0||x<=0)continue;const gross=(x/e-1)*10000;out.push({strategyId:st.id,tf:st.tf,family:st.family,name:st.name,symbol:sym,ts:s.bars[i].ts,grossBps:gross,netBps:gross-COST_BPS})}return out}

async function fetchBars(symbol:string,start:number,end:number){const url="https://query1.finance.yahoo.com/v8/finance/chart/"+symbol+".BK?period1="+start+"&period2="+end+"&interval=5m&includePrePost=false&events=div%2Csplits";const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},cache:"no-store"});if(!r.ok)throw new Error("Yahoo HTTP "+r.status);const j=await r.json(),x=j?.chart?.result?.[0];if(!x)throw new Error("Yahoo missing result");const q=x.indicators?.quote?.[0]??{};return(x.timestamp??[]).map((t:number,i:number)=>({ts:t,open:Number(q.open?.[i]),high:Number(q.high?.[i]),low:Number(q.low?.[i]),close:Number(q.close?.[i]),volume:Number(q.volume?.[i]??0)})).filter((b:Bar)=>[b.open,b.high,b.low,b.close].every(Number.isFinite)&&b.close>0)}

export async function GET(){
const end=Math.floor(Date.now()/1000),start=Math.floor((Date.now()-LOOKBACK_DAYS*86400000)/1000);
const fetched=await Promise.allSettled(SYMBOLS.map(s=>fetchBars(s,start,end))),raw=new Map<string,Bar[]>(),errors:string[]=[];
fetched.forEach((x,i)=>x.status==="fulfilled"?raw.set(SYMBOLS[i],x.value):errors.push(SYMBOLS[i]));
const frames=[5,15,30],seriesByTf=new Map<number,Map<string,Series>>();
for(const tf of frames){const m=new Map<string,Series>();for(const [sym,b] of Array.from(raw.entries()))m.set(sym,buildSeries(tf===5?b:resample(b,tf)));seriesByTf.set(tf,m)}
const strategies=frames.flatMap(tf=>makeStrategies(tf).map(x=>({...x,id:x.id+tf*10000})));
const sessions=[...new Set(Array.from(raw.values()).flatMap(b=>b.map(x=>local(x.ts).day)))].sort();
const folds:{fold:number;train:Set<string>;test:Set<string>}[]=[];const tn=20,on=5,step=5;
for(let p=0,f=1;p+tn+on<=sessions.length;p+=step,f++)folds.push({fold:f,train:new Set(sessions.slice(p,p+tn)),test:new Set(sessions.slice(p+tn,p+tn+on))});
const oos=new Map<number,Trade[]>(),logs:any[]=[];
for(const fold of folds){
const ctxByTf=new Map<number,Ctx>();
for(const tf of frames){const data=new Map<string,Bar[]>();for(const [sym,s] of Array.from(seriesByTf.get(tf)!.entries()))data.set(sym,s.bars);ctxByTf.set(tf,{market:marketContext(data),higher:new Map(),symbol:""})}
for(const tf of [5,15]){for(const [sym,s] of Array.from(seriesByTf.get(tf)!.entries()))ctxByTf.get(tf)!.higher.set(sym,seriesByTf.get(tf===5?15:30)!.get(sym)!)}
const trainRows=new Map<number,Trade[]>();
for(const st of strategies){const data=seriesByTf.get(st.tf)!,ctx=ctxByTf.get(st.tf)!;const rows:Trade[]=[];for(const [sym,s] of Array.from(data.entries()))rows.push(...tradesFor(st,sym,s,ctx,fold.train));trainRows.set(st.id,rows)}
const ranking=strategies.map(st=>({st,m:summarize(trainRows.get(st.id)||[])})).filter(x=>x.m.signals>=8).sort((a,b)=>b.m.totalNetBps-a.m.totalNetBps).slice(0,12);
const chosen:any[]=[];
for(const z of ranking){const data=seriesByTf.get(z.st.tf)!,ctx=ctxByTf.get(z.st.tf)!,rows:Trade[]=[];for(const [sym,s] of Array.from(data.entries()))rows.push(...tradesFor(z.st,sym,s,ctx,fold.test));const all=oos.get(z.st.id)||[];all.push(...rows);oos.set(z.st.id,all);chosen.push({id:z.st.id,tf:z.st.tf,family:z.st.family,name:z.st.name,train:z.m,oos:summarize(rows)})}
logs.push({fold:fold.fold,trainSessions:fold.train.size,testSessions:fold.test.size,chosen})
}
const summaries=Array.from(oos.entries()).map(([id,rows])=>{const x=rows[0];return{id,tf:x?.tf??0,family:x?.family??"",name:x?.name??"",...summarize(rows),testDays:[...new Set(rows.map(r=>local(r.ts).day))].length,mc:mc(rows)}}).sort((a,b)=>b.totalNetBps-a.totalNetBps);
const top=summaries.slice(0,25),stress=top.slice(0,12).map(x=>{const rows=oos.get(x.id)||[];return{id:x.id,tf:x.tf,name:x.name,net45:x.totalNetBps,net60:+rows.reduce((a,r)=>a+r.grossBps-60,0).toFixed(2),net80:+rows.reduce((a,r)=>a+r.grossBps-80,0).toFixed(2),signals:x.signals,winRate:x.winRate,pf:x.profitFactor,mcPositive:x.mc.probPositive}});
return NextResponse.json({status:"COMPLETED",testType:"MULTI-TF-UPGRADED-WALK-FORWARD",period:{lookbackDays:LOOKBACK_DAYS,sessions:sessions.length,start:sessions[0]||null,end:sessions[sessions.length-1]||null},data:{symbols:Array.from(raw.keys()),failed:errors,bars5m:Array.from(raw.values()).reduce((n,a)=>n+a.length,0),bars15m:Array.from(seriesByTf.get(15)!.values()).reduce((n,a)=>n+a.bars.length,0),bars30m:Array.from(seriesByTf.get(30)!.values()).reduce((n,a)=>n+a.bars.length,0)},rules:{baseData:"5m Yahoo; 15m/30m resampled session-aware",entry:"completed bar close -> next bar open",holding:"60 minutes normalized across timeframes",costBps:COST_BPS,walkForward:"20 train / 5 OOS, step 5",selection:"top 12 by training net bps, minimum 8 train signals; no OOS selection"},strategiesTested:strategies.length,folds:folds.length,selectionLogs:logs,top25:top,costStress:stress});
}