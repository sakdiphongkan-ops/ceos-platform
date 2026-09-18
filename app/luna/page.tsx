"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  CircleDot,
  Clock3,
  Filter,
  History,
  Layers3,
  RefreshCw,
  Search,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";

type Position = {
  symbol: string;
  name: string;
  qty: number;
  avgCost: number;
  last: number;
  dayChange: number;
  realized: number;
  signal: "BUY" | "SELL" | "HOLD";
  signalReason: string;
};

type Trade = {
  time: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  value: number;
  status: "FILLED" | "PARTIAL" | "REJECTED";
  strategy: string;
  reason: string;
};

const LUNA_API = "https://wigzicwgcsrhdummrbjx.supabase.co/functions/v1/luna-api";
const TIMEFRAME = "15m";

type LunaFeed = {
  generated_at:string;
  sessions:any[];
  ticks:any[];
  signals:any[];
  snapshots:any[];
  orders:any[];
  fills:any[];
  positions:any[];
  execution_control:any;
  counts:any;
  errors:any[];
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

const signed = (n: number) => `${n >= 0 ? "+" : "-"}฿${money(Math.abs(n))}`;

export default function LunaPortfolioPage() {
  const [tab,setTab]=useState<"holdings"|"trades"|"closed"|"research">("holdings");
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<Position|null>(null);
  const [feed,setFeed]=useState<LunaFeed|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [live,setLive]=useState(false);

  const load=useCallback(async()=>{
    setLoading(true); setError("");
    try{
      const res=await fetch(`${LUNA_API}?limit=100`,{cache:"no-store"});
      if(!res.ok) throw new Error(`API ${res.status}`);
      const data=await res.json() as LunaFeed;
      setFeed(data);
      if(data.errors?.length) setError("Feed returned partial data");
      setLive(true);
    }catch(e){ setLive(false); setError(e instanceof Error?e.message:"Unable to load LUNA feed"); }
    finally{ setLoading(false); }
  },[]);

  useEffect(()=>{ load(); const id=setInterval(load,15000); return()=>clearInterval(id); },[load]);

  const session=feed?.sessions?.find(s=>s.status==="OPEN") ?? feed?.sessions?.[0];
  const sessionId=session?.id;
  const sessionPositions=(feed?.positions??[]).filter(p=>!sessionId||p.session_id===sessionId);
  const sessionOrders=(feed?.orders??[]).filter(o=>!sessionId||o.session_id===sessionId);
  const sessionSignals=(feed?.signals??[]).filter(s=>!sessionId||s.session_id===sessionId);
  const sessionSnapshot=(feed?.snapshots??[]).find(s=>!sessionId||s.session_id===sessionId);
  const sessionTicks=(feed?.ticks??[]).filter(t=>!sessionId||t.session_id===sessionId);

  const positions:Position[]=sessionPositions.filter(p=>Number(p.qty)>0).map(p=>{
    const tick=sessionTicks.find(t=>t.symbol===p.symbol);
    const signal=sessionSignals.find(s=>s.symbol===p.symbol);
    const last=Number(tick?.last??tick?.bid??tick?.ask??p.avg_price);
    return {
      symbol:p.symbol,name:p.symbol,qty:Number(p.qty),avgCost:Number(p.avg_price),last,
      dayChange:0,realized:Number(p.realized_pnl??0),
      signal:(signal?.action==="BUY"||signal?.action==="SELL"||signal?.action==="HOLD"?signal.action:"HOLD"),
      signalReason:signal?.reason??"No current signal recorded"
    };
  });

  const trades:Trade[]=sessionOrders.map(o=>{
    const fill=(feed?.fills??[]).find(f=>f.order_id===o.id);
    const status=o.status==="PARTIAL"?"PARTIAL":o.status==="REJECTED"?"REJECTED":"FILLED";
    const price=Number(o.avg_fill_price??fill?.price??o.limit_price??0);
    return {time:new Date(o.created_at).toLocaleTimeString("en-GB",{hour12:false}),symbol:o.symbol,
      side:o.side==="SELL"?"SELL":"BUY",qty:Number(o.filled_qty||o.qty),price,value:price*Number(o.filled_qty||o.qty),
      status,strategy:session?.strategy_version??"—",reason:o.reason??"—"};
  });

  const closedPositions=useMemo(()=>{
    const bySymbol=new Map<string,{symbol:string;entry:number;exit:number;qty:number;pnl:number;duration:string}>();
    const orders=[...sessionOrders].sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime());
    for(const o of orders){
      const fill=(feed?.fills??[]).find(f=>f.order_id===o.id); const qty=Number(o.filled_qty||fill?.qty||0); if(!qty) continue;
      const price=Number(o.avg_fill_price??fill?.price??o.limit_price??0);
      const cur=bySymbol.get(o.symbol);
      if(o.side==="BUY") bySymbol.set(o.symbol,{symbol:o.symbol,entry:price,exit:0,qty,pnl:0,duration:"—"});
      else if(cur){cur.exit=price;cur.pnl=(price-cur.entry)*Math.min(cur.qty,qty);bySymbol.set(o.symbol,cur);}
    }
    return Array.from(bySymbol.values()).filter(x=>x.exit>0);
  },[sessionOrders,feed?.fills]);

  const filteredPositions=positions.filter(p=>`${p.symbol} ${p.name}`.toLowerCase().includes(query.toLowerCase()));
  const initial=Number(session?.initial_capital??1000000);
  const marketValue=Number(sessionSnapshot?.market_value??positions.reduce((s,p)=>s+p.qty*p.last,0));
  const cash=Number(sessionSnapshot?.cash??Math.max(0,initial-marketValue));
  const equity=cash+marketValue;
  const unrealized=Number(sessionSnapshot?.unrealized_pnl??positions.reduce((s,p)=>s+p.qty*(p.last-p.avgCost),0));
  const realized=Number(sessionSnapshot?.realized_pnl??positions.reduce((s,p)=>s+p.realized,0));
  const fees=Number(sessionSnapshot?.fees??0);
  const exposure=equity?Number(sessionSnapshot?.gross_exposure??marketValue)/equity*100:0;
  const selectedPos=selected&&positions.some(p=>p.symbol===selected.symbol)?positions.find(p=>p.symbol===selected.symbol)??null:null;

  return <main className="luna-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">L</div><div><div className="eyebrow">LUNA-TH1H</div><h1>Portfolio</h1></div></div>
      <div className="top-actions">
        <div className="market-status"><CircleDot size={11}/> SET / {session?.mode?.toUpperCase()??"PAPER"}</div><div className="timeframe-chip"><BarChart3 size={13}/> {TIMEFRAME}</div>
        <button className="icon-button" title="Refresh" onClick={load}><RefreshCw size={17}/></button>
        <div className="session-chip"><Clock3 size={14}/> {session?.session_date??"—"} · {live?"FEED OK":"OFFLINE"}</div>
      </div>
    </header>
    <div className="page">
      <section className="hero-row"><div><div className="eyebrow">INTRADAY CONTROL · LIVE PORTFOLIO</div><h2>What LUNA owns right now</h2><p>Database-backed holdings, executions, P&amp;L and risk exposure.</p></div><div className="hero-meta"><div className="data-chip"><span className="data-dot"/> {live ? "LIVE DATA" : "DATA OFFLINE"}</div><div className="safe-badge"><ShieldCheck size={15}/> {session?.mode?.toUpperCase()??"PAPER"} / SAFE</div></div></section>
      {error&&<div className="error-banner"><span>{error}</span><button onClick={load}>Retry</button></div>}
      <section className="summary-grid"><Metric label="Market ticks" value={String(sessionTicks.length)} sub="Latest session feed"/><Metric label="Signals" value={String(sessionSignals.length)} sub="15m strategy signals"/><Metric label="Orders" value={String(sessionOrders.length)} sub="Recorded this session"/>
        <Metric label="Total Equity" value={`฿${money(equity)}`} sub={`Initial ฿${money(initial)}`} positive={equity>=initial}/>
        <Metric label="Market Value" value={`฿${money(marketValue)}`} sub={`${exposure.toFixed(1)}% exposure`}/>
        <Metric label="Cash" value={`฿${money(cash)}`} sub="Available cash"/>
        <Metric label="Unrealized P&L" value={signed(unrealized)} sub="Current open positions" positive={unrealized>=0}/>
        <Metric label="Realized P&L" value={signed(realized)} sub="Closed / executed" positive={realized>=0}/>
        <Metric label="Fees" value={`-฿${money(fees)}`} sub="Recorded execution cost"/>
      </section>
      <section className="content-grid">
        <div className="main-card">
          <div className="card-head"><div><div className="card-title">Portfolio positions</div><div className="card-subtitle">{positions.length} open positions · max 20% / symbol</div></div><div className="toolbar"><div className="search-box"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search symbol"/></div><button className="filter-button"><Filter size={15}/> Filter <ChevronDown size={13}/></button></div></div>
          <div className="tabs"><button className={tab==="holdings"?"active":""} onClick={()=>setTab("holdings")}>Holdings <span>{positions.length}</span></button><button className={tab==="trades"?"active":""} onClick={()=>setTab("trades")}>Today's Trades <span>{trades.length}</span></button><button className={tab==="closed"?"active":""} onClick={()=>setTab("closed")}>Closed Positions <span>{closedPositions.length}</span></button><button className={tab==="research"?"active":""} onClick={()=>setTab("research")}>Research <span>WF</span></button></div>
          {loading?<div className="loading-state"><RefreshCw size={18}/> Loading live portfolio feed…</div>:
          tab==="holdings"?<div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>QTY</th><th>AVG COST</th><th>LAST</th><th>MARKET VALUE</th><th>UNREALIZED P&amp;L</th><th>WEIGHT</th><th>SIGNAL</th></tr></thead><tbody>{filteredPositions.length?filteredPositions.map(p=>{const value=p.qty*p.last;const weight=equity?value/equity*100:0;const pnl=p.qty*(p.last-p.avgCost);return <tr key={p.symbol} className={selectedPos?.symbol===p.symbol?"selected-row":""} onClick={()=>setSelected(p)}><td><div className="symbol-cell"><strong>{p.symbol}</strong><span>{p.name}</span></div></td><td>{money(p.qty).replace(".00","")}</td><td>฿{p.avgCost.toFixed(2)}</td><td><strong>฿{p.last.toFixed(2)}</strong></td><td>฿{money(value)}</td><td className={pnl>=0?"positive":"negative"}>{signed(pnl)}</td><td><div className="weight-cell"><span>{weight.toFixed(1)}%</span><i><b style={{width:`${Math.min(weight/20*100,100)}%`}}/></i></div></td><td><SignalBadge signal={p.signal}/></td></tr>;}):<tr><td colSpan={8} className="empty-table">No open positions recorded for the selected session.</td></tr>}</tbody></table></div>:
          tab==="research"?<ResearchPanel feed={feed}/>:tab==="trades"?<div className="table-wrap"><table><thead><tr><th>TIME</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>VALUE</th><th>STATUS</th><th>STRATEGY</th></tr></thead><tbody>{trades.length?trades.map(t=><tr key={`${t.time}-${t.symbol}-${t.qty}`}><td className="muted">{t.time}</td><td><strong>{t.symbol}</strong></td><td><SideBadge side={t.side}/></td><td>{money(t.qty).replace(".00","")}</td><td>฿{t.price.toFixed(2)}</td><td>฿{money(t.value)}</td><td><StatusBadge status={t.status}/></td><td className="muted">{t.strategy}</td></tr>):<tr><td colSpan={8} className="empty-table">No orders recorded for this session.</td></tr>}</tbody></table></div>:
          <div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>REALIZED P&amp;L</th><th>HOLD TIME</th></tr></thead><tbody>{closedPositions.length?closedPositions.map(p=><tr key={p.symbol}><td><strong>{p.symbol}</strong></td><td>฿{p.entry.toFixed(2)}</td><td>฿{p.exit.toFixed(2)}</td><td>{money(p.qty).replace(".00","")}</td><td className={p.pnl>=0?"positive":"negative"}>{signed(p.pnl)}</td><td className="muted">{p.duration}</td></tr>):<tr><td colSpan={6} className="empty-table">No closed positions reconstructed from fills.</td></tr>}</tbody></table></div>}
        </div>
        <aside className="side-card">{selectedPos?<><div className="detail-head"><div><div className="detail-symbol">{selectedPos.symbol}</div><div className="muted">{selectedPos.name}</div></div><button className="close-button" onClick={()=>setSelected(null)}><X size={15}/></button></div><div className="price-block"><div>฿{selectedPos.last.toFixed(2)}</div><span className={selectedPos.last>=selectedPos.avgCost?"positive":"negative"}>{selectedPos.last>=selectedPos.avgCost?<ArrowUpRight size={14}/>:<ArrowDownRight size={14}/>} {((selectedPos.last/selectedPos.avgCost-1)*100).toFixed(2)}%</span></div><div className="detail-grid"><Detail label="Position" value={`${money(selectedPos.qty).replace(".00","")} shares`}/><Detail label="Avg Cost" value={`฿${selectedPos.avgCost.toFixed(2)}`}/><Detail label="Market Value" value={`฿${money(selectedPos.qty*selectedPos.last)}`}/><Detail label="Unrealized P&L" value={signed(selectedPos.qty*(selectedPos.last-selectedPos.avgCost))} positive={selectedPos.last>=selectedPos.avgCost}/><Detail label="Portfolio Weight" value={`${(equity?(selectedPos.qty*selectedPos.last/equity*100):0).toFixed(1)}%`}/><Detail label="Risk Limit" value="20.0%"/></div><div className="section-label">CURRENT SIGNAL</div><div className="signal-panel"><SignalBadge signal={selectedPos.signal} large/><p>{selectedPos.signalReason}</p></div><div className="section-label">EXECUTION TIMELINE</div><div className="timeline">{trades.filter(t=>t.symbol===selectedPos.symbol).map(t=><div className="timeline-item" key={t.time}><div className={`timeline-dot ${t.side.toLowerCase()}`}/><div><strong>{t.side} {money(t.qty).replace(".00","")} @ ฿{t.price.toFixed(2)}</strong><span>{t.time} · {t.reason}</span></div></div>)}<div className="timeline-item future"><div className="timeline-dot"/><div><strong>Position currently open</strong><span>Latest feed mark</span></div></div></div><div className="audit-strip"><Layers3 size={15}/><span>Execution → Position → Snapshot → Audit event</span></div></>:<div className="empty-detail"><strong>Select a position</strong><span>Click any holding to inspect its live execution history.</span></div>}</aside>
      </section>
      <section className="bottom-grid"><div className="mini-card"><div className="mini-title"><BarChart3 size={16}/> Exposure by position</div><div className="bars">{positions.map(p=><div className="bar-row" key={p.symbol}><span>{p.symbol}</span><i><b style={{width:`${Math.min((equity?(p.qty*p.last/equity*100):0)*5,100)}%`}}/></i><strong>{(equity?p.qty*p.last/equity*100:0).toFixed(1)}%</strong></div>)}</div></div><div className="mini-card"><div className="mini-title"><History size={16}/> Session controls</div><div className="control-list"><div><span>Strategy</span><strong>{session?.strategy_version??"—"}</strong></div><div><span>Initial capital</span><strong>฿{money(initial)}</strong></div><div><span>Gross exposure</span><strong>{exposure.toFixed(1)}% / 100%</strong></div><div><span>End of day</span><strong>FORCE CLOSE</strong></div></div><div className={`live-toggle ${live ? "on" : "off"}`}><CircleDot size={13}/>{live ? "API feed connected · 15s refresh" : "Feed unavailable"}</div></div><div className="mini-card"><div className="mini-title"><WalletCards size={16}/> Audit integrity</div><div className="audit-score"><strong>{feed?.counts?.audits?"READY":"WAITING"}</strong><span>{feed?.counts?.audits??0} audit events · {feed?.counts?.fills??0} fills · {feed?.counts?.snapshots??0} snapshots</span></div><div className="hash-line">universe loaded · quote coverage tracked · API-backed</div></div></section>
    </div>
  </main>
}


function Metric({label,value,sub,positive}:{label:string;value:string;sub:string;positive?:boolean}) {
  return <div className="metric-card"><div className="metric-label">{label}</div><div className={`metric-value ${positive===undefined?"":positive?"positive":"negative"}`}>{value}</div><div className="metric-sub">{sub}</div></div>;
}
function SignalBadge({signal,large=false}:{signal:"BUY"|"SELL"|"HOLD";large?:boolean}) {
  return <span className={`signal-badge ${signal.toLowerCase()} ${large?"large":""}`}>{signal}</span>;
}
function SideBadge({side}:{side:"BUY"|"SELL"}) { return <span className={`side-badge ${side.toLowerCase()}`}>{side}</span>; }
function StatusBadge({status}:{status:string}) { return <span className={`status-badge ${status.toLowerCase()}`}>{status}</span>; }
function ResearchPanel({feed}:{feed:LunaFeed|null}) {
  const strategy = feed?.sessions?.[0]?.strategy_version ?? "luna-th1h-v1.0.0";
  const tickCount = feed?.ticks?.length ?? 0;
  const feedStatus = feed ? "Connected" : "Unavailable";
  return (
    <section className="research-panel">
      <h3>Walk-forward validation</h3>
      <p>Train 60% · Validation 20% · Test 20%</p>
      <p>Strategy: {strategy}</p>
      <p>Session ticks: {tickCount}</p>
      <p>Live feed: {feedStatus}</p>
      <p>Paper only · No live orders are created by this view.</p>
      <p>Historical source: SET Intraday / Tick Data</p>
      <p>Status: WAITING FOR LICENSED DATA</p>
    </section>
  );
}

function Detail({label,value,positive}:{label:string;value:string;positive?:boolean}) {
  const tone = positive === undefined ? "" : positive ? "positive" : "negative";
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}
