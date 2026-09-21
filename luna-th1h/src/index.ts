import {config} from "./config.js";
import {marketQuotes} from "./market/provider.js";
import {StrategyV1,VERSION as STRATEGY_V1_VERSION} from "./strategy-v1.js";
import {liveGatewayDiagnostics,liveGatewayHealth,placeLiveOrder,reconcileLiveOrders} from "./live-gateway.js";
import {transitionBrokerOrder,type BrokerOrderState} from "./broker-state.js";
import {applyFill,createPortfolio,mark,planOrder,simulateFill,snapshot, type PortfolioState} from "./execution.js";
import type {Quote,Signal} from "./types.js";

const EXECUTION_TEST_VERSION="luna-th1h-execution-test-0.1.0";

let sessionId:string|null=null;
let sessionDate:string|null=null;
let auditChain="GENESIS";
let heartbeatTimer:NodeJS.Timeout|undefined;
let portfolio:PortfolioState;
let executionTestStep=0;
let lastSnapshotAt=0;
let lastReconciliationAt=0;
let sessionStartPromise:Promise<void>|null=null;
let sessionEndPromise:Promise<void>|null=null;
let auditQueueTail:Promise<void>=Promise.resolve();
let activeAnalyses=0;
const analysisWaiters:Array<()=>void>=[];
const symbolChains=new Map<string,Promise<void>>();
let executionChain:Promise<void>=Promise.resolve();
const lastPersistBySymbol=new Map<string,number>();
const prewarmedSymbols=new Set<string>();
const liveOrderStates=new Map<string,BrokerOrderState>();
const PERSIST_HOLD_MS=5_000;
const SNAPSHOT_MS=1_000;
const MAX_ANALYSIS_CONCURRENCY=16;
const strategyV1=new StrategyV1({}, {priceOnlyFallback:config.priceOnlyFallback});

function activeStrategyVersion(){
  return config.executionTest?EXECUTION_TEST_VERSION:strategyV1.version;
}

function todayInTimezone(timezone:string){
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:timezone, year:"numeric", month:"2-digit", day:"2-digit"
  }).format(new Date());
}

async function sha256(value:string){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function ingest(path:string,body:Record<string,unknown>,agentRequired=true){
  if(!config.supabaseFunctionUrl || !config.supabaseAnonKey){
    throw new Error("Supabase ingest endpoint is not configured");
  }

  const headers:Record<string,string>={
    "Content-Type":"application/json",
    "Authorization":`Bearer ${config.supabaseAnonKey}`
  };
  if(agentRequired) headers["x-luna-agent"]=config.lunaAgentKey;

  let lastError:unknown;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const res=await fetch(`${config.supabaseFunctionUrl}/${path}`,{
        method:"POST",headers,body:JSON.stringify(body)
      });
      const text=await res.text();
      let payload:unknown=text;
      try{payload=JSON.parse(text)}catch{}
      if(!res.ok) throw new Error(`HTTP ${res.status}: ${typeof payload==="string"?payload:JSON.stringify(payload)}`);
      return payload;
    }catch(err){
      lastError=err;
      await new Promise(r=>setTimeout(r,250*attempt));
    }
  }
  throw lastError instanceof Error?lastError:new Error(String(lastError));
}

async function audit(
  eventType:string,
  payload:Record<string,unknown>,
  strategyVersion=activeStrategyVersion(),
  sessionIdOverride:string|null=sessionId
){
  const ts=new Date().toISOString();
  const canonical=JSON.stringify({prev:auditChain,ts,eventType,payload,strategyVersion});
  auditChain=await sha256(canonical);
  await ingest("",{
    action:"audit",session_id:sessionIdOverride,ts,event_type:eventType,payload,
    strategy_version:strategyVersion,hash:auditChain
  });
}

function queueAudit(
  eventType:string,
  payload:Record<string,unknown>,
  strategyVersion=activeStrategyVersion()
){
  const queuedSessionId=sessionId;
  const next=auditQueueTail
    .then(()=>audit(eventType,payload,strategyVersion,queuedSessionId))
    .catch(err=>{
      console.error(JSON.stringify({event:"AUDIT_ERROR",event_type:eventType,error:String(err)}));
    });
  auditQueueTail=next;
  return next;
}

async function acquireAnalysisSlot(){
  if(activeAnalyses<MAX_ANALYSIS_CONCURRENCY){
    activeAnalyses++;
    return;
  }
  await new Promise<void>(resolve=>analysisWaiters.push(resolve));
  activeAnalyses++;
}

function releaseAnalysisSlot(){
  activeAnalyses=Math.max(0,activeAnalyses-1);
  const waiter=analysisWaiters.shift();
  if(waiter) waiter();
}

function currentMarketPhase(){
  return marketPhase(new Date().toISOString());
}

function currentSessionDate(){
  return todayInTimezone(config.timezone);
}

async function writeSnapshot(){
  if(!sessionId || !portfolio) return;
  await ingest("",{
    action:"snapshot",
    session_id:sessionId,
    ts:new Date().toISOString(),
    portfolio:snapshot(portfolio)
  });
}

async function getExecutionControl(){
  const response=await ingest("",{action:"get_execution_control"});
  const control=(response as {control?:{
    execution_mode:string;armed:boolean;kill_switch:boolean;max_daily_loss:number;
    max_order_notional:number;max_orders_per_minute:number
  }}).control;
  if(!control) throw new Error("Supabase did not return execution control.");
  return control;
}

async function preflightLive(){
  if(config.executionMode!=="live") throw new Error("LIVE_EXECUTION_MODE_REQUIRED");
  if(config.mode!=="live") throw new Error("LUNA_MODE_MUST_BE_LIVE_FOR_LIVE_EXECUTION");
  if(String(process.env.LIVE_RECONCILIATION_READY ?? "false").toLowerCase()!=="true"){
    throw new Error("LIVE_RECONCILIATION_NOT_READY");
  }
  const control=await getExecutionControl();
  if(control.execution_mode!=="live" || !control.armed || control.kill_switch){
    throw new Error(`LIVE_CONTROL_BLOCKED execution_mode=${control.execution_mode} armed=${control.armed} kill_switch=${control.kill_switch}`);
  }
  const health=await liveGatewayHealth();
  if(!health.ok || !health.live_armed) throw new Error("LIVE_GATEWAY_NOT_ARMED");
  const diagnostics=await liveGatewayDiagnostics();
  if(!diagnostics?.credentials_present || !diagnostics?.python_sdk_loaded){
    throw new Error(`LIVE_GATEWAY_DIAGNOSTICS_FAILED: ${JSON.stringify(diagnostics)}`);
  }
}

async function startSession(){
  portfolio=createPortfolio(config.initialCapital);
  const response=await ingest("",{
    action:"start_session",
    session:{
      session_date:todayInTimezone(config.timezone),
      mode:config.mode,
      strategy_version:activeStrategyVersion(),
      strategy_description:config.executionTest
        ?"Deterministic execution-engine self-test: BUY then SELL a synthetic paper symbol."
        :(config.priceOnlyFallback
          ?"LUNA-TH1H Strategy v1 price-only paper fallback: EMA cross + momentum with stop/take-profit/time exit; no order-book filter."
          :"LUNA-TH1H Strategy v1: EMA cross + momentum + spread + order-book imbalance with stop/take-profit/time exit."),
      initial_capital:config.initialCapital
    }
  });
  const data=response as {session?:{id?:string}};
  if(!data.session?.id) throw new Error("Supabase did not return a session id");
  sessionId=data.session.id;
  sessionDate=todayInTimezone(config.timezone);
  await audit("SESSION_STARTED",{
    provider:config.marketDataProvider,
    capital:config.initialCapital,
    execution_test:config.executionTest,
    fee_bps:config.feeBps,
    sell_tax_bps:config.sellTaxBps,
    slippage_bps:config.slippageBps,
    timezone:config.timezone,
    market_phase:currentMarketPhase()
  });
  await writeSnapshot();
  console.log(JSON.stringify({event:"LUNA_SESSION_STARTED",sessionId,strategyVersion:activeStrategyVersion()}));
}

function localMinutes(ts:string,timezone:string){
  const parts=new Intl.DateTimeFormat("en-GB",{
    timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(new Date(ts));
  const hour=Number(parts.find(p=>p.type==="hour")?.value ?? 0);
  const minute=Number(parts.find(p=>p.type==="minute")?.value ?? 0);
  return hour*60+minute;
}
function hhmmMinutes(value:string){
  const [h,m]=value.split(":").map(Number);
  if(!Number.isInteger(h)||!Number.isInteger(m)||h<0||h>23||m<0||m>59) throw new Error(`INVALID_HHMM: ${value}`);
  return h*60+m;
}
function marketPhase(ts:string){
  const minutes=localMinutes(ts,config.timezone);
  const weekday=new Intl.DateTimeFormat("en-US",{
    timeZone:config.timezone,
    weekday:"short"
  }).format(new Date(ts));
  if(weekday==="Sat" || weekday==="Sun") return "CLOSED";

  const morningStart=10*60;
  const morningEnd=12*60+30;
  const afternoonStart=14*60;
  const tradingEnd=16*60+30;
  const reduceOnly=hhmmMinutes(config.reduceOnlyTime);
  const forceClose=hhmmMinutes(config.forceCloseTime);

  if(forceClose<=reduceOnly) throw new Error("forceCloseTime must be after reduceOnlyTime");
  if(minutes<morningStart) return "CLOSED";
  if(minutes>=morningEnd && minutes<afternoonStart) return "CLOSED";
  if(minutes>=tradingEnd) return "CLOSED";
  if(minutes>=forceClose) return "FORCE_CLOSE";
  if(minutes>=reduceOnly) return "REDUCE_ONLY";
  return "ACTIVE";
}

function getSignal(q:Quote):Signal{
  const quoteTsMs=Date.parse(q.ts);
  if(!Number.isFinite(quoteTsMs)){
    return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"INVALID_QUOTE_TIMESTAMP",strategyVersion:strategyV1.version};
  }
  const quoteAgeMs=Math.max(0,Date.now()-quoteTsMs);
  if(quoteAgeMs>config.maxQuoteAgeMs){
    return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"STALE_QUOTE",strategyVersion:strategyV1.version};
  }

  if(config.executionTest && q.symbol==="__LUNA_TEST__"){
    executionTestStep++;
    const action=executionTestStep===1?"BUY":executionTestStep===2?"SELL":"HOLD";
    return {
      symbol:q.symbol,ts:q.ts,action,
      reason:"Deterministic execution-engine self-test",
      strategyVersion:EXECUTION_TEST_VERSION
    };
  }

  const pos=portfolio.positions[q.symbol];
  const phase=currentMarketPhase();
  if(pos?.qty>0 && phase==="FORCE_CLOSE"){
    return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"FORCE_CLOSE_EOD",strategyVersion:strategyV1.version};
  }
  if(phase==="CLOSED"){
    return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"MARKET_CLOSED",strategyVersion:strategyV1.version};
  }
  if(phase==="REDUCE_ONLY"){
    const decision=strategyV1.evaluate(q,{
      positionQty:pos?.qty??0,
      avgPrice:pos?.avgPrice??0,
      nowMs:Date.now()
    });
    if(decision.action==="SELL") return decision;
    return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"REDUCE_ONLY_ENTRY_BLOCK",strategyVersion:strategyV1.version};
  }
  return strategyV1.evaluate(q,{
    positionQty:pos?.qty??0,
    avgPrice:pos?.avgPrice??0,
    nowMs:Date.parse(q.ts)
  });
}

async function executeSignal(q:Quote,signal:Signal){
  mark(portfolio,q);
  const plan=planOrder(signal,q,portfolio);
  if(!plan.accepted){
    if(signal.action!=="HOLD"){
      queueAudit("ORDER_BLOCKED",{
        symbol:q.symbol,action:signal.action,reason:plan.reason,quote:q
      },signal.strategyVersion);
    }
    return;
  }

  const fill=simulateFill(plan);
  const clientOrderId=`${sessionId}:${q.symbol}:${signal.ts}:${plan.side}:${executionTestStep}`;

  if(config.executionMode==="live"){
    try{
      const brokerOrder=await placeLiveOrder({
        clientOrderId,
        symbol:plan.symbol,
        side:plan.side,
        qty:plan.qty,
        price:plan.referencePrice,
        reason:signal.reason
      });
      await ingest("",{
        action:"record_broker_event",
        event:{
          session_id:sessionId,
          client_order_id:brokerOrder.client_order_id,
          broker_order_id:brokerOrder.broker_order_id,
          event_type:"BROKER_ORDER_SUBMITTED",
          ts:new Date().toISOString(),
          payload:{
            symbol:brokerOrder.symbol,
            side:brokerOrder.side,
            qty:brokerOrder.qty,
            price:brokerOrder.price,
            raw:brokerOrder.raw
          },
          idempotency_key:sessionId+":BROKER_ORDER_SUBMITTED:"+brokerOrder.client_order_id
        }
      });
      queueAudit("BROKER_ORDER_SUBMITTED",{
        client_order_id:brokerOrder.client_order_id,
        broker_order_id:brokerOrder.broker_order_id,
        symbol:brokerOrder.symbol,
        side:brokerOrder.side,
        qty:brokerOrder.qty,
        price:brokerOrder.price
      },signal.strategyVersion);
      liveOrderStates.set(clientOrderId,{
        clientOrderId,
        brokerOrderId:brokerOrder.broker_order_id,
        symbol:brokerOrder.symbol,
        side:brokerOrder.side,
        submittedQty:brokerOrder.qty,
        filledQty:0,
        avgFillPrice:null,
        status:"SUBMITTED",
        updatedAtMs:Date.now()
      });
      console.log(JSON.stringify({event:"LIVE_ORDER_SUBMITTED",brokerOrderId:brokerOrder.broker_order_id}));
      return;
    }catch(err){
      queueAudit("BROKER_ORDER_ERROR",{client_order_id:clientOrderId,error:String(err)},signal.strategyVersion);
      throw err;
    }
  }

  queueAudit("ORDER_SUBMITTED",{
    client_order_id:clientOrderId,
    symbol:fill.symbol,side:fill.side,qty:fill.qty,
    reference_price:fill.referencePrice,
    estimated_fill_price:fill.fillPrice,
    notional:fill.notional,
    fee:fill.fee,
    slippage:fill.slippage,
    signal_strength:signal.signalStrength??null,
    target_allocation_pct:signal.targetAllocationPct??null,
    sizing_reason:signal.sizingReason??null
  },signal.strategyVersion);

  try{
    const response=await ingest("",{
      action:"record_fill",
      session_id:sessionId,
      fill:{
        client_order_id:clientOrderId,
        symbol:fill.symbol,
        side:fill.side,
        qty:fill.qty,
        order_price:fill.referencePrice,
        fill_price:fill.fillPrice,
        fee:fill.fee,
        slippage:fill.slippage,
        ts:q.ts,
        reason:signal.reason,
        strategy_version:signal.strategyVersion
      }
    });
    const result=(response as {result?:{idempotent?:boolean,order_id?:string,fill_id?:number,position_qty?:number,avg_price?:number,realized_pnl?:number}})?.result;
    if(!result) throw new Error("record_fill returned no result");

    if(!result.idempotent) applyFill(portfolio,fill);
    queueAudit("ORDER_FILLED",{
      client_order_id:clientOrderId,
      order_id:result.order_id,
      fill_id:result.fill_id,
      symbol:fill.symbol,side:fill.side,qty:fill.qty,
      fill_price:fill.fillPrice,fee:fill.fee,slippage:fill.slippage,
      position_qty:result.position_qty,
      avg_price:result.avg_price,
      realized_pnl:result.realized_pnl,
      signal_strength:signal.signalStrength??null,
      target_allocation_pct:signal.targetAllocationPct??null,
      sizing_reason:signal.sizingReason??null
    },signal.strategyVersion);
    if(Date.now()-lastSnapshotAt>=SNAPSHOT_MS){
      lastSnapshotAt=Date.now();
      void writeSnapshot().catch(err=>console.error(JSON.stringify({event:"SNAPSHOT_ERROR",error:String(err)})));
    }
  }catch(err){
    queueAudit("ORDER_ERROR",{
      client_order_id:clientOrderId,
      symbol:fill.symbol,side:fill.side,qty:fill.qty,
      error:String(err)
    },signal.strategyVersion);
    throw err;
  }
}

function quoteSessionDate(ts:string){
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:config.timezone,year:"numeric",month:"2-digit",day:"2-digit"
  }).format(new Date(ts));
}

async function reconcileLiveOrderStates(){
  if(!config.liveReconciliation || config.executionMode!=="live") return;
  const pending=[...liveOrderStates.values()]
    .filter(x=>!["FILLED","CANCELED","REJECTED"].includes(x.status));
  if(pending.length===0) return;
  try{
    const updates=await reconcileLiveOrders(pending.map(x=>x.clientOrderId));
    for(const u of updates){
      const current=liveOrderStates.get(u.client_order_id);
      if(!current) continue;
      let next;
      try{
        next=transitionBrokerOrder(current,{
          brokerOrderId:u.broker_order_id??current.brokerOrderId,
          status:String(u.status).toUpperCase() as BrokerOrderState["status"],
          filledQty:Number(u.filled_qty??current.filledQty),
          avgFillPrice:u.avg_fill_price??current.avgFillPrice,
          updatedAtMs:Number(u.updated_at_ms??Date.now())
        });
      }catch(err){
        queueAudit("BROKER_STATE_TRANSITION_ERROR",{
          client_order_id:u.client_order_id,error:String(err),update:u
        });
        continue;
      }

      const deltaQty=next.filledQty-current.filledQty;
      if(deltaQty>0 && next.avgFillPrice && next.avgFillPrice>0){
        const quote=portfolio.marks[current.symbol];
        const reference=quote
          ? (current.side==="BUY"?(quote.ask??quote.last??next.avgFillPrice):(quote.bid??quote.last??next.avgFillPrice))
          : next.avgFillPrice;
        const feeRate=config.feeBps/10000+(current.side==="SELL"?config.sellTaxBps/10000:0);
        const notional=next.avgFillPrice*deltaQty;
        const brokerFee=Number(u.fee);
        const fee=Number.isFinite(brokerFee) && brokerFee>=0
          ? brokerFee
          : notional*feeRate;
        const slippage=Math.abs(next.avgFillPrice-reference)*deltaQty;
        const response=await ingest("",{
          action:"record_fill",
          session_id:sessionId,
          fill:{
            client_order_id:current.clientOrderId,
            broker_order_id:next.brokerOrderId,
            symbol:current.symbol,
            side:current.side,
            qty:deltaQty,
            order_price:reference,
            fill_price:next.avgFillPrice,
            fee,
            slippage,
            ts:new Date(next.updatedAtMs).toISOString(),
            reason:"BROKER_RECONCILIATION",
            strategy_version:activeStrategyVersion()
          }
        });
        const result=(response as {result?:{idempotent?:boolean}})?.result;
        if(result && !result.idempotent){
          applyFill(portfolio,{
            symbol:current.symbol,
            side:current.side,
            qty:deltaQty,
            referencePrice:reference,
            fillPrice:next.avgFillPrice,
            notional,
            fee,
            slippage,
            totalCashDelta:current.side==="BUY"?-(notional+fee):(notional-fee)
          });
        }
      }

      liveOrderStates.set(current.clientOrderId,next);
      queueAudit("BROKER_ORDER_RECONCILED",{
        client_order_id:next.clientOrderId,
        broker_order_id:next.brokerOrderId,
        status:next.status,
        filled_qty:next.filledQty,
        avg_fill_price:next.avgFillPrice,
        delta_qty:deltaQty
      });
    }
  }catch(err){
    queueAudit("BROKER_RECONCILIATION_ERROR",{error:String(err)});
  }
}

async function prewarmStrategy(q:Quote){
  if(prewarmedSymbols.has(q.symbol)) return;
  try{
    const response=await ingest("",{
      action:"recent_ticks",
      symbol:q.symbol,
      source:q.source,
      limit:25
    });
    const quotes=Array.isArray((response as any)?.quotes)?(response as any).quotes:[];
    const prices=quotes
      .filter((x:any)=>x?.ts && x.ts!==q.ts && Number.isFinite(Number(x.last)) && Number(x.last)>0)
      .map((x:any)=>Number(x.last));
    strategyV1.prime(q.symbol,prices);
    prewarmedSymbols.add(q.symbol);
    queueAudit("STRATEGY_PREWARM",{
      symbol:q.symbol,
      source:q.source,
      data_quality:q.dataQuality??null,
      historical_points:prices.length
    },strategyV1.version);
  }catch(err){
    queueAudit("STRATEGY_PREWARM_ERROR",{
      symbol:q.symbol,
      source:q.source,
      error:String(err)
    },strategyV1.version);
    prewarmedSymbols.add(q.symbol);
  }
}

async function ensureSession(){
  const phase=currentMarketPhase();
  if(sessionId) return;
  if(phase==="CLOSED") return;
  if(!sessionStartPromise){
    sessionStartPromise=startSession().finally(()=>{sessionStartPromise=null});
  }
  await sessionStartPromise;
}

async function handleQuote(q:Quote){
  await ensureSession();
  if(!sessionId) return;

  const today=currentSessionDate();
  if(sessionDate && sessionDate!==today){
    await audit("SESSION_ROLLOVER",{
      from_session_date:sessionDate,
      to_session_date:today
    },activeStrategyVersion(),sessionId);
    await endSession("ROLLOVER");
    strategyV1.reset();
    prewarmedSymbols.clear();
    lastPersistBySymbol.clear();
    lastSnapshotAt=0;
    await ensureSession();
    if(!sessionId) return;
  }

  const phase=currentMarketPhase();
  if(phase==="CLOSED"){
    await endSession("MARKET_CLOSED");
    return;
  }

  const startedAt=Date.now();
  await prewarmStrategy(q);

  // Hard decision gate immediately before analysis. This prevents an in-flight
  // quote from generating a trade signal after the market session has closed.
  const decisionPhase=currentMarketPhase();
  if(decisionPhase==="CLOSED"){
    await endSession("MARKET_CLOSED");
    return;
  }

  const signal=getSignal(q);
  const marketLagMs=Math.max(0,Date.now()-Date.parse(q.ts));

  const now=Date.now();
  const lastPersist=lastPersistBySymbol.get(q.symbol)??0;
  const shouldPersist=config.executionTest
    || signal.action!=="HOLD"
    || now-lastPersist>=PERSIST_HOLD_MS;

  if(shouldPersist){
    lastPersistBySymbol.set(q.symbol,now);
    const writes:Promise<unknown>[]=[
      ingest("",{action:"tick",session_id:sessionId,quote:q})
    ];
    if(signal.action!=="HOLD" || config.executionTest){
      writes.push(ingest("",{action:"signal",session_id:sessionId,signal}));
    }
    void Promise.all(writes).catch(err=>console.error(JSON.stringify({
      event:"PERSIST_SIGNAL_ERROR",
      symbol:q.symbol,
      error:String(err)
    })));
  }

  console.log(JSON.stringify({
    event:signal.action==="HOLD"?"DECISION":"SIGNAL",
    quote:q,
    signal,
    market_lag_ms:marketLagMs,
    analysis_ms:Date.now()-startedAt
  }));

  if(signal.action!=="HOLD"){
    const executionQueuedAt=Date.now();
    executionChain=executionChain
      .catch(()=>undefined)
      .then(async()=>{
        try{
          // Re-check the session immediately before execution. A signal may have
          // waited behind another order long enough to cross REDUCE_ONLY/CLOSED.
          const executionPhase=currentMarketPhase();
          const quoteTsMs=Date.parse(q.ts);
          const quoteAgeMs=Number.isFinite(quoteTsMs)
            ? Math.max(0,Date.now()-quoteTsMs)
            : Number.POSITIVE_INFINITY;
          const blockedByPhase =
            executionPhase==="CLOSED"
            || (signal.action==="BUY" && executionPhase!=="ACTIVE")
            || quoteAgeMs>config.maxQuoteAgeMs;
          if(blockedByPhase){
            await queueAudit("ORDER_SUPPRESSED_MARKET_PHASE",{
              symbol:q.symbol,
              action:signal.action,
              market_phase:executionPhase,
              quote_ts:q.ts,
              quote_age_ms:quoteAgeMs
            },signal.strategyVersion);
            return;
          }
          await executeSignal(q,signal);
          const queueWaitMs=Date.now()-executionQueuedAt;
          const endToEndMs=Date.now()-startedAt;
          const executionMs=Math.max(0,endToEndMs-marketLagMs);
          queueAudit("LATENCY_METRIC",{
            symbol:q.symbol,
            action:signal.action,
            quote_ts:q.ts,
            market_lag_ms:marketLagMs,
            analysis_ms:Math.max(0,Date.now()-startedAt-queueWaitMs),
            queue_wait_ms:queueWaitMs,
            execution_ms:executionMs,
            end_to_end_ms:endToEndMs,
            market_phase:currentMarketPhase(),
            source:q.source
          },signal.strategyVersion);
          console.log(JSON.stringify({
            event:"EXECUTION_COMPLETE",
            symbol:q.symbol,
            action:signal.action,
            queue_wait_ms:queueWaitMs,
            end_to_end_ms:endToEndMs,
            market_lag_ms:marketLagMs
          }));
        }catch(err){
          console.error(JSON.stringify({
            event:"EXECUTION_ERROR",
            symbol:q.symbol,
            action:signal.action,
            error:String(err),
            end_to_end_ms:Date.now()-startedAt
          }));
        }
      });
  }

  if(!heartbeatTimer){
    heartbeatTimer=setInterval(()=>{
      const now=Date.now();
      const phase=currentMarketPhase();

      if(phase==="CLOSED"){
        void endSession("MARKET_CLOSED").catch(err=>console.error(JSON.stringify({
          event:"SESSION_AUTO_CLOSE_ERROR",
          error:String(err)
        })));
        return;
      }

      const recon = config.liveReconciliation && config.executionMode==="live" && now-lastReconciliationAt>=config.liveReconciliationMs
        ? (lastReconciliationAt=now, reconcileLiveOrderStates())
        : Promise.resolve();
      Promise.all([
        queueAudit("HEARTBEAT",{
          provider:config.marketDataProvider,
          last_quote_ts:q.ts,
          market_phase:phase,
          execution_test:config.executionTest
        }),
        writeSnapshot(),
        recon
      ]).catch(err=>console.error(JSON.stringify({event:"HEARTBEAT_ERROR",error:String(err)})));
    },1_000);
  }
}

async function endSession(status="CLOSED"){
  if(sessionEndPromise) return sessionEndPromise;
  if(!sessionId) return;

  const closingSessionId=sessionId;
  sessionEndPromise=(async()=>{
    if(heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer=undefined;
    try{
      if(config.liveReconciliation && config.executionMode==="live"){
        await reconcileLiveOrderStates();
      }
      await writeSnapshot();
      await queueAudit("SESSION_ENDED",{status},activeStrategyVersion());
      await auditQueueTail;
      await ingest("",{action:"end_session",session_id:closingSessionId,status});
    }catch(err){
      console.error(JSON.stringify({event:"SESSION_END_ERROR",error:String(err)}));
    }finally{
      if(sessionId===closingSessionId){
        sessionId=null;
        sessionDate=null;
      }
    }
  })().finally(()=>{sessionEndPromise=null});

  await sessionEndPromise;
}

async function main(){
  console.log(JSON.stringify({
    event:"LUNA_BOOT",
    mode:config.mode,
    provider:config.marketDataProvider,
    capital:config.initialCapital,
    executionTest:config.executionTest,
    strategy:strategyV1.version,
    timezone:config.timezone,
    marketPhase:currentMarketPhase()
  }));

  if(!["paper","live"].includes(config.mode)) throw new Error(`Unknown LUNA_MODE: ${config.mode}`);
  if(config.priceOnlyFallback && (config.mode==="live" || config.executionMode==="live")){
    throw new Error("PRICE_ONLY_FALLBACK_IS_PAPER_ONLY");
  }
  if(config.mode==="live" || config.executionMode==="live") await preflightLive();
  if(!["mock","set-marketplace","settrade-gateway"].includes(config.marketDataProvider)){
    throw new Error(`Unknown MARKET_DATA_PROVIDER: ${config.marketDataProvider}`);
  }
  if(config.marketDataProvider==="set-marketplace" && !process.env.SET_MARKETPLACE_API_KEY){
    throw new Error("SET_MARKETPLACE_API_KEY is required when MARKET_DATA_PROVIDER=set-marketplace.");
  }
  if(config.marketDataProvider==="settrade-gateway" && (!config.marketDataGatewayUrl || !config.marketDataGatewayKey)){
    throw new Error("LUNA_MARKET_GATEWAY_URL and LUNA_MARKET_GATEWAY_KEY are required when MARKET_DATA_PROVIDER=settrade-gateway.");
  }
  if(!config.supabaseFunctionUrl || !config.supabaseAnonKey || !config.lunaAgentKey){
    throw new Error("Supabase ingest security configuration is incomplete.");
  }

  for await(const q of marketQuotes(config.marketDataProvider)){
    const previous=symbolChains.get(q.symbol) ?? Promise.resolve();
    const next=previous
      .catch(err=>console.error(JSON.stringify({
        event:"LUNA_SYMBOL_CHAIN_ERROR",
        symbol:q.symbol,
        error:String(err)
      })))
      .then(async()=>{
        await acquireAnalysisSlot();
        try{
          await handleQuote(q);
        }catch(err){
          console.error(JSON.stringify({
            event:"LUNA_QUOTE_CYCLE_ERROR",
            symbol:q.symbol,
            ts:q.ts,
            error:String(err)
          }));
        }finally{
          releaseAnalysisSlot();
        }
      });

    symbolChains.set(q.symbol,next);
    next.finally(()=>{
      if(symbolChains.get(q.symbol)===next) symbolChains.delete(q.symbol);
    }).catch(()=>undefined);
  }
}

process.on("SIGINT",async()=>{await endSession("CLOSED");process.exit(0)});
process.on("SIGTERM",async()=>{await endSession("CLOSED");process.exit(0)});

main().catch(async err=>{
  console.error(JSON.stringify({event:"LUNA_FATAL",error:String(err)}));
  await endSession("ERROR");
  process.exit(1);
});
