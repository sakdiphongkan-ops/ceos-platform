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
const LUNA_STRATEGY = "luna-th1h-v1.0.0-price-only-paper-warm5";
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

  useEffect(()=>{ load(); const id=setInterval(load,2000); return()=>clearInterval(id); },[load]);

  const sessions=[...(feed?.sessions??[])].sort((a,b)=>{
    const ad=new Date(a.created_at??a.started_at??a.session_date??0).getTime();
    const bd=new Date(b.created_at??b.started_at??b.session_date??0).getTime();
    return bd-ad;
  });
  const openSession=sessions.find(s=>s.status==="OPEN");
  const session=openSession??sessions[0];
  const sessionId=session?.id;
  const sessionPositions=(feed?.positions??[]).filter(p=>!sessionId||p.session_id===sessionId);
  const sessionOrders=(feed?.orders??[]).filter(o=>!sessionId||o.session_id===sessionId);
  const sessionSignals=[...(feed?.signals??[])].filter(s=>!sessionId||s.session_id===sessionId).sort((a,b)=>{
    return new Date(b.ts??b.created_at??0).getTime()-new Date(a.ts??a.created_at??0).getTime();
  });
  const sessionSnapshot=[...(feed?.snapshots??[])].filter(s=>!sessionId||s.session_id===sessionId).sort((a,b)=>{
    return new Date(b.ts??b.created_at??0).getTime()-new Date(a.ts??a.created_at??0).getTime();
  })[0];
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
  const executionMode=String(feed?.execution_control?.execution_mode??session?.mode??"paper").toUpperCase();
  const killSwitch=Boolean(feed?.execution_control?.kill_switch??true);
  const armed=Boolean(feed?.execution_control?.armed??false);
  const liveExecution=executionMode==="LIVE" && !killSwitch && armed;

  return <main className="luna-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">L</div><div><div className="eyebrow">LUNA-TH1H</div><h1>Portfolio</h1></div></div>
      <div className="top-actions">
        <div className="market-status"><CircleDot size={11}/> SET / {executionMode}</div><div className="timeframe-chip"><BarChart3 size={13}/> {TIMEFRAME}</div>
        <button className="icon-button" title="Refresh" onClick={load}><RefreshCw size={17}/></button>
        <div className="session-chip"><Clock3 size={14}/> {session?.session_date??"—"} · {live?"FEED OK":"OFFLINE"}</div>
      </div>
    </header>
    <div className="page">
      <section className="hero-row"><div><div className="eyebrow">INTRADAY CONTROL · LIVE PORTFOLIO</div><h2>What LUNA owns right now</h2><p>Database-backed holdings, executions, P&amp;L and risk exposure.</p></div><div className="hero-meta"><div className="data-chip"><span className="data-dot"/> {live ? "LIVE DATA" : "DATA OFFLINE"}</div><div className="safe-badge"><ShieldCheck size={15}/> {liveExecution ? "LIVE EXECUTION" : "PAPER EXECUTION"} / {killSwitch ? "KILL SWITCH ON" : "GATED"}</div></div></section>
      <SystemControlRoom strategy={LUNA_STRATEGY} asOf={session?.session_date ?? new Date().toISOString().slice(0,10)} />
      <section className="live-operating-strip">
        <div><span>MARKET DATA</span><strong>{live ? "LIVE FEED" : "OFFLINE"}</strong><small>15s refresh · SET</small></div>
        <div><span>EXECUTION MODE</span><strong>{executionMode}</strong><small>{liveExecution ? "live gate open" : "paper only"}</small></div>
        <div><span>KILL SWITCH</span><strong>{killSwitch ? "ON" : "OFF"}</strong><small>{armed ? "armed" : "disarmed"}</small></div>
        <div><span>LIVE ORDER GATE</span><strong>{liveExecution ? "READY" : "LOCKED"}</strong><small>broker bridge status</small></div>
        <div className="live-operating-note"><ShieldCheck size={15}/><span>ระบบนี้ยังไม่ส่งคำสั่งซื้อขาย SET อัตโนมัติจากหน้าเว็บ — ใช้ signal/paper execution เป็นหลักจนกว่า gate จะผ่าน</span></div>
      </section>
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
          <div className="card-head"><div><div className="card-title">Portfolio positions</div><div className="card-subtitle">{positions.length} open positions · dynamic sizing from signal strength</div></div><div className="toolbar"><div className="search-box"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search symbol"/></div><button className="filter-button"><Filter size={15}/> Filter <ChevronDown size={13}/></button></div></div>
          <div className="tabs"><button className={tab==="holdings"?"active":""} onClick={()=>setTab("holdings")}>Holdings <span>{positions.length}</span></button><button className={tab==="trades"?"active":""} onClick={()=>setTab("trades")}>Today's Trades <span>{trades.length}</span></button><button className={tab==="closed"?"active":""} onClick={()=>setTab("closed")}>Closed Positions <span>{closedPositions.length}</span></button><button className={tab==="research"?"active":""} onClick={()=>setTab("research")}>Research <span>WF</span></button></div>
          {loading?<div className="loading-state"><RefreshCw size={18}/> Loading live portfolio feed…</div>:
          tab==="holdings"?<div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>QTY</th><th>AVG COST</th><th>LAST</th><th>MARKET VALUE</th><th>UNREALIZED P&amp;L</th><th>WEIGHT</th><th>SIGNAL</th></tr></thead><tbody>{filteredPositions.length?filteredPositions.map(p=>{const value=p.qty*p.last;const weight=equity?value/equity*100:0;const pnl=p.qty*(p.last-p.avgCost);return <tr key={p.symbol} className={selectedPos?.symbol===p.symbol?"selected-row":""} onClick={()=>setSelected(p)}><td><div className="symbol-cell"><strong>{p.symbol}</strong><span>{p.name}</span></div></td><td>{money(p.qty).replace(".00","")}</td><td>฿{p.avgCost.toFixed(2)}</td><td><strong>฿{p.last.toFixed(2)}</strong></td><td>฿{money(value)}</td><td className={pnl>=0?"positive":"negative"}>{signed(pnl)}</td><td><div className="weight-cell"><span>{weight.toFixed(1)}%</span><i><b style={{width:`${Math.min(weight,100)}%`}}/></i></div></td><td><SignalBadge signal={p.signal}/></td></tr>;}):<tr><td colSpan={8} className="empty-table"><div>No open positions currently — positions are removed from Holdings after execution closes them.</div>{trades.length>0&&<button className="filter-button" style={{marginTop:8}} onClick={()=>setTab("trades")}>View today\'s executed trades ({trades.length})</button>}</td></tr>}</tbody></table></div>:
          tab==="research"?<ResearchPanel/>:tab==="trades"?<div className="table-wrap"><table><thead><tr><th>TIME</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>VALUE</th><th>STATUS</th><th>STRATEGY</th></tr></thead><tbody>{trades.length?trades.map(t=><tr key={`${t.time}-${t.symbol}-${t.qty}`}><td className="muted">{t.time}</td><td><strong>{t.symbol}</strong></td><td><SideBadge side={t.side}/></td><td>{money(t.qty).replace(".00","")}</td><td>฿{t.price.toFixed(2)}</td><td>฿{money(t.value)}</td><td><StatusBadge status={t.status}/></td><td className="muted">{t.strategy}</td></tr>):<tr><td colSpan={8} className="empty-table">No orders recorded for this session.</td></tr>}</tbody></table></div>:
          <div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>REALIZED P&amp;L</th><th>HOLD TIME</th></tr></thead><tbody>{closedPositions.length?closedPositions.map(p=><tr key={p.symbol}><td><strong>{p.symbol}</strong></td><td>฿{p.entry.toFixed(2)}</td><td>฿{p.exit.toFixed(2)}</td><td>{money(p.qty).replace(".00","")}</td><td className={p.pnl>=0?"positive":"negative"}>{signed(p.pnl)}</td><td className="muted">{p.duration}</td></tr>):<tr><td colSpan={6} className="empty-table">No closed positions reconstructed from fills.</td></tr>}</tbody></table></div>}
        </div>
        <aside className="side-card">{selectedPos?<><div className="detail-head"><div><div className="detail-symbol">{selectedPos.symbol}</div><div className="muted">{selectedPos.name}</div></div><button className="close-button" onClick={()=>setSelected(null)}><X size={15}/></button></div><div className="price-block"><div>฿{selectedPos.last.toFixed(2)}</div><span className={selectedPos.last>=selectedPos.avgCost?"positive":"negative"}>{selectedPos.last>=selectedPos.avgCost?<ArrowUpRight size={14}/>:<ArrowDownRight size={14}/>} {((selectedPos.last/selectedPos.avgCost-1)*100).toFixed(2)}%</span></div><div className="detail-grid"><Detail label="Position" value={`${money(selectedPos.qty).replace(".00","")} shares`}/><Detail label="Avg Cost" value={`฿${selectedPos.avgCost.toFixed(2)}`}/><Detail label="Market Value" value={`฿${money(selectedPos.qty*selectedPos.last)}`}/><Detail label="Unrealized P&L" value={signed(selectedPos.qty*(selectedPos.last-selectedPos.avgCost))} positive={selectedPos.last>=selectedPos.avgCost}/><Detail label="Portfolio Weight" value={`${(equity?(selectedPos.qty*selectedPos.last/equity*100):0).toFixed(1)}%`}/><Detail label="Sizing" value="Dynamic · signal strength"/></div><div className="section-label">CURRENT SIGNAL</div><div className="signal-panel"><SignalBadge signal={selectedPos.signal} large/><p>{selectedPos.signalReason}</p></div><div className="section-label">EXECUTION TIMELINE</div><div className="timeline">{trades.filter(t=>t.symbol===selectedPos.symbol).map(t=><div className="timeline-item" key={t.time}><div className={`timeline-dot ${t.side.toLowerCase()}`}/><div><strong>{t.side} {money(t.qty).replace(".00","")} @ ฿{t.price.toFixed(2)}</strong><span>{t.time} · {t.reason}</span></div></div>)}<div className="timeline-item future"><div className="timeline-dot"/><div><strong>Position currently open</strong><span>Latest feed mark</span></div></div></div><div className="audit-strip"><Layers3 size={15}/><span>Execution → Position → Snapshot → Audit event</span></div></>:<div className="empty-detail"><strong>Select a position</strong><span>Click any holding to inspect its live execution history.</span></div>}</aside>
      </section>
      <section className="bottom-grid"><div className="mini-card"><div className="mini-title"><BarChart3 size={16}/> Exposure by position</div><div className="bars">{positions.map(p=><div className="bar-row" key={p.symbol}><span>{p.symbol}</span><i><b style={{width:`${Math.min((equity?(p.qty*p.last/equity*100):0)*5,100)}%`}}/></i><strong>{(equity?p.qty*p.last/equity*100:0).toFixed(1)}%</strong></div>)}</div></div><div className="mini-card"><div className="mini-title"><History size={16}/> Session controls</div><div className="control-list"><div><span>Strategy</span><strong>{session?.strategy_version??"—"}</strong></div><div><span>Initial capital</span><strong>฿{money(initial)}</strong></div><div><span>Gross exposure</span><strong>{exposure.toFixed(1)}% / 100%</strong></div><div><span>End of day</span><strong>FORCE CLOSE</strong></div></div><div className={`live-toggle ${live ? "on" : "off"}`}><CircleDot size={13}/>{live ? "API feed connected · 2s refresh" : "Feed unavailable"}</div></div><div className="mini-card"><div className="mini-title"><WalletCards size={16}/> Audit integrity</div><div className="audit-score"><strong>{feed?.counts?.audits?"READY":"WAITING"}</strong><span>{feed?.counts?.audits??0} audit events · {feed?.counts?.fills??0} fills · {feed?.counts?.snapshots??0} snapshots</span></div><div className="hash-line">universe loaded · quote coverage tracked · API-backed</div></div></section>
    </div>
  </main>
}


function SystemControlRoom({strategy,asOf}:{strategy:string;asOf:string}) {
  const [state,setState]=useState<any|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");

  const refresh=useCallback(async()=>{
    setLoading(true); setError("");
    try{
      const res=await fetch(`${LUNA_API}?view=latest_control&strategy=${encodeURIComponent(strategy)}`,{cache:"no-store"});
      if(!res.ok) throw new Error(`Control API ${res.status}`);
      const data=await res.json();
      if(!data.ok) throw new Error("LUNA control API returned partial data");
      setState(data);
    }catch(e){setError(e instanceof Error?e.message:"Unable to load LUNA control state");}
    finally{setLoading(false);}
  },[strategy]);

  useEffect(()=>{refresh(); const id=setInterval(refresh,15000); return()=>clearInterval(id);},[refresh]);

  const test=state?.system_test??{};
  const checks=test?.checks??[];
  const passed=checks.filter((c:any)=>c.pass).length;
  const total=checks.length;
  const status=test?.overall_status??"LOADING";
  const readiness=state?.readiness??{};
  const fastRows=state?.fast?.forecast_rank??[];
  const finalSummary=state?.final?.summary??{};
  const audit=state?.paper_audit??{};
  const verifiedAsOf=state?.as_of_date??asOf;

  return <section className="control-room-card">
    <div className="control-room-head">
      <div>
        <div className="section-label">LUNA SYSTEM CONTROL ROOM</div>
        <div className="control-room-title">ตรวจสอบระบบจริง · {strategy}</div>
        <div className="control-room-sub">Verified market date: {verifiedAsOf} · backend-backed safety state — ไม่ใช่ mock data</div>
      </div>
      <div className="control-room-actions">
        <span className={`system-status ${status.toLowerCase()}`}><CircleDot size={11}/>{status}</span>
        <button className="filter-button" onClick={refresh} disabled={loading}><RefreshCw size={14}/>{loading?"Checking…":"Run check"}</button>
      </div>
    </div>

    {error && <div className="error-banner compact"><span>{error}</span><button onClick={refresh}>Retry</button></div>}

    <div className="control-grid">
      <div className="control-stat"><span>SELF-TEST</span><strong>{loading?"—":`${passed}/${total}`}</strong><small>{test?.summary?.integrity?"Integrity PASS":"ตรวจพบ gate ที่ยังไม่พร้อม"}</small></div>
      <div className="control-stat"><span>MONTH CLOSE</span><strong>{readiness.month_closed?"CLOSED":"OPEN"}</strong><small>{verifiedAsOf}</small></div>
      <div className="control-stat"><span>CEOS FEED</span><strong>{readiness.ceos_feed_rows??0}</strong><small>{readiness.ceos_allowed_rows??0} allowed</small></div>
      <div className="control-stat"><span>PAPER</span><strong>{readiness.paper_execution_permitted?"READY":"LOCKED"}</strong><small>{readiness.execution_mode??"—"}</small></div>
      <div className="control-stat"><span>LIVE</span><strong>{readiness.live_execution_permitted?"READY":"LOCKED"}</strong><small>live execution gate</small></div>
      <div className="control-stat"><span>KILL SWITCH</span><strong>{readiness.kill_switch?"ON":"OFF"}</strong><small>{readiness.armed?"ARMED":"DISARMED"}</small></div>
    </div>

    <div className="control-columns">
      <div className="control-panel">
        <div className="mini-title"><ShieldCheck size={15}/> Gate audit</div>
        <div className="gate-list">
          {checks.map((c:any)=><div className="gate-row" key={c.name}><span>{c.name.replaceAll("_"," ")}</span><GateBadge pass={!!c.pass}/></div>)}
          {!checks.length && <div className="muted">กำลังโหลดผล self-test…</div>}
        </div>
      </div>
      <div className="control-panel">
        <div className="mini-title"><Layers3 size={15}/> Forecast / Final Authority</div>
        <div className="forecast-meta">
          <span>Top 20 fast rank</span><strong>{fastRows.length}</strong>
          <span>Final rows</span><strong>{finalSummary.rows??0}</strong>
          <span>Paper-ready rows</span><strong>{finalSummary.paper_sim_ready??0}</strong>
        </div>
        <div className="ladder-row">
          {[10,5,3,1,0].map((n:number)=><span key={n} className="stage-chip ready">T-{n}</span>)}
        </div>
        <div className="top-symbols">
          {fastRows.slice(0,10).map((r:any)=><span key={r.symbol}>{r.rank_no}. {r.symbol}</span>)}
          {!fastRows.length && <span>No verified signal snapshot</span>}
        </div>
      </div>
      <div className="control-panel">
        <div className="mini-title"><History size={15}/> Paper audit</div>
        <div className="audit-kpis">
          <div><span>Preview</span><strong>{audit.preview_rows??0}</strong></div>
          <div><span>Incomplete month blocked</span><strong>{audit.incomplete_month_blocked_rows??0}</strong></div>
          <div><span>Orders created</span><strong>{audit.orders_total??0}</strong></div>
          <div><span>Live orders</span><strong>{audit.live_orders_created?"YES":"NO"}</strong></div>
        </div>
        <div className="audit-note">Snapshot-backed · {audit.month_closed?"closed month":"current month locked"}</div>
      </div>
    </div>
  </section>;
}

function GateBadge({pass}:{pass:boolean}) {
  return <span className={`gate-badge ${pass?"pass":"fail"}`}>{pass?"PASS":"BLOCK"}</span>;
}

function Metric({label,value,sub,positive}:{label:string;value:string;sub:string;positive?:boolean}) {
  return <div className="metric-card"><div className="metric-label">{label}</div><div className={`metric-value ${positive===undefined?"":positive?"positive":"negative"}`}>{value}</div><div className="metric-sub">{sub}</div></div>;
}
function SignalBadge({signal,large=false}:{signal:"BUY"|"SELL"|"HOLD";large?:boolean}) {
  return <span className={`signal-badge ${signal.toLowerCase()} ${large?"large":""}`}>{signal}</span>;
}
function SideBadge({side}:{side:"BUY"|"SELL"}) { return <span className={`side-badge ${side.toLowerCase()}`}>{side}</span>; }
function StatusBadge({status}:{status:string}) { return <span className={`status-badge ${status.toLowerCase()}`}>{status}</span>; }
function ResearchPanel() {
  const [data, setData] = useState<any|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/backtest/tournament100?mode=signal&universe=full", { cache: "no-store" });
      if (!res.ok) throw new Error(`Backtest API ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load research results");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { run(); }, [run]);

  const rows = showAll ? (data?.allResults ?? []) : (data?.top20 ?? []);

  return (
    <div style={{display:"grid",gap:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <div>
          <div className="section-label">FORMULA RESEARCH</div>
          <h3 style={{margin:"4px 0 4px"}}>100 สูตร — ผลทดสอบจริงจาก backtest engine</h3>
          <p style={{margin:0,opacity:.68}}>
            {data ? `${data.period?.start ?? "—"} → ${data.period?.end ?? "—"} · ${data.data?.bars15m ?? 0} bars · ${data.data?.symbolsReturned ?? 0}/${data.data?.universeCount ?? 0} symbols` : "กำลังโหลดผลทดสอบ…"}
          </p>
        </div>
        <button onClick={run} disabled={loading} className="filter-button">
          <RefreshCw size={14}/>{loading ? "Loading…" : "Refresh results"}
        </button>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={run}>Retry</button>
        </div>
      )}

      {!error && !data && loading && (
        <div className="loading-state"><RefreshCw size={17}/> Loading backtest results…</div>
      )}

      {data && (
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10}}>
            <div className="mini-card"><div className="mini-title">Strategies tested</div><strong style={{fontSize:24}}>{data.strategiesTested ?? 0}</strong><div className="muted">signal study</div></div>
            <div className="mini-card"><div className="mini-title">Universe</div><strong style={{fontSize:24}}>{data.data?.symbolsReturned ?? 0}/{data.data?.universeCount ?? 0}</strong><div className="muted">symbols with data</div></div>
            <div className="mini-card"><div className="mini-title">Trading cost</div><strong style={{fontSize:24}}>{data.rules?.costModelBps ?? 0} bps</strong><div className="muted">fee + tax + slippage</div></div>
            <div className="mini-card"><div className="mini-title">Ranking</div><strong style={{fontSize:24}}>Net bps</strong><div className="muted">after stated costs</div></div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>FAMILY</th><th>FORMULA</th><th>SIGNALS</th><th>WIN %</th><th>AVG NET BPS</th><th>MEDIAN</th><th>PF</th><th>TOTAL NET BPS</th></tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((r:any, i:number) => (
                  <tr key={`${r.id}-${i}`}>
                    <td>{i+1}</td>
                    <td><span className="signal-badge hold">{r.family}</span></td>
                    <td><div><strong>{r.name}</strong></div><div className="muted">{r.source}</div></td>
                    <td>{r.signals}</td>
                    <td>{Number(r.winRate ?? 0).toFixed(2)}%</td>
                    <td className={(r.avgNetBps ?? 0) >= 0 ? "positive" : "negative"}>{Number(r.avgNetBps ?? 0).toFixed(2)}</td>
                    <td className={(r.medianNetBps ?? 0) >= 0 ? "positive" : "negative"}>{Number(r.medianNetBps ?? 0).toFixed(2)}</td>
                    <td>{Number(r.profitFactor ?? 0) >= 999 ? "∞" : Number(r.profitFactor ?? 0).toFixed(2)}</td>
                    <td className={(r.totalNetBps ?? 0) >= 0 ? "positive" : "negative"}><strong>{Number(r.totalNetBps ?? 0).toFixed(2)}</strong></td>
                  </tr>
                )) : <tr><td colSpan={9} className="empty-table">No research results returned.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div className="muted">Showing {rows.length} of {(data.allResults ?? []).length} strategies</div>
            <button className="filter-button" onClick={()=>setShowAll(v=>!v)}>
              {showAll ? "Show top 20" : "Show all 100"}
            </button>
          </div>

          <div className="mini-card" style={{borderColor:"#eadfae"}}>
            <div className="mini-title">Research validity</div>
            <div style={{lineHeight:1.55}}>
              Entry = completed 15m close → next 15m open · fixed horizon = {data.rules?.fixedHorizonBars ?? 4} bars · lookahead controlled by the research engine.
              This is a research proxy using accessible public market data, not a licensed point-in-time SETSMART dataset.
            </div>
          </div>
        </>
      )}
    </div>
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
