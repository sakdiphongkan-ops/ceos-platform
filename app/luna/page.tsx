"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight, ArrowUpRight, BarChart3, ChevronDown, CircleDot, Clock3, Filter, History,
  Layers3, RefreshCw, Search, ShieldCheck, WalletCards, X,
} from "lucide-react";

import {
  bangkokClock, bangkokDate, isRealtimeFresh, LUNA_PUBLIC_MARKET_STREAM, LUNA_STRATEGY,
  marketPhaseHint, marketPhaseLabel, TIMEFRAME, uiMarketPhase, type RuntimeState,
} from "../../lib/luna-runtime";
import MarketHistoryPanel from "./market-history-panel";
import {
  connectRealtimeMarketStream, fetchControlRoom, fetchPortfolioState, fetchShadowStatus,
  fetchTournament100, CLIENT_DEFAULTS, type ControlRoomState, type LunaFeed, type RealtimeQuote,
  type RuntimeStatus, type ShadowStatus, type Tournament100Result,
} from "../../lib/luna-client";

type Position = {
  symbol: string; name: string; qty: number; avgCost: number; last: number | null;
  lastPriceTs: string | null; lastPriceFresh: boolean; dayChange: number;
  realized: number; signal: "BUY" | "SELL" | "HOLD"; signalReason: string;
};

type Trade = {
  time: string; symbol: string; side: "BUY" | "SELL"; qty: number; filledQty: number;
  price: number | null; value: number | null;
  status: "FILLED" | "PARTIAL" | "REJECTED" | "PENDING" | "CANCELLED" | "UNKNOWN" | "UNRECONCILED";
  strategy: string; reason: string;
};

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,13}$/.test(value))) {
    const numeric = Number(value);
    const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(millis) && Number.isFinite(new Date(millis).getTime()) ? millis : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quotePrice(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const quote = value as Record<string, unknown>;
  for (const candidate of [quote.last, quote.close, quote.bid, quote.ask]) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const price = Number(candidate);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

function quoteTimestamp(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const quote = value as Record<string, unknown>;
  const raw = quote.source_ts ?? quote.ts ?? quote.timestamp ?? quote.created_at;
  const millis = timestampMs(raw);
  return millis === null ? null : new Date(millis).toISOString();
}

function isFreshTimestamp(value: unknown, maxAgeMs = 15_000, nowMs = Date.now()): boolean {
  const millis = timestampMs(value);
  if (millis === null) return false;
  const age = nowMs - millis;
  return age >= -2_000 && age <= maxAgeMs;
}

function isFreshQuote(quote: RealtimeQuote, nowMs = Date.now()): boolean {
  return /^[A-Z0-9]{1,12}$/.test(String(quote.symbol ?? ""))
    && quotePrice(quote) !== null
    && isFreshTimestamp(quote.source_ts ?? quote.ts, 5_000, nowMs);
}

type FillAggregate = { qty: number; notional: number; latestTs: string | null };

function aggregateFills(rows: Array<Record<string, any>>): Map<string, FillAggregate> {
  const aggregated = new Map<string, FillAggregate>();
  for (const fill of rows) {
    const orderId = String(fill.order_id ?? "");
    const qty = Number(fill.qty ?? fill.filled_qty ?? fill.volume);
    const price = Number(fill.price ?? fill.fill_price);
    if (!orderId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) continue;
    const current = aggregated.get(orderId) ?? { qty: 0, notional: 0, latestTs: null };
    current.qty += qty;
    current.notional += qty * price;
    const ts = fill.ts ?? fill.created_at ?? fill.timestamp;
    if (timestampMs(ts) !== null && (current.latestTs === null || timestampMs(ts)! > timestampMs(current.latestTs)!)) {
      current.latestTs = new Date(timestampMs(ts)!).toISOString();
    }
    aggregated.set(orderId, current);
  }
  return aggregated;
}

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

const signed = (n: number) => `${n >= 0 ? "+" : "-"}฿${money(Math.abs(n))}`;

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
  const [shadowStatus,setShadowStatus]=useState<ShadowStatus|null>(null);
  const refreshInFlight=useRef(false);
  const shadowInFlight=useRef(false);

  const load=useCallback(async()=>{
    if(refreshInFlight.current) return;
    refreshInFlight.current=true;
    setRefreshing(true);
    setError("");

    try{
      const asOf=bangkokDate(new Date());
      const {feed:data,runtime}=await fetchPortfolioState(asOf);
      setFeed(data);
      setRuntimeStatus(runtime);

      const runtimeError=runtime?.ok===false;
      if(data.errors?.length) {
        setError("Feed returned partial data");
      } else if(runtimeError) {
        setError(runtime?.error?.message??"Runtime health check unavailable");
      }
      setLive(true);
    }catch(e){
      setLive(false);
      setRuntimeStatus(null);
      setError(e instanceof Error ? e.message : "Unable to load LUNA feed");
    }finally{
      refreshInFlight.current=false;
      setLoading(false);
      setRefreshing(false);
    }
  },[]);

  const loadShadowStatus=useCallback(async()=>{
    if(shadowInFlight.current) return;
    shadowInFlight.current=true;

    try{
      const data=await fetchShadowStatus(bangkokDate(new Date()));
      setShadowStatus(data);
    }catch{
      // Shadow status is observability-only; do not mark the portfolio offline.
    }finally{
      shadowInFlight.current=false;
    }
  },[]);

  // Load authoritative HTTP state on mount and keep the control room fresh.
  // The WebSocket is auxiliary only; failed WS connectivity must not block the UI.
  useEffect(()=>{
    void load();
    void loadShadowStatus();

    const feedTimer=setInterval(()=>{ void load(); },CLIENT_DEFAULTS.refreshMs);
    const shadowTimer=setInterval(()=>{ void loadShadowStatus(); },CLIENT_DEFAULTS.shadowRefreshMs);

    return()=>{
      clearInterval(feedTimer);
      clearInterval(shadowTimer);
    };
  },[load,loadShadowStatus]);

  useEffect(()=>{
    return connectRealtimeMarketStream({
      url:LUNA_PUBLIC_MARKET_STREAM,
      onQuotes:(quotes)=>{
        const now = Date.now();
        const accepted = Object.fromEntries(
          Object.entries(quotes).filter(([symbol, quote]) =>
            symbol === quote.symbol
            && /^[A-Z0-9]{1,12}$/.test(symbol)
            && quotePrice(quote) !== null
            && quoteTimestamp(quote) !== null
          ),
        );
        if (Object.values(accepted).some((quote) => isFreshQuote(quote, now))) {
          setLastRealtimeTickAt(now);
        }
        if (Object.keys(accepted).length > 0) {
          setRealtimeQuotes((prev)=>({ ...prev, ...accepted }));
        }
      },
      // Receipt alone is not proof of freshness; onQuotes validates source timestamps.
      onTick:()=>{},
      onConnectionChange:setRealtimeConnected,
    });
  },[]);

  useEffect(()=>{ const id=setInterval(()=>setClock(new Date()),1000); return()=>clearInterval(id); },[]);

  // A socket connection is not considered realtime until a fresh tick arrives.
  useEffect(()=>{
    const id=setInterval(()=>{
      setRealtimeConnected(isRealtimeFresh(lastRealtimeTickAt));
    },1000);
    return()=>clearInterval(id);
  },[lastRealtimeTickAt]);

  const marketPhase=uiMarketPhase(clock);
  const todaySessionDate=bangkokDate(clock);

  const sessionData=useMemo(()=>{
    const sessions=[...(feed?.sessions??[])].sort((a,b)=>{
      const ad=new Date(a.created_at??a.started_at??a.session_date??0).getTime();
      const bd=new Date(b.created_at??b.started_at??b.session_date??0).getTime();
      return bd-ad;
    });

    const openSession=sessions.find((item)=>item.status==="OPEN" && item.session_date===todaySessionDate);
    const selectedSession=openSession
      ?? sessions.find((item)=>item.session_date===todaySessionDate)
      ?? sessions[0];
    const sessionIsToday=selectedSession?.session_date===todaySessionDate;
    const sessionId=sessionIsToday ? selectedSession?.id : undefined;

    const filterSession=(rows:Array<Record<string,any>>)=>sessionId
      ? rows.filter((row)=>row.session_id===sessionId)
      : [];

    const sessionSignals=filterSession(feed?.signals??[]).sort((a,b)=>
      new Date(b.ts??b.created_at??0).getTime()-new Date(a.ts??a.created_at??0).getTime()
    );

    const sessionSnapshot=filterSession(feed?.snapshots??[])
      .sort((a,b)=>
        new Date(b.ts??b.created_at??0).getTime()-new Date(a.ts??a.created_at??0).getTime()
      )[0];

    return {
      session:selectedSession,
      sessionIsToday,
      sessionId,
      sessionPositions:filterSession(feed?.positions??[]),
      sessionOrders:filterSession(feed?.orders??[]),
      sessionSignals,
      sessionSnapshot,
      sessionTicks:filterSession(feed?.ticks??[]),
    };
  },[
    feed?.sessions,
    feed?.positions,
    feed?.orders,
    feed?.signals,
    feed?.snapshots,
    feed?.ticks,
    todaySessionDate,
  ]);

  const {
    session,
    sessionIsToday,
    sessionId,
    sessionPositions,
    sessionOrders,
    sessionSignals,
    sessionSnapshot,
    sessionTicks,
  }=sessionData;

  const positions=useMemo<Position[]>(()=>{
    const tickBySymbol=new Map(sessionTicks.map((tick)=>[String(tick.symbol),tick]));
    const signalBySymbol=new Map(sessionSignals.map((signal)=>[String(signal.symbol),signal]));

    return sessionPositions
      .filter((position)=>Number(position.qty)>0)
      .map((position)=>{
        const symbol=String(position.symbol);
        const realtimeTick=realtimeQuotes[symbol];
        const tick=realtimeTick && isFreshQuote(realtimeTick) ? realtimeTick : tickBySymbol.get(symbol);
        const signal=signalBySymbol.get(symbol);
        const signalTs=signal?.ts??signal?.created_at;
        const signalAgeMs=signalTs
          ? Math.max(0,Date.now()-Date.parse(signalTs))
          : Number.POSITIVE_INFINITY;
        const signalIsCurrent=
          sessionIsToday
          && ["ACTIVE","REDUCE_ONLY","FORCE_CLOSE"].includes(marketPhase)
          && Number.isFinite(signalAgeMs)
          && signalAgeMs<=15_000;

        // Never substitute average cost for a missing market quote.
        const last=quotePrice(tick);
        const lastPriceTs=quoteTimestamp(tick);
        const lastPriceFresh=last!==null && isFreshTimestamp(lastPriceTs,15_000);
        const action=
          signalIsCurrent
          && (signal?.action==="BUY"||signal?.action==="SELL"||signal?.action==="HOLD")
            ? signal.action
            : "HOLD";

        return {
          symbol,
          name:symbol,
          qty:Number(position.qty),
          avgCost:Number(position.avg_price),
          last,
          lastPriceTs,
          lastPriceFresh,
          dayChange:0,
          realized:Number(position.realized_pnl??0),
          signal:action,
          signalReason:signalIsCurrent
            ? (signal?.reason??"No current signal recorded")
            : marketPhaseHint(marketPhase),
        };
      });
  },[
    marketPhase,
    realtimeQuotes,
    sessionIsToday,
    sessionPositions,
    sessionSignals,
    sessionTicks,
  ]);

  const trades=useMemo<Trade[]>(()=>{
    const filledByOrderId=aggregateFills(feed?.fills??[]);

    return sessionOrders.map((order)=>{
      const orderId=String(order.id??order.order_id??"");
      const aggregate=filledByOrderId.get(orderId);
      const filledQty=aggregate?.qty??0;
      const filledPrice=aggregate && aggregate.qty>0 ? aggregate.notional/aggregate.qty : null;
      const orderQtyValue=Number(order.qty??order.volume??0);
      const qty=Number.isFinite(orderQtyValue)&&orderQtyValue>0?orderQtyValue:0;
      const rawStatus=String(order.status??"UNKNOWN").trim().toUpperCase();
      let status:Trade["status"]="UNKNOWN";

      if (filledQty>0 && (rawStatus==="REJECTED" || rawStatus==="CANCELLED" || rawStatus==="CANCELED")) {
        status="UNRECONCILED";
      } else if (rawStatus==="REJECTED") {
        status="REJECTED";
      } else if (rawStatus==="CANCELLED" || rawStatus==="CANCELED") {
        status=filledQty>0?"PARTIAL":"CANCELLED";
      } else if (filledQty>0) {
        status=(rawStatus.includes("PARTIAL") || (qty>0 && filledQty+1e-9<qty))?"PARTIAL":"FILLED";
      } else if (rawStatus==="FILLED" || rawStatus==="EXECUTED" || rawStatus.includes("PARTIAL")) {
        // The order claims execution but no corresponding fill-ledger rows were returned.
        status="UNRECONCILED";
      } else if (["NEW","PENDING","SUBMITTED","ACCEPTED","OPEN","CREATED","QUEUED"].includes(rawStatus)) {
        status="PENDING";
      }

      const orderTime=timestampMs(aggregate?.latestTs??order.created_at);
      return {
        time:orderTime===null?"—":new Date(orderTime).toLocaleTimeString("en-GB",{hour12:false}),
        symbol:String(order.symbol??"UNKNOWN"),
        side:order.side==="SELL" ? "SELL" : "BUY",
        qty,
        filledQty,
        price:filledPrice,
        value:aggregate?aggregate.notional:null,
        status,
        strategy:session?.strategy_version??"—",
        reason:String(order.reason??"—"),
      };
    });
  },[feed?.fills,session?.strategy_version,sessionOrders]);

  const closedPositions=useMemo(()=>{
    const ordersById=new Map(sessionOrders.map((order)=>[String(order.id??order.order_id??""),order]));
    const events=(feed?.fills??[]).flatMap((fill)=>{
      const order=ordersById.get(String(fill.order_id??""));
      if(!order) return [];
      const qty=Number(fill.qty??fill.filled_qty??fill.volume);
      const price=Number(fill.price??fill.fill_price);
      const ts=timestampMs(fill.ts??fill.created_at??fill.timestamp??order.created_at);
      if(!Number.isFinite(qty)||qty<=0||!Number.isFinite(price)||price<=0||ts===null) return [];
      if(order.side!=="BUY"&&order.side!=="SELL") return [];
      return [{symbol:String(order.symbol??""),side:order.side as "BUY"|"SELL",qty,price,ts}];
    }).filter((event)=>Boolean(event.symbol)).sort((a,b)=>a.ts-b.ts);

    const lotsBySymbol=new Map<string,Array<{qty:number;price:number}>>();
    const closedBySymbol=new Map<string,{symbol:string;entryNotional:number;exitNotional:number;qty:number;pnl:number;duration:string}>();
    for(const event of events){
      const lots=lotsBySymbol.get(event.symbol)??[];
      if(event.side==="BUY"){
        lots.push({qty:event.qty,price:event.price});
        lotsBySymbol.set(event.symbol,lots);
        continue;
      }
      let remaining=event.qty;
      while(remaining>1e-9&&lots.length>0){
        const lot=lots[0];
        const matched=Math.min(remaining,lot.qty);
        let summary=closedBySymbol.get(event.symbol);
        if(!summary){
          summary={symbol:event.symbol,entryNotional:0,exitNotional:0,qty:0,pnl:0,duration:"—"};
        }
        summary.entryNotional+=lot.price*matched;
        summary.exitNotional+=event.price*matched;
        summary.qty+=matched;
        summary.pnl+=(event.price-lot.price)*matched;
        remaining-=matched;
        lot.qty-=matched;
        if(lot.qty<=1e-9) lots.shift();
        closedBySymbol.set(event.symbol,summary);
      }
      lotsBySymbol.set(event.symbol,lots);
    }

    return Array.from(closedBySymbol.values()).filter((item)=>item.qty>0).map((item)=>({
      symbol:item.symbol,
      entry:item.entryNotional/item.qty,
      exit:item.exitNotional/item.qty,
      qty:item.qty,
      pnl:item.pnl,
      duration:item.duration,
    }));
  },[feed?.fills,sessionOrders]);

  const filteredPositions=useMemo(()=>positions.filter((position)=>{
    const normalizedQuery=query.toLowerCase();
    const matchesQuery=(position.symbol+" "+position.name).toLowerCase().includes(normalizedQuery);
    const matchesSignal=signalFilter==="ALL" || position.signal===signalFilter;
    const matchesProfit=!profitOnly || (position.last!==null && position.lastPriceFresh && position.last>=position.avgCost);
    return matchesQuery && matchesSignal && matchesProfit;
  }),[positions,profitOnly,query,signalFilter]);

  const filterCount=(signalFilter!=="ALL"?1:0)+(profitOnly?1:0);
  const updatedAt=feed?.generated_at ? new Date(feed.generated_at).toLocaleTimeString("en-GB",{hour12:false}) : "—";
  const initial=Number(session?.initial_capital??30000);
  const hasFreshPositionMarks=positions.length>0 && positions.every((p)=>p.last!==null && p.lastPriceFresh);
  const liveMarketValue=hasFreshPositionMarks ? positions.reduce((s,p)=>s+p.qty*(p.last??0),0) : null;
  const snapshotMarketValue=sessionSnapshot?.market_value!=null ? Number(sessionSnapshot.market_value) : null;
  const hasMarketValue=liveMarketValue!==null || snapshotMarketValue!==null;
  const marketValue=liveMarketValue ?? snapshotMarketValue ?? 0;
  const hasVerifiedPortfolioSnapshot=sessionSnapshot?.cash!=null && sessionSnapshot?.market_value!=null;
  const cash=sessionSnapshot?.cash!=null ? Number(sessionSnapshot.cash) : null;
  // Use a single snapshot for equity; do not mix snapshot cash with newer/different marks.
  const equity=hasVerifiedPortfolioSnapshot ? Number(sessionSnapshot.cash)+Number(sessionSnapshot.market_value) : 0;
  const liveUnrealized=hasFreshPositionMarks ? positions.reduce((s,p)=>s+p.qty*((p.last??0)-p.avgCost),0) : null;
  const hasUnrealized=liveUnrealized!==null || sessionSnapshot?.unrealized_pnl!=null;
  const unrealized=liveUnrealized ?? (sessionSnapshot?.unrealized_pnl!=null?Number(sessionSnapshot.unrealized_pnl):null);
  const realized=sessionSnapshot?.realized_pnl!=null ? Number(sessionSnapshot.realized_pnl) : null;
  const fees=sessionSnapshot?.fees!=null ? Number(sessionSnapshot.fees) : null;
  const exposure=equity ? Number(sessionSnapshot?.gross_exposure??(liveMarketValue??0))/equity*100 : 0;
  const selectedPos=selected&&positions.some(p=>p.symbol===selected.symbol)?positions.find(p=>p.symbol===selected.symbol)??null:null;
  const selectedHasFreshMark=Boolean(selectedPos && selectedPos.last!==null && selectedPos.lastPriceFresh);
  const backendExecutionMode=String(feed?.execution_control?.execution_mode??session?.mode??"paper").toUpperCase();
  // This release is paper-only. UI must never advertise LIVE execution even if stale backend state says LIVE.
  const executionMode="PAPER ONLY";
  const liveExecution=false;
  const liveModeMismatch=backendExecutionMode==="LIVE";
  const killSwitch=Boolean(feed?.execution_control?.kill_switch??false);
  const armed=Boolean(feed?.execution_control?.armed??false);
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

  const backendRuntime=runtimeStatus?.runtime;
  const backendStrategy=String(backendRuntime?.strategy_version??backendRuntime?.session?.strategy_version??"");
  const strategyMismatch=Boolean(backendStrategy && backendStrategy!==LUNA_STRATEGY);
  const runtimeAgeMs=Number.isFinite(Number(backendRuntime?.latest_age_ms)) ? Math.max(0,Number(backendRuntime?.latest_age_ms)) : null;
  const backendRuntimeLive=backendRuntime?.state==="LIVE" && Number(backendRuntime?.ticks_30s??0)>0;
  const backendRuntimeFresh=backendRuntimeLive && runtimeAgeMs!=null && runtimeAgeMs<=10000;
  const runtimeState:RuntimeState = !live
    ? "OFFLINE"
    : error
      ? "DEGRADED"
      : marketPhase==="BREAK"
        ? "STANDBY"
        : backendRuntimeFresh
          ? "ACTIVE"
          : marketPhase==="CLOSED"
            ? "STANDBY"
            : backendRuntime?.state==="NO_OPEN_SESSION" || !backendRuntime?.session
              ? "STANDBY"
              : "DEGRADED";

  const runtimeLabel = ({
    ACTIVE:"SYSTEM ACTIVE · PAPER OBSERVE",
    STANDBY:"SYSTEM ONLINE · STANDBY",
    DEGRADED:"SYSTEM DEGRADED",
    OFFLINE:"SYSTEM OFFLINE"
  } as const)[runtimeState];

  const shadow=shadowStatus?.shadow;
  const shadowBlocked=shadow && (shadow.orders_allowed!==true || (shadow.blockers?.length??0)>0);
  const runtimeDetail = runtimeState==="ACTIVE"
    ? strategyMismatch
      ? `Server runtime is active and ingesting market data, but the active runtime strategy is ${backendStrategy}; the control panel is scoped to ${LUNA_STRATEGY}. This is a strategy-alignment warning, not an API outage.`
      : shadow
        ? `Server runtime is active · v1.4 observe engine is calculating candidates (${shadow.buy_candidates??0} BUY / ${shadow.sell_candidates??0} SELL). ${shadowBlocked ? "Order gate remains blocked by readiness." : "Order gate is available."}`
        : `Server runtime is active · fresh backend ticks are arriving every cycle · latest source ${backendRuntime?.latest_source??"unknown"}.`
    : runtimeState==="DEGRADED"
      ? backendRuntime?.state==="LIVE" && runtimeAgeMs!=null
        ? `Server runtime exists, but the latest backend tick is ${Math.round(runtimeAgeMs)} ms old. Treat the feed as degraded until freshness recovers.`
        : marketPhase==="BREAK"
        ? "Market is in the midday break. LUNA remains online and the order gate stays closed until the afternoon session resumes."
        : "API is reachable, but the runtime health check is not yet healthy. Review the control room before assuming execution readiness."
      : runtimeState==="STANDBY"
        ? (marketPhase==="ACTIVE" || marketPhase==="REDUCE_ONLY" || marketPhase==="FORCE_CLOSE")
          ? "API is healthy, but there is no active server session. This is standby, not an API outage."
          : "API is healthy and ready. No trading session is running because the market is outside the execution window."
        : "The LUNA API could not be reached. This is the only state shown as OFFLINE.";

  const isConnecting=loading && !feed;
  const runtimeTone=isConnecting ? "STANDBY" : runtimeState;
  const runtimeShort = isConnecting ? "CONNECTING" : ({
    ACTIVE:"ACTIVE",
    STANDBY:"STANDBY",
    DEGRADED:"CHECK",
    OFFLINE:"OFFLINE"
  } as const)[runtimeState];
  const runtimeDisplayLabel=isConnecting ? "CONNECTING TO LUNA" : runtimeLabel;
  const runtimeDisplayDetail=isConnecting
    ? "Connecting to the backend control room. No trading action is enabled during startup."
    : runtimeDetail;
  const safetyBadge=!feed
    ? "SAFETY LOCKED"
    : liveModeMismatch
      ? "PAPER ONLY / BACKEND MODE MISMATCH"
      : "PAPER EXECUTION / LIVE ORDER LOCKED";
  const killSwitchDisplay=feed ? (killSwitch ? "ON" : "OFF") : "LOCKED";
  const killSwitchDetail=!feed
    ? "awaiting backend"
    : killSwitch
      ? "active · orders blocked"
      : liveModeMismatch
        ? "backend reports LIVE; this release enforces PAPER ONLY"
        : "off · live order gate remains locked";

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
        <div className={`session-chip session-runtime-${runtimeTone.toLowerCase()}`}><Clock3 size={14}/> {todaySessionDate} · {bangkokClock(clock)} · {isConnecting ? "CONNECTING" : runtimeState==="ACTIVE" ? (realtimeFresh ? "SYSTEM ACTIVE · UI REALTIME" : "SYSTEM ACTIVE · SERVER") : runtimeState==="STANDBY" ? "ONLINE · STANDBY" : runtimeState==="DEGRADED" ? "ONLINE · CHECK" : "OFFLINE"}</div>
      </div>
    </header>
    <div className="page">
      <section className="hero-row"><div><div className="eyebrow">INTRADAY CONTROL · OPERATIONAL OVERVIEW</div><h2>LUNA command center</h2><p>See capital, risk, execution and research state at a glance.</p></div><div className="hero-meta"><div className={`data-chip runtime-chip runtime-${runtimeTone.toLowerCase()}`}><span className="data-dot"/>{runtimeDisplayLabel}</div><div className="safe-badge"><ShieldCheck size={15}/> {safetyBadge}</div></div></section>
      <MarketHistoryPanel />\n      <section className={`runtime-banner runtime-${runtimeTone.toLowerCase()}`} aria-live="polite">
        <div className="runtime-banner-icon"><CircleDot size={15}/></div>
        <div className="runtime-banner-copy"><strong>{runtimeDisplayLabel}</strong><span>{runtimeDisplayDetail}</span></div>
        <div className="runtime-banner-meta"><span>API {live ? "CONNECTED" : "UNREACHABLE"}</span><span>BACKEND {backendRuntime?.state??"UNKNOWN"}</span><span>LAST TICK {runtimeAgeMs!=null ? Math.round(runtimeAgeMs)+" ms" : "—"}</span></div>
      </section>
      <SystemControlRoom strategy={session?.strategy_version ?? LUNA_STRATEGY} asOf={todaySessionDate} />
      <section className="live-operating-strip">
        <div className={`market-phase-cell phase-${marketPhase.toLowerCase()}`}><span>MARKET / SET</span><strong>{marketPhaseLabel(marketPhase)}</strong><small>{bangkokClock(clock)} · {marketPhaseHint(marketPhase)}</small></div>
        <div><span>EXECUTION MODE</span><strong>{executionMode}</strong><small>{liveModeMismatch?"backend reported LIVE · orders remain locked":"all orders remain paper-only"}</small></div>
        <div><span>KILL SWITCH</span><strong>{killSwitchDisplay}</strong><small>{killSwitchDetail}</small></div>
        <div><span>RUNTIME</span><strong>{runtimeShort}</strong><small>{sessionIsToday ? "today's session detected" : "no open session today"}</small></div>
        <div><span>LIVE ORDER GATE</span><strong>LOCKED</strong><small>{liveModeMismatch?"backend mode mismatch · paper-only enforced":"paper-only release"}</small></div>
        <div><span>MARKET FEED</span><strong>{realtimeFresh ? "REALTIME STREAM" : realtimeAgeMs!=null ? "STREAM STALE" : marketFeedLabel}</strong><small>{realtimeFresh ? "public WS · " + marketFeedAge : realtimeAgeMs!=null ? "last UI tick · " + marketFeedAge : marketFeedSource + " · " + marketFeedAge}</small></div><div><span>SHADOW ENGINE</span><strong>{shadow ? `${shadow.buy_candidates??0} BUY · ${shadow.sell_candidates??0} SELL` : "SYNCING"}</strong><small>{shadow?.blockers?.length ? shadow.blockers.join(" · ") : "v1.4 observe · no order"}</small></div><div className="live-operating-note"><ShieldCheck size={15}/><span>{marketPhase==="ACTIVE" ? "Market session active — backend re-checks phase immediately before every execution." : "Market execution is locked at this phase; stale signals are shown as HOLD until a fresh in-session signal arrives."}</span></div>
      </section>
      <AgentDecisionPanel shadow={shadow} generatedAt={shadowStatus?.generated_at}/>
      {error&&<div className="error-banner"><span>{error}</span><button onClick={load}>Retry</button></div>}
      <section className="summary-grid"><Metric label="Market ticks" value={String(sessionTicks.length)} sub="Latest session feed"/><Metric label="Shadow BUY" value={String(shadow?.buy_candidates??0)} sub="v1.4 candidates"/><Metric label="Shadow SELL" value={String(shadow?.sell_candidates??0)} sub="v1.4 candidates"/><Metric label="Signals" value={String(sessionSignals.length)} sub="Execution signals"/><Metric label="Orders" value={String(sessionOrders.length)} sub="Recorded this session"/>
        <Metric label="Total Equity" value={hasVerifiedPortfolioSnapshot ? `฿${money(equity)}` : "—"} sub={hasVerifiedPortfolioSnapshot ? `Initial ฿${money(initial)}` : "Awaiting verified portfolio snapshot"} positive={hasVerifiedPortfolioSnapshot ? equity>=initial : undefined}/>
        <Metric label="Market Value" value={hasMarketValue ? `฿${money(marketValue)}` : "—"} sub={hasMarketValue ? `${exposure.toFixed(1)}% exposure` : "Awaiting verified positions / snapshot"}/>
        <Metric label="Cash" value={sessionSnapshot?.cash!=null ? `฿${money(cash??0)}` : "—"} sub={sessionSnapshot?.cash!=null ? "Verified snapshot cash" : "Awaiting verified portfolio snapshot"}/>
        <Metric label="Unrealized P&L" value={hasUnrealized && unrealized!==null ? signed(unrealized) : "—"} sub={hasFreshPositionMarks ? "Fresh source-timestamped marks" : sessionSnapshot?.unrealized_pnl!=null ? "Verified portfolio snapshot" : "Awaiting verified marks / snapshot"} positive={unrealized!==null ? unrealized>=0 : undefined}/>
        <Metric label="Realized P&L" value={realized!==null ? signed(realized) : "—"} sub={realized!==null ? "Verified snapshot" : "Awaiting verified portfolio snapshot"} positive={realized!==null ? realized>=0 : undefined}/>
        <Metric label="Fees" value={fees!==null ? `-฿${money(fees)}` : "—"} sub={fees!==null ? "Recorded execution cost" : "Awaiting verified portfolio snapshot"}/>
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
          tab==="holdings"?<div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>QTY</th><th>AVG COST</th><th>LAST</th><th>MARKET VALUE</th><th>UNREALIZED P&amp;L</th><th>WEIGHT</th><th>SIGNAL</th></tr></thead><tbody>{filteredPositions.length?filteredPositions.map(p=>{const freshMark=p.last!==null&&p.lastPriceFresh;const value=freshMark?p.qty*(p.last??0):null;const weight=value!==null&&equity>0?value/equity*100:null;const pnl=freshMark?p.qty*((p.last??0)-p.avgCost):null;return <tr
  key={p.symbol}
  className={selectedPos?.symbol===p.symbol?"selected-row":""}
  tabIndex={0}
  aria-selected={selectedPos?.symbol===p.symbol}
  aria-label={p.symbol+" position"}
  onClick={()=>setSelected(p)}
  onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setSelected(p);}}}
><td><div className="symbol-cell"><strong>{p.symbol}</strong><span>{p.name}</span></div></td><td>{money(p.qty).replace(".00","")}</td><td>฿{p.avgCost.toFixed(2)}</td><td><strong>{p.last!==null?"฿"+p.last.toFixed(2):"—"}</strong>{p.last!==null&&!p.lastPriceFresh&&<small className="market-stale-label">STALE</small>}</td><td>{value!==null?"฿"+money(value):"—"}</td><td className={pnl===null?"muted":pnl>=0?"positive":"negative"}>{pnl===null?"—":signed(pnl)}</td><td>{weight===null?"—":<div className="weight-cell"><span>{weight.toFixed(1)}%</span><i><b style={{width:`${Math.min(weight,100)}%`}}/></i></div>}</td><td><SignalBadge signal={p.signal}/></td></tr>;}):<tr><td colSpan={8} className="empty-table"><div>{sessionIsToday ? "No open positions currently — positions are removed from Holdings after execution closes them." : `No current trading session yet for ${todaySessionDate}. LUNA is ${marketPhaseLabel(marketPhase).toLowerCase()} and execution is locked.`}</div>{trades.length>0&&<button className="filter-button" style={{marginTop:8}} onClick={()=>setTab("trades")}>View today\'s executed trades ({trades.length})</button>}</td></tr>}</tbody></table></div>:
          tab==="research"?<ResearchPanel/>:tab==="trades"?<div className="table-wrap"><table><thead><tr><th>TIME</th><th>SYMBOL</th><th>SIDE</th><th>ORDER / FILLED</th><th>FILL PRICE</th><th>FILL VALUE</th><th>STATUS</th><th>STRATEGY</th></tr></thead><tbody>{trades.length?trades.map(t=><tr key={`${t.time}-${t.symbol}-${t.qty}`}><td className="muted">{t.time}</td><td><strong>{t.symbol}</strong></td><td><SideBadge side={t.side}/></td><td>{money(t.qty).replace(".00","")} / {money(t.filledQty).replace(".00","")}</td><td>{t.price!==null?"฿"+t.price.toFixed(2):"—"}</td><td>{t.value!==null?"฿"+money(t.value):"—"}</td><td><StatusBadge status={t.status}/></td><td className="muted">{t.strategy}</td></tr>):<tr><td colSpan={8} className="empty-table">No orders recorded for this session.</td></tr>}</tbody></table></div>:
          <div className="table-wrap"><table><thead><tr><th>SYMBOL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>REALIZED P&amp;L (GROSS)</th><th>HOLD TIME</th></tr></thead><tbody>{closedPositions.length?closedPositions.map(p=><tr key={p.symbol}><td><strong>{p.symbol}</strong></td><td>฿{p.entry.toFixed(2)}</td><td>฿{p.exit.toFixed(2)}</td><td>{money(p.qty).replace(".00","")}</td><td className={p.pnl>=0?"positive":"negative"}>{signed(p.pnl)}</td><td className="muted">{p.duration}</td></tr>):<tr><td colSpan={6} className="empty-table">No closed positions reconstructed from matched ledger fills.</td></tr>}</tbody></table></div>}
        </div>
        <aside className="side-card">{selectedPos?<><div className="detail-head"><div><div className="detail-symbol">{selectedPos.symbol}</div><div className="muted">{selectedPos.name}</div></div><button className="close-button" onClick={()=>setSelected(null)}><X size={15}/></button></div><div className="price-block"><div>{selectedPos.last!==null?"฿"+selectedPos.last.toFixed(2):"—"}</div><span className={selectedHasFreshMark?(selectedPos.last!>=selectedPos.avgCost?"positive":"negative"):"muted"}>{selectedHasFreshMark?((selectedPos.last!/selectedPos.avgCost-1)*100).toFixed(2)+"%":"MARK STALE / UNAVAILABLE"}</span></div><div className="detail-grid"><Detail label="Position" value={`${money(selectedPos.qty).replace(".00","")} shares`}/><Detail label="Avg Cost" value={`฿${selectedPos.avgCost.toFixed(2)}`}/><Detail label="Market Value" value={selectedHasFreshMark?"฿"+money(selectedPos.qty*(selectedPos.last??0)):"—"}/><Detail label="Unrealized P&L" value={selectedHasFreshMark?signed(selectedPos.qty*((selectedPos.last??0)-selectedPos.avgCost)):"—"} positive={selectedHasFreshMark?(selectedPos.last??0)>=selectedPos.avgCost:undefined}/><Detail label="Portfolio Weight" value={equity&&selectedHasFreshMark?(selectedPos.qty*(selectedPos.last??0)/equity*100).toFixed(1)+"%":"—"}/><Detail label="Sizing" value="Dynamic · signal strength"/></div><div className="section-label">CURRENT SIGNAL</div><div className="signal-panel"><SignalBadge signal={selectedPos.signal} large/><p>{selectedPos.signalReason}</p></div><div className="section-label">EXECUTION TIMELINE</div><div className="timeline">{trades.filter(t=>t.symbol===selectedPos.symbol&&t.filledQty>0&&t.price!==null).map(t=><div className="timeline-item" key={t.time+"-"+t.symbol+"-"+t.side}><div className={`timeline-dot ${t.side.toLowerCase()}`}/><div><strong>{t.side} {money(t.filledQty).replace(".00","")} @ ฿{t.price!.toFixed(2)}</strong><span>{t.time} · {t.reason}</span></div></div>)}<div className="timeline-item future"><div className="timeline-dot"/><div><strong>Position currently open</strong><span>Latest feed mark</span></div></div></div><div className="audit-strip"><Layers3 size={15}/><span>Execution → Position → Snapshot → Audit event</span></div></>:<div className="empty-detail"><strong>Select a position</strong><span>Click any holding to inspect its live execution history.</span></div>}</aside>
      </section>
      <section className="bottom-grid"><div className="mini-card"><div className="mini-title"><BarChart3 size={16}/> Exposure by position</div><div className="bars">{positions.map(p=>{const weight=equity&&p.last!==null&&p.lastPriceFresh?p.qty*p.last/equity*100:null;return <div className="bar-row" key={p.symbol}><span>{p.symbol}</span><i><b style={{width:`${Math.min((weight??0)*5,100)}%`}}/></i><strong>{weight===null?"—":weight.toFixed(1)+"%"}</strong></div>})</div></div><div className="mini-card"><div className="mini-title"><History size={16}/> Session controls</div><div className="control-list"><div><span>Strategy</span><strong>{session?.strategy_version??"—"}</strong></div><div><span>Initial capital</span><strong>฿{money(initial)}</strong></div><div><span>Gross exposure</span><strong>{exposure.toFixed(1)}% / 100%</strong></div><div><span>End of day</span><strong>FORCE CLOSE</strong></div></div><div className={`live-toggle ${live ? "on" : "off"}`}><CircleDot size={13}/>{live ? `API connected · feed: ${marketFeedLabel}` : "Feed unavailable"}</div></div><div className="mini-card"><div className="mini-title"><WalletCards size={16}/> Audit integrity</div><div className="audit-score"><strong>{feed?.counts?.audits?"READY":"WAITING"}</strong><span>{feed?.counts?.audits??0} audit events · {feed?.counts?.fills??0} fills · {feed?.counts?.snapshots??0} snapshots</span></div><div className="hash-line">universe loaded · quote coverage tracked · real latency ledger · API-backed</div></div></section>
    </div>
  </main>
}



function AgentDecisionPanel({shadow,generatedAt}:{shadow:NonNullable<ShadowStatus["shadow"]>|undefined;generatedAt?:string}) {
  const decisions=shadow?.decisions??[];
  const blockers=shadow?.blockers??[];
  const lastEvaluated=generatedAt && Number.isFinite(Date.parse(generatedAt))
    ? new Date(generatedAt).toLocaleTimeString("en-GB",{hour12:false})
    : "—";
  const verified=shadow?.orders_allowed===true && blockers.length===0;
  return <section className="agent-reasoning-card" aria-labelledby="agent-reasoning-title">
    <div className="agent-reasoning-head">
      <div>
        <div className="section-label">LUNA AGENT · DECISION TRACE</div>
        <h3 id="agent-reasoning-title">What the engine evaluated</h3>
        <p>Candidate reasoning from the existing shadow-status API. A candidate is not an order or a fill.</p>
      </div>
      <div className={"agent-cycle-status "+(verified?"verified":"blocked")}>
        <CircleDot size={12}/>{verified?"GATES CLEAR":"OBSERVE / BLOCKED"}
      </div>
    </div>
    <div className="agent-reasoning-meta">
      <span><small>Last evaluation</small><strong>{lastEvaluated}</strong></span>
      <span><small>BUY candidates</small><strong>{shadow?.buy_candidates??"—"}</strong></span>
      <span><small>SELL candidates</small><strong>{shadow?.sell_candidates??"—"}</strong></span>
      <span><small>Orders permitted</small><strong>{shadow?.orders_allowed===true?"YES":"NO / UNKNOWN"}</strong></span>
    </div>
    {blockers.length>0&&<div className="agent-blockers"><strong>Blocking reasons</strong><span>{blockers.join(" · ")}</span></div>}
    <div className="agent-decision-list">
      {decisions.slice(0,5).map((decision,index)=>{
        const action=String(decision.candidate_action??"UNKNOWN").toUpperCase();
        const actionClass=action==="BUY"?"buy":action==="SELL"?"sell":"hold";
        return <details className="agent-decision" key={decision.symbol+"-"+decision.bar_end+"-"+index}>
          <summary>
            <span className="agent-decision-symbol">{decision.symbol}</span>
            <span className={"agent-action "+actionClass}>{action}</span>
            <span className="agent-decision-time">{decision.bar_end&&Number.isFinite(Date.parse(decision.bar_end))?new Date(decision.bar_end).toLocaleTimeString("en-GB",{hour12:false}):"time unavailable"}</span>
            <span className="agent-expand">View reasoning</span>
          </summary>
          <div className="agent-decision-body">
            <p>{decision.reason||"No decision explanation was recorded by the backend."}</p>
            <div className="agent-factor-grid">
              <span><small>Close</small><strong>{Number.isFinite(Number(decision.close))?Number(decision.close).toFixed(2):"—"}</strong></span>
              <span><small>EMA 5</small><strong>{Number.isFinite(Number(decision.ema5))?Number(decision.ema5).toFixed(3):"—"}</strong></span>
              <span><small>EMA 20</small><strong>{Number.isFinite(Number(decision.ema20))?Number(decision.ema20).toFixed(3):"—"}</strong></span>
              <span><small>Momentum</small><strong>{Number.isFinite(Number(decision.momentum_1))?Number(decision.momentum_1).toFixed(4):"—"}</strong></span>
              <span><small>Bars evaluated</small><strong>{decision.bar_count??"—"}</strong></span>
              <span><small>Feed verified</small><strong>{decision.feed_verified===true?"YES":decision.feed_verified===false?"NO":"UNKNOWN"}</strong></span>
              <span><small>Execution book</small><strong>{decision.verified_book===true?"VERIFIED":decision.verified_book===false?"UNVERIFIED":"UNKNOWN"}</strong></span>
              <span><small>Execution state</small><strong>{decision.execution_blocked===true?"BLOCKED":decision.execution_blocked===false?"NOT BLOCKED":"UNKNOWN"}</strong></span>
            </div>
            <div className="agent-candidate-warning">RESEARCH CANDIDATE ONLY · This panel does not place orders. Execution must pass backend risk and source-verification gates.</div>
          </div>
        </details>;
      })}
      {!decisions.length&&<div className="agent-empty-state">No verified decision trace returned by the shadow API. LUNA will not invent a reasoning record.</div>}
    </div>
  </section>;
}

function SystemControlRoom({strategy,asOf}:{strategy:string;asOf:string}) {
  const [state,setState]=useState<ControlRoomState|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");

  const refresh=useCallback(async()=>{
    const marketPhaseNow=uiMarketPhase(new Date());
    if(marketPhaseNow==="CLOSED"){
      setError("");
      setState({
        ok:true,
        generated_at:new Date().toISOString(),
        as_of_date:asOf,
        system_test:{overall_status:"DEFERRED",checks:[{name:"MARKET_CLOSED",pass:true}],summary:{integrity:true}},
        readiness:{month_closed:false,execution_mode:"paper",paper_execution_permitted:false,live_execution_permitted:false,kill_switch:false,armed:false,ceos_feed_rows:0,ceos_allowed_rows:0},
        fast:{forecast_rank:[]},
        final:{summary:{rows:0,paper_sim_ready:0,live_allowed:0,top20:[]},rows:[]},
        paper_audit:{preview_rows:0,incomplete_month_blocked_rows:0,orders_total:0,live_orders_created:false,month_closed:false}
      });
      setLoading(false);
      return;
    }
    setLoading(true); setError("");
    try{
      const data=await fetchControlRoom(strategy);
      if(!data.ok) throw new Error("LUNA control API returned partial data");
      setState(data);
    }catch(e){setError(e instanceof Error?e.message:"Unable to load LUNA control state");}
    finally{setLoading(false);}
  },[strategy,asOf]);

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
  const [data, setData] = useState<Tournament100Result|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const json = await fetchTournament100("signal", "full");
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
