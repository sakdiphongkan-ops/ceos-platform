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
const LUNA_PUBLIC_MARKET_STREAM =
  process.env.NEXT_PUBLIC_LUNA_PUBLIC_MARKET_STREAM_URL ??
  "wss://luna-execution-gateway-production.up.railway.app/quotes/public-stream";
const LUNA_STRATEGY = "luna-th1h-v1.4.0-15m-riskgated";
const TIMEFRAME = "15m";

type RuntimeStatus = {
  ok?: boolean;
  generated_at?: string;
  runtime?: {
    state?: string;
    system_state?: string;
    session?: { id?: string; session_date?: string; mode?: string; strategy_version?: string; status?: string };
    strategy_version?: string;
    latest_source?: string | null;
    latest_age_ms?: number | null;
    latest_tick_ts?: string | null;
    ticks_10s?: number;
    ticks_30s?: number;
    ticks_2m?: number;
    symbols_30s?: number;
    bid_ask_ticks_30s?: number;
  };
  error?: { message?: string };
};

type RealtimeQuote = {
  symbol: string;
  ts?: string;
  source_ts?: string | null;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
  source?: string | null;
};

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
  market_feed?: {
    status:string;
    verified_realtime:boolean;
    public_fallback:boolean;
    latest_source?:string|null;
    latest_ts?:string|null;
    latest_age_ms?:number|null;
    sources?:string[];
  };
  latency?: {
    summary?: {
      sample_count:number;
      market_lag_ms?:{p50:number;p95:number;p99:number;max:number};
      analysis_ms?:{p50:number;p95:number;p99:number;max:number};
      queue_wait_ms?:{p50:number;p95:number;p99:number;max:number};
      execution_ms?:{p50:number;p95:number;p99:number;max:number};
      end_to_end_ms?:{p50:number;p95:number;p99:number;max:number};
    };
  };
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

type UiMarketPhase = "PRE_OPEN" | "ACTIVE" | "BREAK" | "REDUCE_ONLY" | "FORCE_CLOSE" | "CLOSED";

const signed = (n: number) => `${n >= 0 ? "+" : "-"}฿${money(Math.abs(n))}`;

function bangkokParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday:value("weekday"), year:Number(value("year")), month:Number(value("month")), day:Number(value("day")), hour:Number(value("hour")), minute:Number(value("minute")), second:Number(value("second")) };
}
function bangkokDate(date: Date) { const p=bangkokParts(date); return `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`; }
function bangkokClock(date: Date) { const p=bangkokParts(date); return `${String(p.hour).padStart(2,"0")}:${String(p.minute).padStart(2,"0")}:${String(p.second).padStart(2,"0")}`; }
function uiMarketPhase(date: Date): UiMarketPhase {
  const p=bangkokParts(date); if(p.weekday==="Sat"||p.weekday==="Sun") return "CLOSED";
  const mins=p.hour*60+p.minute;
  if(mins<600) return "PRE_OPEN";
  if(mins<750) return "ACTIVE";
  if(mins<840) return "BREAK";
  if(mins<980) return "ACTIVE";
  if(mins<985) return "REDUCE_ONLY";
  if(mins<990) return "FORCE_CLOSE";
  return "CLOSED";
}
function marketPhaseLabel(phase:UiMarketPhase) { return ({PRE_OPEN:"PRE-OPEN",ACTIVE:"MARKET OPEN",BREAK:"MIDDAY BREAK",REDUCE_ONLY:"REDUCE ONLY",FORCE_CLOSE:"FORCE CLOSE",CLOSED:"MARKET CLOSED"})[phase]; }
function marketPhaseHint(phase:UiMarketPhase) { return ({PRE_OPEN:"Entry locked until 10:00",ACTIVE:"New entries enabled",BREAK:"Entry locked · afternoon pre-open",REDUCE_ONLY:"BUY locked · SELL allowed",FORCE_CLOSE:"Closing positions only",CLOSED:"No new execution"})[phase]; }

export default function LunaPortfolioPage() {
  const [tab,setTab]=useState<"holdings"|"trades"|"closed"|"research">("holdings");
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<Position|null>(null);
  const [feed,setFeed]=useState<LunaFeed|null>(null);
  const [loading,setLoading]=useState(true);
  const [refreshing,setRefreshing]=useState(false);
  const [filterOpen,setFilterOpen]=useState(false);
  const [signalFilter,setSignalFilter]=useState<"ALL"|"BUY"|"SELL"|"HOLD">("ALL");
  const [profitOnly,setProfitOnly]=useState(false);
  const [error,setError]=useState("");
  const [live,setLive]=useState(false);
  const [realtimeQuotes,setRealtimeQuotes]=useState<Record<string,RealtimeQuote>>({});
  const [realtimeConnected,setRealtimeConnected]=useState(false);
  const [lastRealtimeTickAt,setLastRealtimeTickAt]=useState<number|null>(null);
  const [clock,setClock]=useState(()=>new Date());
  const [runtimeStatus,setRuntimeStatus]=useState<RuntimeStatus|null>(null);

  const load=useCallback(async()=>{
    setRefreshing(true); setError("");
    try{
      const asOf=bangkokDate(new Date());
      const [feedRes,runtimeRes]=await Promise.all([
        fetch(`${LUNA_API}?limit=100&strategy=${encodeURIComponent(LUNA_STRATEGY)}&as_of=${encodeURIComponent(asOf)}`,{cache:"no-store"}),
        fetch(`${LUNA_API}?view=runtime_status&as_of=${encodeURIComponent(asOf)}`,{cache:"no-store"})
      ]);
      if(!feedRes.ok) throw new Error(`API ${feedRes.status}`);
      const data=await feedRes.json() as LunaFeed;
      const runtime=runtimeRes.ok ? await runtimeRes.json() as RuntimeStatus : {ok:false,error:{message:`Runtime API ${runtimeRes.status}`}};
      setFeed(data);
      setRuntimeStatus(runtime);
      const runtimeError=!runtimeRes.ok || runtime?.ok===false;
      if(data.errors?.length) setError("Feed returned partial data");
      else if(runtimeError) setError(runtime?.error?.message??"Runtime health check unavailable");
      setLive(true);
    }catch(e){ setLive(false); setRuntimeStatus(null); setError(e instanceof Error?e.message:"Unable to load LUNA feed"); }
    finally{
      setLoading(false);
      setRefreshing(false);
    }
  },[]);

  useEffect(()=>{ load(); const id=setInterval(load,5000); return()=>clearInterval(id); },[load]);

  useEffect(()=>{
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      try {
        socket = new WebSocket(LUNA_PUBLIC_MARKET_STREAM);
      } catch {
        setRealtimeConnected(false);
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(15000, retryMs * 2);
        return;
      }

      socket.onopen = () => {
        retryMs = 1000;
        // Connection alone is not proof of fresh market data.
        setRealtimeConnected(false);
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as {
            type?: string;
            quotes?: RealtimeQuote[];
            quote?: RealtimeQuote;
          };
          if (message.type === "snapshot" && Array.isArray(message.quotes)) {
            const next: Record<string,RealtimeQuote> = {};
            for (const quote of message.quotes) {
              if (quote?.symbol) next[quote.symbol] = quote;
            }
            setRealtimeQuotes(next);
            if (message.quotes.length) setLastRealtimeTickAt(Date.now());
          } else if (message.type === "quote" && message.quote?.symbol) {
            const quote = message.quote;
            setRealtimeQuotes((prev) => ({...prev, [quote.symbol]: quote}));
            setLastRealtimeTickAt(Date.now());
          }
        } catch {
          // Ignore malformed public-stream frames; HTTP remains the source of record.
        }
      };

      socket.onclose = () => {
        if (stopped) return;
        setRealtimeConnected(false);
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(15000, retryMs * 2);
      };

      socket.onerror = () => {
        setRealtimeConnected(false);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  },[]);

  useEffect(()=>{ const id=setInterval(()=>setClock(new Date()),1000); return()=>clearInterval(id); },[]);

  // Require an actually fresh public-stream tick before calling the UI realtime.
  useEffect(()=>{
    const id=setInterval(()=>{
      setRealtimeConnected(lastRealtimeTickAt!=null && Date.now()-lastRealtimeTickAt<=5000);
    },1000);
    return()=>clearInterval(id);
  },[lastRealtimeTickAt]);

  const marketPhase=uiMarketPhase(clock);
  const todaySessionDate=bangkokDate(clock);
  const sessions=[...(feed?.sessions??[])].sort((a,b)=>{
    const ad=new Date(a.created_at??a.started_at??a.session_date??0).getTime();
    const bd=new Date(b.created_at??b.started_at??b.session_date??0).getTime();
    return bd-ad;
  });
  const openSession=sessions.find(s=>s.status==="OPEN" && s.session_date===todaySessionDate);
  const session=openSession??sessions.find(s=>s.session_date===todaySessionDate)??sessions[0];
  const sessionIsToday=session?.session_date===todaySessionDate;
  const sessionId=sessionIsToday?session?.id:undefined;
  const sessionPositions=sessionId ? (feed?.positions??[]).filter(p=>p.session_id===sessionId) : [];
  const sessionOrders=sessionId ? (feed?.orders??[]).filter(o=>o.session_id===sessionId) : [];
  const sessionSignals=[...(feed?.signals??[])].filter(s=>sessionId && s.session_id===sessionId).sort((a,b)=>{
    return new Date(b.ts??b.created_at??0).getTime()-new Date(a.ts??a.created_at??0).getTime();
  });
  const sessionSnapshot=sessionId ? [...(feed?.snapshots??[])].filter(s=>s.session_id===sessionId).sort((a,b)=>{
    return new Date(b.ts??b.created_at??0).getTime()-new Date(a.ts??a.created_at??0).getTime();
  })[0] : undefined;
  const sessionTicks=sessionId ? (feed?.ticks??[]).filter(t=>t.session_id===sessionId) : [];

  const positions:Position[]=sessionPositions.filter(p=>Number(p.qty)>0).map(p=>{
    const realtimeTick=realtimeQuotes[p.symbol];
    const tick=realtimeTick ?? sessionTicks.find(t=>t.symbol===p.symbol);
    const signal=sessionSignals.find(s=>s.symbol===p.symbol);
    const signalTs=signal?.ts??signal?.created_at;
    const signalAgeMs=signalTs ? Math.max(0,Date.now()-Date.parse(signalTs)) : Number.POSITIVE_INFINITY;
    const signalIsCurrent=sessionIsToday && ["ACTIVE","REDUCE_ONLY","FORCE_CLOSE"].includes(marketPhase) && Number.isFinite(signalAgeMs) && signalAgeMs<=15_000;
    const last=Number(tick?.last??tick?.bid??tick?.ask??p.avg_price);
    const action=(signalIsCurrent && (signal?.action==="BUY"||signal?.action==="SELL"||signal?.action==="HOLD")) ? signal.action : "HOLD";
    return {
      symbol:p.symbol,name:p.symbol,qty:Number(p.qty),avgCost:Number(p.avg_price),last,
      dayChange:0,realized:Number(p.realized_pnl??0),signal:action,
      signalReason:signalIsCurrent ? (signal?.reason??"No current signal recorded") : marketPhaseHint(marketPhase)
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

  const filteredPositions=positions.filter(p=>{
    const matchesQuery=(p.symbol+" "+p.name).toLowerCase().includes(query.toLowerCase());
    const matchesSignal=signalFilter==="ALL" || p.signal===signalFilter;
    const matchesProfit=!profitOnly || (p.last-p.avgCost)>=0;
    return matchesQuery && matchesSignal && matchesProfit;
  });
  const filterCount=(signalFilter!=="ALL"?1:0)+(profitOnly?1:0);
  const updatedAt=feed?.generated_at ? new Date(feed.generated_at).toLocaleTimeString("en-GB",{hour12:false}) : "—";
  const initial=Number(session?.initial_capital??1000000);
  const liveMarketValue=positions.reduce((s,p)=>s+p.qty*p.last,0);
  const marketValue=positions.length ? liveMarketValue : Number(sessionSnapshot?.market_value??0);
  const cash=Number(sessionSnapshot?.cash??Math.max(0,initial-marketValue));
  const equity=cash+marketValue;
  const liveUnrealized=positions.reduce((s,p)=>s+p.qty*(p.last-p.avgCost),0);
  const unrealized=positions.length ? liveUnrealized : Number(sessionSnapshot?.unrealized_pnl??0);
  const realized=Number(sessionSnapshot?.realized_pnl??positions.reduce((s,p)=>s+p.realized,0));
  const fees=Number(sessionSnapshot?.fees??0);
  const exposure=equity?Number(sessionSnapshot?.gross_exposure??marketValue)/equity*100:0;
  const selectedPos=selected&&positions.some(p=>p.symbol===selected.symbol)?positions.find(p=>p.symbol===selected.symbol)??null:null;
  const executionMode=String(feed?.execution_control?.execution_mode??session?.mode??"paper").toUpperCase();
  const killSwitch=Boolean(feed?.execution_control?.kill_switch??true);
  const armed=Boolean(feed?.execution_control?.armed??false);
  const liveExecution=executionMode==="LIVE" && !killSwitch && armed;
  const marketFeed=feed?.market_feed??{
    status:"NO_TICKS",verified_realtime:false,public_fallback:false,latest_source:null,latest_age_ms:null,sources:[]
  };
  const marketFeedLabel=marketFeed.verified_realtime
    ? "VERIFIED REALTIME"
    : marketFeed.public_fallback
      ? "PUBLIC FALLBACK"
      : marketFeed.status==="UNVERIFIED_RECENT"
        ? "UNVERIFIED RECENT"
        : marketFeed.status==="STALE_OR_UNKNOWN"
          ? "STALE / UNKNOWN"
          : "NO MARKET TICKS";
  const marketFeedSource=marketFeed.latest_source ? String(marketFeed.latest_source) : "no source";
  const realtimeAgeMs=lastRealtimeTickAt==null ? null : Math.max(0,Date.now()-lastRealtimeTickAt);
  const realtimeFresh=realtimeAgeMs!=null && realtimeAgeMs<=5000;
  const marketFeedAge=realtimeFresh && realtimeAgeMs!=null
    ? Math.round(realtimeAgeMs) + " ms since UI tick"
    : Number.isFinite(Number(marketFeed.latest_age_ms))
      ? Math.max(0,Math.round(Number(marketFeed.latest_age_ms))) + " ms old"
      : "age unavailable";

  type RuntimeState = "ACTIVE" | "STANDBY" | "DEGRADED" | "OFFLINE";
  const backendRuntime=runtimeStatus?.runtime;
  const backendStrategy=String(backendRuntime?.strategy_version??backendRuntime?.session?.strategy_version??"");
  const strategyMismatch=Boolean(backendStrategy && backendStrategy!==LUNA_STRATEGY);
  const runtimeAgeMs=Number.isFinite(Number(backendRuntime?.latest_age_ms)) ? Math.max(0,Number(backendRuntime?.latest_age_ms)) : null;
  const backendRuntimeFresh=backendRuntime?.state==="LIVE" && runtimeAgeMs!=null && runtimeAgeMs<=5000 && Number(backendRuntime?.ticks_30s??0)>0;
  const runtimeState:RuntimeState = !live
    ? "OFFLINE"
    : error
      ? "DEGRADED"
      : backendRuntimeFresh
        ? "ACTIVE"
        : backendRuntime?.state==="NO_OPEN_SESSION" || !backendRuntime?.session
          ? "STANDBY"
          : "DEGRADED";

  const runtimeLabel = ({
    ACTIVE:"SYSTEM ACTIVE · PAPER RUNTIME",
    STANDBY:"SYSTEM ONLINE · STANDBY",
    DEGRADED:"SYSTEM DEGRADED",
    OFFLINE:"SYSTEM OFFLINE"
  } as const)[runtimeState];

  const runtimeDetail = runtimeState==="ACTIVE"
    ? strategyMismatch
      ? `Server runtime is active and ingesting market data, but the active runtime strategy is ${backendStrategy}; the control panel is scoped to ${LUNA_STRATEGY}. This is a strategy-alignment warning, not an API outage.`
      : `Server runtime is active · fresh backend ticks are arriving every cycle · latest source ${backendRuntime?.latest_source??"unknown"}.`
    : runtimeState==="DEGRADED"
      ? backendRuntime?.state==="LIVE" && runtimeAgeMs!=null
        ? `Server runtime exists, but the latest backend tick is ${Math.round(runtimeAgeMs)} ms old. Treat the feed as degraded until freshness recovers.`
        : "API is reachable, but the runtime health check is not yet healthy. Review the control room before assuming execution readiness."
      : runtimeState==="STANDBY"
        ? (marketPhase==="ACTIVE" || marketPhase==="REDUCE_ONLY" || marketPhase==="FORCE_CLOSE")
          ? "API is healthy, but there is no active server session. This is standby, not an API outage."
          : "API is healthy and ready. No trading session is running because the market is outside the execution window."
        : "The LUNA API could not be reached. This is the only state shown as OFFLINE.";

  const runtimeShort = ({
    ACTIVE:"ACTIVE",
    STANDBY:"STANDBY",
    DEGRADED:"CHECK",
    OFFLINE:"OFFLINE"
  } as const)[runtimeState];

  return <main className="luna-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">L</div><div><div className="eyebrow">LUNA-TH1H</div><h1>Control Room</h1></div></div>
      <nav className="top-nav" aria-label="LUNA workspace">
        <button className={tab==="holdings"?"active":""} onClick={()=>setTab("holdings")}>Overview</button>
        <button className={tab==="trades"?"active":""} onClick={()=>setTab("trades")}>Trades</button>
        <button className={tab==="closed"?"active":""} onClick={()=>setTab("closed")}>Closed</button>
        <button className={tab==="research"?"active":""} onClick={()=>setTab("research")}>Research</button>
      </nav>
      <div className="top-actions">
        <div className={`market-status phase-${marketPhase.toLowerCase()}`}><CircleDot size={11}/> SET · {marketPhaseLabel(marketPhase)}</div><div className="timeframe-chip"><BarChart3 size={13}/> {TIMEFRAME}</div>
        <button className={"icon-button "+(refreshing?"refreshing":"")} title={refreshing?"Refreshing LUNA feed…":"Refresh LUNA feed"} aria-label={refreshing?"Refreshing LUNA feed":"Refresh LUNA feed"} onClick={load} disabled={refreshing}><RefreshCw size={17}/><span className="refresh-label">{refreshing?"Refreshing":"Refresh"}</span></button>
        <div className={`session-chip session-runtime-${runtimeState.toLowerCase()}`}><Clock3 size={14}/> {todaySessionDate} · {bangkokClock(clock)} · {runtimeState==="ACTIVE" ? (realtimeFresh ? "SYSTEM ACTIVE · UI REALTIME" : "SYSTEM ACTIVE · SERVER") : runtimeState==="STANDBY" ? "ONLINE · STANDBY" : runtimeState==="DEGRADED" ? "ONLINE · CHECK" : "OFFLINE"}</div>
      </div>
    </header>
    <div className="page">
      <section className="hero-row"><div><div className="eyebrow">INTRADAY CONTROL · OPERATIONAL OVERVIEW</div><h2>LUNA command center</h2><p>See capital, risk, execution and research state at a glance.</p></div><div className="hero-meta"><div className={`data-chip runtime-chip runtime-${runtimeState.toLowerCase()}`}><span className="data-dot"/>{runtimeLabel}</div><div className="safe-badge"><ShieldCheck size={15}/> {liveExecution ? "LIVE EXECUTION" : "PAPER EXECUTION"} / {killSwitch ? "KILL SWITCH ON" : liveExecution && marketPhase==="ACTIVE" ? "GATE OPEN" : "MARKET LOCKED"}</div></div></section>
      <section className={`runtime-banner runtime-${runtimeState.toLowerCase()}`} aria-live="polite">
        <div className="runtime-banner-icon"><CircleDot size={15}/></div>
        <div className="runtime-banner-copy"><strong>{runtimeLabel}</strong><span>{runtimeDetail}</span></div>
        <div className="runtime-banner-meta"><span>API {live ? "CONNECTED" : "UNREACHABLE"}</span><span>BACKEND {backendRuntime?.state??"UNKNOWN"}</span><span>LAST TICK {runtimeAgeMs!=null ? Math.round(runtimeAgeMs)+" ms" : "—"}</span></div>
      </section>
      <SystemControlRoom strategy={session?.strategy_version ?? LUNA_STRATEGY} asOf={todaySessionDate} />
      <section className="live-operating-strip">
        <div className={`market-phase-cell phase-${marketPhase.toLowerCase()}`}><span>MARKET / SET</span><strong>{marketPhaseLabel(marketPhase)}</strong><small>{bangkokClock(clock)} · {marketPhaseHint(marketPhase)}</small></div>
        <div><span>EXECUTION MODE</span><strong>{executionMode}</strong><small>{liveExecution ? "live gate open" : "paper only"}</small></div>
        <div><span>KILL SWITCH</span><strong>{killSwitch ? "ON" : "OFF"}</strong><small>{armed ? "armed" : "disarmed"}</small></div>
        <div><span>RUNTIME</span><strong>{runtimeShort}</strong><small>{sessionIsToday ? "today's session detected" : "no open session today"}</small></div>
        <div><span>LIVE ORDER GATE</span><strong>{liveExecution ? "READY" : "LOCKED"}</strong><small>broker bridge status</small></div>
        <div><span>MARKET FEED</span><strong>{realtimeFresh ? "REALTIME STREAM" : realtimeAgeMs!=null ? "STREAM STALE" : marketFeedLabel}</strong><small>{realtimeFresh ? "public WS · " + marketFeedAge : realtimeAgeMs!=null ? "last UI tick · " + marketFeedAge : marketFeedSource + " · " + marketFeedAge}</small></div><div className="live-operating-note"><ShieldCheck size={15}/><span>{marketPhase==="ACTIVE" ? "Market session active — backend re-checks phase immediately before every execution." : "Market execution is locked at this phase; stale signals are shown as HOLD until a fresh in-session signal arrives."}</span></div>
      </section>
      {error&&<div className="error-banner"><span>{error}</span><button onClick={load}>Retry</button></div>}
      <section className="summary-grid"><Metric label="Market ticks" value={String(sessionTicks.length)} sub="Latest session feed"/><Metric label="Signals" value={String(sessionSignals.length)} sub="15m strategy signals"/><Metric label="Orders" value={String(sessionOrders.length)} sub="Recorded this session"/>
        <Metric label="Total Equity" value={`฿${money(equity)}`} sub={`Initial ฿${money(initial)}`} positive={equity>=initial}/>
        <Metric label="Market Value" value={`฿${money(marketValue)}`} sub={`${exposure.toFixed(1)}% exposure`}/>
        <Metric label="Cash" value={`฿${money(cash)}`} sub="Available cash"/>
        <Metric label="Unrealized P&L" value={signed(unrealized)} sub="Current open positions" positive={unrealized>=0}/>
        <Metric label="Realized P&L" value={signed(realized)} sub="Closed / executed" positive={realized>=0}/>
        <Metric label="Fees" value={`-฿${money(fees)}`} sub="Recorded execution cost"/>
        <LatencyMetric label="Latency p95" metric={feed?.latency?.summary?.end_to_end_ms?.p95} sampleCount={feed?.latency?.summary?.sample_count??0} sub="real executions"/>
        <LatencyMetric label="Latency p99" metric={feed?.latency?.summary?.end_to_end_ms?.p99} sampleCount={feed?.latency?.summary?.sample_count??0} sub={feed?.latency?.summary?.queue_wait_ms?.p95 != null ? "queue p95 " + feed.latency.summary.queue_wait_ms.p95.toFixed(1) + " ms" : "queue p95 not measured"}/>
      </section>
      <section className="content-grid">
        <div className="main-card">
          <div className="card-head"><div><div className="card-title">Portfolio positions</div><div className="card-subtitle">{positions.length} open positions · {filteredPositions.length} visible · dynamic sizing from signal strength</div></div><div className="toolbar">
  <div className="search-box"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search symbol"/></div>
  <div className="filter-wrap">
    <button className={"filter-button "+(filterCount?"filter-active":"")} onClick={()=>setFilterOpen(v=>!v)} aria-expanded={filterOpen}>
      <Filter size={15}/> Filter {filterCount ? "· "+filterCount : ""} <ChevronDown size={13}/>
    </button>
    {filterOpen&&<div className="filter-menu">
      <div className="filter-menu-label">SIGNAL</div>
      <div className="filter-options">
        {(["ALL","BUY","SELL","HOLD"] as const).map(option=><button key={option} className={signalFilter===option?"selected":""} onClick={()=>setSignalFilter(option)}>{option}</button>)}
      </div>
      <button className={"filter-check "+(profitOnly?"selected":"")} onClick={()=>setProfitOnly(v=>!v)}>
        <span className="filter-check-box">{profitOnly?"✓":""}</span> Profit only
      </button>
      <div className="filter-menu-footer"><span>{filteredPositions.length} positions</span><button onClick={()=>{setSignalFilter("ALL");setProfitOnly(false);}}>Clear</button></div>
    </div>}
  </div>
</div></div>
          <div className="tabs"><button className={tab==="holdings"?"active":""} onClick={()=>setTab("holdings")}>Holdings <span>{positions.length}</span></button><button className={tab==="trades"?"active":""} onClick={()=>setTab("trades")}>Today's Trades <span>{trades.length}</span></button><button className={tab==="closed"?"active":""} onClick={()=>setTab("closed")}>Closed Positions <span>{closedPositions.length}</span></button><button className={tab==="research"?"active":""} onClick={()=>setTab("research")}>Research <span>WF</span></button></div>
          {loading&&!feed?<div className="loading-state"><RefreshCw size={18}/> Loading live portfolio feed…</div>:
          tab==="holdings"?<div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>QTY</th><th>AVG COST</th><th>LAST</th><th>MARKET VALUE</th><th>UNREALIZED P&amp;L</th><th>WEIGHT</th><th>SIGNAL</th></tr></thead><tbody>{filteredPositions.length?filteredPositions.map(p=>{const value=p.qty*p.last;const weight=equity?value/equity*100:0;const pnl=p.qty*(p.last-p.avgCost);return <tr key={p.symbol} className={selectedPos?.symbol===p.symbol?"selected-row":""} onClick={()=>setSelected(p)}><td><div className="symbol-cell"><strong>{p.symbol}</strong><span>{p.name}</span></div></td><td>{money(p.qty).replace(".00","")}</td><td>฿{p.avgCost.toFixed(2)}</td><td><strong>฿{p.last.toFixed(2)}</strong></td><td>฿{money(value)}</td><td className={pnl>=0?"positive":"negative"}>{signed(pnl)}</td><td><div className="weight-cell"><span>{weight.toFixed(1)}%</span><i><b style={{width:`${Math.min(weight,100)}%`}}/></i></div></td><td><SignalBadge signal={p.signal}/></td></tr>;}):<tr><td colSpan={8} className="empty-table"><div>{sessionIsToday ? "No open positions currently — positions are removed from Holdings after execution closes them." : `No current trading session yet for ${todaySessionDate}. LUNA is ${marketPhaseLabel(marketPhase).toLowerCase()} and execution is locked.`}</div>{trades.length>0&&<button className="filter-button" style={{marginTop:8}} onClick={()=>setTab("trades")}>View today\'s executed trades ({trades.length})</button>}</td></tr>}</tbody></table></div>:
          tab==="research"?<ResearchPanel/>:tab==="trades"?<div className="table-wrap"><table><thead><tr><th>TIME</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>VALUE</th><th>STATUS</th><th>STRATEGY</th></tr></thead><tbody>{trades.length?trades.map(t=><tr key={`${t.time}-${t.symbol}-${t.qty}`}><td className="muted">{t.time}</td><td><strong>{t.symbol}</strong></td><td><SideBadge side={t.side}/></td><td>{money(t.qty).replace(".00","")}</td><td>฿{t.price.toFixed(2)}</td><td>฿{money(t.value)}</td><td><StatusBadge status={t.status}/></td><td className="muted">{t.strategy}</td></tr>):<tr><td colSpan={8} className="empty-table">No orders recorded for this session.</td></tr>}</tbody></table></div>:
          <div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>REALIZED P&amp;L</th><th>HOLD TIME</th></tr></thead><tbody>{closedPositions.length?closedPositions.map(p=><tr key={p.symbol}><td><strong>{p.symbol}</strong></td><td>฿{p.entry.toFixed(2)}</td><td>฿{p.exit.toFixed(2)}</td><td>{money(p.qty).replace(".00","")}</td><td className={p.pnl>=0?"positive":"negative"}>{signed(p.pnl)}</td><td className="muted">{p.duration}</td></tr>):<tr><td colSpan={6} className="empty-table">No closed positions reconstructed from fills.</td></tr>}</tbody></table></div>}
        </div>
        <aside className="side-card">{selectedPos?<><div className="detail-head"><div><div className="detail-symbol">{selectedPos.symbol}</div><div className="muted">{selectedPos.name}</div></div><button className="close-button" onClick={()=>setSelected(null)}><X size={15}/></button></div><div className="price-block"><div>฿{selectedPos.last.toFixed(2)}</div><span className={selectedPos.last>=selectedPos.avgCost?"positive":"negative"}>{selectedPos.last>=selectedPos.avgCost?<ArrowUpRight size={14}/>:<ArrowDownRight size={14}/>} {((selectedPos.last/selectedPos.avgCost-1)*100).toFixed(2)}%</span></div><div className="detail-grid"><Detail label="Position" value={`${money(selectedPos.qty).replace(".00","")} shares`}/><Detail label="Avg Cost" value={`฿${selectedPos.avgCost.toFixed(2)}`}/><Detail label="Market Value" value={`฿${money(selectedPos.qty*selectedPos.last)}`}/><Detail label="Unrealized P&L" value={signed(selectedPos.qty*(selectedPos.last-selectedPos.avgCost))} positive={selectedPos.last>=selectedPos.avgCost}/><Detail label="Portfolio Weight" value={`${(equity?(selectedPos.qty*selectedPos.last/equity*100):0).toFixed(1)}%`}/><Detail label="Sizing" value="Dynamic · signal strength"/></div><div className="section-label">CURRENT SIGNAL</div><div className="signal-panel"><SignalBadge signal={selectedPos.signal} large/><p>{selectedPos.signalReason}</p></div><div className="section-label">EXECUTION TIMELINE</div><div className="timeline">{trades.filter(t=>t.symbol===selectedPos.symbol).map(t=><div className="timeline-item" key={t.time}><div className={`timeline-dot ${t.side.toLowerCase()}`}/><div><strong>{t.side} {money(t.qty).replace(".00","")} @ ฿{t.price.toFixed(2)}</strong><span>{t.time} · {t.reason}</span></div></div>)}<div className="timeline-item future"><div className="timeline-dot"/><div><strong>Position currently open</strong><span>Latest feed mark</span></div></div></div><div className="audit-strip"><Layers3 size={15}/><span>Execution → Position → Snapshot → Audit event</span></div></>:<div className="empty-detail"><strong>Select a position</strong><span>Click any holding to inspect its live execution history.</span></div>}</aside>
      </section>
      <section className="bottom-grid"><div className="mini-card"><div className="mini-title"><BarChart3 size={16}/> Exposure by position</div><div className="bars">{positions.map(p=><div className="bar-row" key={p.symbol}><span>{p.symbol}</span><i><b style={{width:`${Math.min((equity?(p.qty*p.last/equity*100):0)*5,100)}%`}}/></i><strong>{(equity?p.qty*p.last/equity*100:0).toFixed(1)}%</strong></div>)}</div></div><div className="mini-card"><div className="mini-title"><History size={16}/> Session controls</div><div className="control-list"><div><span>Strategy</span><strong>{session?.strategy_version??"—"}</strong></div><div><span>Initial capital</span><strong>฿{money(initial)}</strong></div><div><span>Gross exposure</span><strong>{exposure.toFixed(1)}% / 100%</strong></div><div><span>End of day</span><strong>FORCE CLOSE</strong></div></div><div className={`live-toggle ${live ? "on" : "off"}`}><CircleDot size={13}/>{live ? `API connected · feed: ${marketFeedLabel}` : "Feed unavailable"}</div></div><div className="mini-card"><div className="mini-title"><WalletCards size={16}/> Audit integrity</div><div className="audit-score"><strong>{feed?.counts?.audits?"READY":"WAITING"}</strong><span>{feed?.counts?.audits??0} audit events · {feed?.counts?.fills??0} fills · {feed?.counts?.snapshots??0} snapshots</span></div><div className="hash-line">universe loaded · quote coverage tracked · real latency ledger · API-backed</div></div></section>
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

function LatencyMetric({label,metric,sampleCount,sub}:{label:string;metric?:number;sampleCount:number;sub:string}){
  const measured=sampleCount>0 && Number.isFinite(metric);
  return <Metric label={label} value={measured ? metric!.toFixed(1)+" ms" : "NOT MEASURED"} sub={measured ? "n="+sampleCount+" · "+sub : "n=0 · "+sub} />;
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
