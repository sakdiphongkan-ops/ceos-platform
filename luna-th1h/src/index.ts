import {config} from "./config.js";
import {marketQuotes} from "./market/provider.js";
import {StrategyV1,VERSION as STRATEGY_V1_VERSION} from "./strategy-v1.js";
import {liveGatewayDiagnostics,liveGatewayHealth,placeLiveOrder} from "./live-gateway.js";
import {applyFill,createPortfolio,mark,planOrder,simulateFill,snapshot, type PortfolioState} from "./execution.js";
import type {Quote,Signal} from "./types.js";

const EXECUTION_TEST_VERSION="luna-th1h-execution-test-0.1.0";

let sessionId:string|null=null;
let auditChain="GENESIS";
let heartbeatTimer:NodeJS.Timeout|undefined;
let portfolio:PortfolioState;
let executionTestStep=0;
let lastPersistAt=0;
const PERSIST_SIGNAL_MS=1_000;
const strategyV1=new StrategyV1();

function activeStrategyVersion(){
  return config.executionTest?EXECUTION_TEST_VERSION:STRATEGY_V1_VERSION;
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

async function audit(eventType:string,payload:Record<string,unknown>,strategyVersion=activeStrategyVersion()){
  const ts=new Date().toISOString();
  const canonical=JSON.stringify({prev:auditChain,ts,eventType,payload,strategyVersion});
  auditChain=await sha256(canonical);
  await ingest("",{
    action:"audit",session_id:sessionId,ts,event_type:eventType,payload,
    strategy_version:strategyVersion,hash:auditChain
  });
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
        :"LUNA-TH1H Strategy v1: EMA cross + momentum + spread + order-book imbalance with stop/take-profit/time exit.",
      initial_capital:config.initialCapital
    }
  });
  const data=response as {session?:{id?:string}};
  if(!data.session?.id) throw new Error("Supabase did not return a session id");
  sessionId=data.session.id;
  await audit("SESSION_STARTED",{
    provider:config.marketDataProvider,
    capital:config.initialCapital,
    execution_test:config.executionTest,
    fee_bps:config.feeBps,
    sell_tax_bps:config.sellTaxBps,
    slippage_bps:config.slippageBps
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
  const reduceOnly=hhmmMinutes(config.reduceOnlyTime);
  const forceClose=hhmmMinutes(config.forceCloseTime);
  if(forceClose<=reduceOnly) throw new Error("forceCloseTime must be after reduceOnlyTime");
  if(minutes>=forceClose) return "FORCE_CLOSE";
  if(minutes>=reduceOnly) return "REDUCE_ONLY";
  return "ACTIVE";
}

function getSignal(q:Quote):Signal{
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
  const phase=marketPhase(q.ts);
  if(pos?.qty>0 && phase==="FORCE_CLOSE"){
    return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"FORCE_CLOSE_EOD",strategyVersion:STRATEGY_V1_VERSION};
  }
  if(phase!=="ACTIVE"){
    return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:`${phase}_ENTRY_BLOCK`,strategyVersion:STRATEGY_V1_VERSION};
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
      await audit("ORDER_BLOCKED",{
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
      await audit("BROKER_ORDER_SUBMITTED",{
        client_order_id:brokerOrder.client_order_id,
        broker_order_id:brokerOrder.broker_order_id,
        symbol:brokerOrder.symbol,
        side:brokerOrder.side,
        qty:brokerOrder.qty,
        price:brokerOrder.price
      },signal.strategyVersion);
      console.log(JSON.stringify({event:"LIVE_ORDER_SUBMITTED",brokerOrderId:brokerOrder.broker_order_id}));
      return;
    }catch(err){
      await audit("BROKER_ORDER_ERROR",{client_order_id:clientOrderId,error:String(err)},signal.strategyVersion);
      throw err;
    }
  }

  await audit("ORDER_SUBMITTED",{
    client_order_id:clientOrderId,
    symbol:fill.symbol,side:fill.side,qty:fill.qty,
    reference_price:fill.referencePrice,
    estimated_fill_price:fill.fillPrice,
    notional:fill.notional,
    fee:fill.fee,
    slippage:fill.slippage
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
    await audit("ORDER_FILLED",{
      client_order_id:clientOrderId,
      order_id:result.order_id,
      fill_id:result.fill_id,
      symbol:fill.symbol,side:fill.side,qty:fill.qty,
      fill_price:fill.fillPrice,fee:fill.fee,slippage:fill.slippage,
      position_qty:result.position_qty,
      avg_price:result.avg_price,
      realized_pnl:result.realized_pnl
    },signal.strategyVersion);
    await writeSnapshot();
  }catch(err){
    await audit("ORDER_ERROR",{
      client_order_id:clientOrderId,
      symbol:fill.symbol,side:fill.side,qty:fill.qty,
      error:String(err)
    },signal.strategyVersion);
    throw err;
  }
}

async function handleQuote(q:Quote){
  const signal=getSignal(q);

  const now=Date.now();
  const shouldPersist=config.executionTest || (now-lastPersistAt)>=PERSIST_SIGNAL_MS || signal.action!=="HOLD";
  if(shouldPersist){
    await ingest("",{action:"tick",session_id:sessionId,quote:q});
    await ingest("",{action:"signal",session_id:sessionId,signal});
    lastPersistAt=now;
  }

  console.log(JSON.stringify({event:"SIGNAL",quote:q,signal}));

  await executeSignal(q,signal);

  if(!heartbeatTimer){
    heartbeatTimer=setInterval(()=>{
      Promise.all([
        audit("HEARTBEAT",{
          provider:config.marketDataProvider,
          last_quote_ts:q.ts,
          market_phase:marketPhase(q.ts),
          execution_test:config.executionTest
        }),
        writeSnapshot()
      ]).catch(err=>console.error(JSON.stringify({event:"HEARTBEAT_ERROR",error:String(err)})));
    },60_000);
  }
}

async function endSession(status="CLOSED"){
  if(heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer=undefined;
  if(!sessionId) return;
  try{
    await writeSnapshot();
    await audit("SESSION_ENDED",{status});
    await ingest("",{action:"end_session",session_id:sessionId,status});
  }catch(err){
    console.error(JSON.stringify({event:"SESSION_END_ERROR",error:String(err)}));
  }finally{
    sessionId=null;
  }
}

async function main(){
  console.log(JSON.stringify({
    event:"LUNA_BOOT",
    mode:config.mode,
    provider:config.marketDataProvider,
    capital:config.initialCapital,
    executionTest:config.executionTest,
    strategy:STRATEGY_V1_VERSION
  }));

  if(!["paper","live"].includes(config.mode)) throw new Error(`Unknown LUNA_MODE: ${config.mode}`);
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

  await startSession();

  for await(const q of marketQuotes(config.marketDataProvider)){
    if(!sessionId) throw new Error("Session is not active");
    try{
      await handleQuote(q);
    }catch(err){
      console.error(JSON.stringify({
        event:"LUNA_QUOTE_CYCLE_ERROR",
        symbol:q.symbol,
        ts:q.ts,
        error:String(err)
      }));
      await new Promise(r=>setTimeout(r,500));
    }
  }
}

process.on("SIGINT",async()=>{await endSession("CLOSED");process.exit(0)});
process.on("SIGTERM",async()=>{await endSession("CLOSED");process.exit(0)});

main().catch(async err=>{
  console.error(JSON.stringify({event:"LUNA_FATAL",error:String(err)}));
  await endSession("ERROR");
  process.exit(1);
});
