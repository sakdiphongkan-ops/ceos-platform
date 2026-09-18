const SYMBOLS=["ADVANC","AOT","CPALL","DELTA","GULF","KBANK","PTT","SCB","TOP","TRUE"];
const COST=45, DAYS=59, TZ="Asia/Bangkok";

const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const local=ts=>{const p=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(ts*1000));const o={};for(const z of p)o[z.type]=z.value;return{day:o.year+"-"+o.month+"-"+o.day,hm:+o.hour*60+ +o.minute}};
const morning=hm=>hm>=600&&hm<750, afternoon=hm=>hm>=870&&hm<990;
const sessionKey=ts=>{const x=local(ts);return x.day+"-"+(x.hm<750?1:2)};
const sma=(a,n)=>{const r=Array(a.length).fill(NaN);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)r[i]=s/n}return r};
const ema=(a,n)=>{const r=[];const k=2/(n+1);let e=NaN;for(const x of a){e=Number.isFinite(e)?e+(x-e)*k:x;r.push(e)}return r};
const rsi=(a,n)=>{const r=Array(a.length).fill(NaN);for(let i=n;i<a.length;i++){let g=0,l=0;for(let j=i-n+1;j<=i;j++){const d=a[j]-a[j-1];g+=Math.max(d,0);l+=Math.max(-d,0)}r[i]=l===0?100:100-100/(1+(g/n)/(l/n))}return r};
const atr=(b,n)=>sma(b.map((x,i)=>{const p=i?b[i-1].close:x.close;return Math.max(x.high-x.low,Math.abs(x.high-p),Math.abs(x.low-p))}),n);
const don=(b,n)=>{const hi=Array(b.length).fill(NaN),lo=Array(b.length).fill(NaN);for(let i=n;i<b.length;i++){let h=-Infinity,l=Infinity;for(let j=i-n;j<i;j++){h=Math.max(h,b[j].high);l=Math.min(l,b[j].low)}hi[i]=h;lo[i]=l}return{high:hi,low:lo}};
const bb=(c,n,k)=>{const mid=sma(c,n),up=Array(c.length).fill(NaN),w=Array(c.length).fill(NaN);for(let i=n-1;i<c.length;i++){let ss=0;for(let j=i-n+1;j<=i;j++)ss+=(c[j]-mid[i])**2;const sd=Math.sqrt(ss/n);up[i]=mid[i]+k*sd;w[i]=mid[i]?2*k*sd/mid[i]*10000:NaN}return{mid,upper:up,width:w}};
const volRatio=(b,n=20)=>b.map((x,i)=>{if(i<n)return NaN;const av=mean(b.slice(i-n,i).map(z=>z.volume));return av?x.volume/av:1});
const bwPct=(w,n=40)=>{const r=Array(w.length).fill(NaN);for(let i=n;i<w.length;i++){const h=w.slice(i-n,i).filter(Number.isFinite);r[i]=h.length?h.filter(x=>x<=w[i]).length/h.length:NaN}return r};
const resample=(bars,tf)=>{const groups=new Map();for(const b of bars){const x=local(b.ts);if(!(morning(x.hm)||afternoon(x.hm)))continue;const base=x.hm<750?600:870,bucket=base+Math.floor((x.hm-base)/(tf*60))*tf*60,key=x.day+"-"+bucket,a=groups.get(key)||[];a.push(b);groups.set(key,a)}const out=[];for(const a of Array.from(groups.values()).sort((x,y)=>x[0].ts-y[0].ts)){a.sort((x,y)=>x.ts-y.ts);out.push({ts:a[a.length-1].ts,open:a[0].open,high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low)),close:a[a.length-1].close,volume:a.reduce((s,x)=>s+x.volume,0)})}return out};
const sessionVwap=b=>{const r=Array(b.length).fill(NaN);let key="",pv=0,v=0;for(let i=0;i<b.length;i++){const k=sessionKey(b[i].ts);if(k!==key){key=k;pv=0;v=0}pv+=b[i].close*b[i].volume;v+=b[i].volume;r[i]=v?pv/v:b[i].close}return r};
const openingRange=(b,n)=>{const hi=Array(b.length).fill(NaN),lo=Array(b.length).fill(NaN);let d="",rh=-Infinity,rl=Infinity,c=0;for(let i=0;i<b.length;i++){const x=local(b[i].ts);if(x.day!==d){d=x.day;rh=-Infinity;rl=Infinity;c=0}if(morning(x.hm)&&c<n){rh=Math.max(rh,b[i].high);rl=Math.min(rl,b[i].low);c++}if(morning(x.hm)&&c>=n){hi[i]=rh;lo[i]=rl}}return{high:hi,low:lo}};
const build=b=>{const c=b.map(x=>x.close),s={bars:b,ema:new Map(),rsi:new Map(),atr:new Map(),don:new Map(),bb:new Map(),vwap:sessionVwap(b),orb:new Map(),vr:volRatio(b)};for(const n of [5,8,13,20,21,34,50]){s.ema.set(n,ema(c,n));s.rsi.set(n,rsi(c,n));s.atr.set(n,atr(b,n));s.don.set(n,don(b,n))}for(const [n,k] of [[10,1.5],[14,2],[20,2],[20,2.5]])s.bb.set(n+"-"+k,bb(c,n,k));for(const n of [1,2,3,4,6,12])s.orb.set(n,openingRange(b,n));return s};
const mom=(s,i,n)=>{const p=s.bars[i-n]?.close;return p?(s.bars[i].close/p-1)*10000:0};
const higherIndex=(s,ts)=>{let l=0,r=s.bars.length-1,b=-1;while(l<=r){const m=(l+r)>>1;if(s.bars[m].ts<=ts){b=m;l=m+1}else r=m-1}return b};
const marketContext=data=>{const map=new Map();for(const [sym,b] of data){for(let i=12;i<b.length;i++){const ts=b[i].ts,a=map.get(ts)||[];a.push({r5:mom({bars:b},i,5),r12:mom({bars:b},i,12),up:b[i].close>b[i-5].close});map.set(ts,a)}}const out=new Map();for(const [ts,a] of map)out.set(ts,{r5:mean(a.map(x=>x.r5)),r12:mean(a.map(x=>x.r12)),breadth:a.length?a.filter(x=>x.up).length/a.length:.5});return out};
async function fetchBars(sym,start,end){const u="https://query1.finance.yahoo.com/v8/finance/chart/"+sym+".BK?period1="+start+"&period2="+end+"&interval=5m&includePrePost=false&events=div%2Csplits";const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}});if(!r.ok)throw new Error(sym+" HTTP "+r.status);const j=await r.json(),x=j.chart?.result?.[0],q=x?.indicators?.quote?.[0]||{};if(!x)throw new Error(sym+" no result");return(x.timestamp||[]).map((t,i)=>({ts:t,open:+q.open?.[i],high:+q.high?.[i],low:+q.low?.[i],close:+q.close?.[i],volume:+(q.volume?.[i]||0)})).filter(b=>[b.open,b.high,b.low,b.close].every(Number.isFinite)&&b.close>0)}

function strategies(tf){const out=[];let id=1,add=(fam,name,fn)=>out.push({id:id++,tf,fam,name,fn});const w=tf===5?[1,2,3,6,12]:tf===15?[1,2,3,4]:[1,2];
for(const n of w)add("ORB","ORB "+n+"b/"+n*tf+"m",(i,s,c)=>{const o=s.orb.get(n);return Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]?1:0});
for(const n of w)for(const rv of [1.2,1.5])add("ORB+RVOL","ORB "+n*tf+"m RVOL "+rv,(i,s,c)=>{const o=s.orb.get(n);return Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&s.vr[i]>=rv?1:0});
for(const n of w)for(const th of [0,10,25])add("ORB+RS","ORB "+n*tf+"m RS "+th,(i,s,c)=>{const o=s.orb.get(n),m=c.market.get(s.bars[i].ts),hn=Math.max(1,Math.round(30/tf)),rel=mom(s,i,hn)-(m?.r5||0);return Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&rel>=th?1:0});
for(const n of w)for(const pct of [.2,.4])add("ORB+SQ","ORB "+n*tf+"m squeeze "+pct,(i,s,c)=>{const o=s.orb.get(n),p=bwPct(s.bb.get("20-2").width)[i];return Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&p<=pct?1:0});
for(const n of w.filter(x=>x<=6))add("ORB+RETEST","ORB "+n*tf+"m retest",(i,s,c)=>{if(i<1)return 0;const o=s.orb.get(n),p=s.orb.get(n);return Number.isFinite(p.high[i-1])&&s.bars[i-1].close>p.high[i-1]&&Number.isFinite(o.high[i])&&s.bars[i].low<=o.high[i]*1.001&&s.bars[i].close>o.high[i]?1:0});
for(const slope of [0,5,15])for(const n of w)add("ORB+MTF","ORB "+n*tf+"m HTF "+slope,(i,s,c)=>{const o=s.orb.get(n),h=c.higher.get(c.symbol);if(!h)return 0;const j=higherIndex(h,s.bars[i].ts);if(j<34)return 0;const a=h.ema.get(13)[j],b=h.ema.get(34)[j],sc=(a/b-1)*10000;return Number.isFinite(o.high[i])&&s.bars[i].close>o.high[i]&&sc>=slope?1:0});
for(const f of [5,8])add("EMA-PB","EMA "+f+"/21 pullback",(i,s)=>{if(i<2)return 0;const a=s.ema.get(f),b=s.ema.get(21),p=s.bars[i-1],x=s.bars[i];return a[i]>b[i]&&p.low<=a[i-1]&&x.close>p.high?1:0});
for(const rv of [1.2,1.5])add("SQUEEZE","BB squeeze breakout RVOL "+rv,(i,s)=>{const z=s.bb.get("20-2"),p=bwPct(z.width)[i];return Number.isFinite(p)&&p<=.25&&s.bars[i].close>z.upper[i]&&s.vr[i]>=rv?1:0});
for(const th of [0,10,20])add("VWAP","VWAP reclaim mom "+th,(i,s)=>{if(i<1)return 0;const n=Math.max(1,Math.round(15/tf)),v=s.vwap;return s.bars[i-1].close<=v[i-1]&&s.bars[i].close>v[i]&&mom(s,i,n)>=th?1:0});
for(const lo of [20,25,30])add("RSI-REV","RSI "+lo+" reclaim",(i,s)=>{if(i<1)return 0;const r=s.rsi.get(14);return r[i-1]<lo&&r[i]>=lo?1:0});
const ds=tf===5?[10,20,30]:tf===15?[5,10,20]:[3,5,10];for(const n of ds)add("DON","Donchian "+n,(i,s)=>{const d=s.don.get(n),hn=Math.max(1,Math.round(30/tf));return Number.isFinite(d.high[i])&&s.bars[i].close>d.high[i]&&mom(s,i,hn)>0?1:0});
return out}

const summarize=r=>{const a=r.map(x=>x.net),w=a.filter(x=>x>0),l=a.filter(x=>x<0),gp=w.reduce((s,x)=>s+x,0),gl=Math.abs(l.reduce((s,x)=>s+x,0));return{signals:a.length,win:+(a.length?w.length/a.length*100:0).toFixed(2),avg:+mean(a).toFixed(2),pf:+(gl?gp/gl:999).toFixed(2),net:+a.reduce((s,x)=>s+x,0).toFixed(2)}};
const mc=r=>{if(!r.length)return{positive:0,median:0,p95dd:0};const a=r.map(x=>x.net),f=[],d=[];for(let k=0;k<2000;k++){let e=0,p=0,m=0;for(let i=0;i<a.length;i++){e+=a[Math.floor(Math.random()*a.length)];p=Math.max(p,e);m=Math.max(m,p-e)}f.push(e);d.push(m)}f.sort((a,b)=>a-b);d.sort((a,b)=>a-b);return{positive:+(f.filter(x=>x>0).length/20).toFixed(2),median:+f[1000].toFixed(2),p95dd:+d[1900].toFixed(2)}};

const end=Math.floor(Date.now()/1000),start=Math.floor((Date.now()-DAYS*86400000)/1000);
const fetched=await Promise.allSettled(SYMBOLS.map(s=>fetchBars(s,start,end))),raw=new Map(),failed=[];fetched.forEach((x,i)=>x.status==="fulfilled"?raw.set(SYMBOLS[i],x.value):failed.push(SYMBOLS[i]));
const frames=[5,15,30],series=new Map();
for(const tf of frames){const m=new Map();for(const [sym,b] of raw)m.set(sym,build(tf===5?b:resample(b,tf)));series.set(tf,m)}
const cts=new Map();for(const tf of frames){const d=new Map();for(const [sym,s] of series.get(tf))d.set(sym,s.bars);cts.set(tf,marketContext(d))}
const ctxHigher=new Map();for(const tf of [5,15]){const hm=new Map();for(const [sym,s] of series.get(tf))hm.set(sym,series.get(tf===5?15:30).get(sym));ctxHigher.set(tf,hm)}
const all=[];for(const tf of frames)for(const st of strategies(tf)){st.id+=tf*10000;all.push(st)}

const allTrades=new Map();
for(const st of all){const rows=[];for(const [sym,s] of series.get(st.tf)){const ctx={market:cts.get(st.tf),higher:ctxHigher.get(st.tf)||new Map(),symbol:sym};const h=Math.max(1,Math.round(60/st.tf));for(let i=50;i<s.bars.length-h-1;i++){const x=local(s.bars[i].ts);if(!x.day)continue;if(st.fn(i,s,ctx)){const e=s.bars[i+1].open,z=s.bars[i+1+h]?.open;if(Number.isFinite(e)&&Number.isFinite(z)&&e>0&&z>0)rows.push({ts:s.bars[i].ts,net:(z/e-1)*10000-COST,gross:(z/e-1)*10000,symbol:sym})}}}allTrades.set(st.id,rows)}

const days=[...new Set(Array.from(raw.values()).flatMap(b=>b.map(x=>local(x.ts).day)))].sort(),folds=[];for(let p=0,f=1;p+25<=days.length;p+=5,f++)folds.push({fold:f,train:new Set(days.slice(p,p+20)),test:new Set(days.slice(p+20,p+25))});
const oos=new Map(),logs=[];
for(const fold of folds){const rank=[];for(const st of all){const rows=(allTrades.get(st.id)||[]).filter(r=>fold.train.has(local(r.ts).day));const sm=summarize(rows);if(sm.signals>=8)rank.push({st,sm,rows})}rank.sort((a,b)=>b.sm.net-a.sm.net);const chosen=rank.slice(0,12),cl=[];for(const z of chosen){const rows=(allTrades.get(z.st.id)||[]).filter(r=>fold.test.has(local(r.ts).day));const sm=summarize(rows);const a=oos.get(z.st.id)||[];a.push(...rows);oos.set(z.st.id,a);cl.push({id:z.st.id,tf:z.st.tf,family:z.st.fam,name:z.st.name,train:z.sm,oos:sm})}logs.push({fold:fold.fold,chosen:cl})}

const info=new Map(all.map(st=>[st.id,st]));
const final=Array.from(oos.entries()).map(([id,r])=>{const st=info.get(id),sm=summarize(r);return{id,tf:st.tf,family:st.fam,name:st.name,...sm,days:[...new Set(r.map(x=>local(x.ts).day))].length,mc:mc(r)}}).sort((a,b)=>b.net-a.net);
const stress=final.slice(0,12).map(x=>{const r=oos.get(x.id)||[];return{id:x.id,tf:x.tf,name:x.name,net45:x.net,net60:+r.reduce((s,t)=>s+t.gross-60,0).toFixed(2),net80:+r.reduce((s,t)=>s+t.gross-80,0).toFixed(2),signals:x.signals,win:x.win,pf:x.pf,mcPositive:x.mc.positive}});
console.log(JSON.stringify({status:"COMPLETED",period:{days:DAYS,sessions:days.length,start:days[0],end:days.at(-1)},data:{symbols:[...raw.keys()],failed,bars5m:[...raw.values()].reduce((n,a)=>n+a.length,0),bars15m:[...series.get(15).values()].reduce((n,a)=>n+a.bars.length,0),bars30m:[...series.get(30).values()].reduce((n,a)=>n+a.bars.length,0)},rules:{entry:"close -> next open",holding:"60m normalized",costBps:COST,walkForward:"20 train / 5 OOS step 5",selection:"top 12 train net"},strategiesTested:all.length,folds:folds.length,top25:final.slice(0,25),costStress:stress,logs}),null,2));
