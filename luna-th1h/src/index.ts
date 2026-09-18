import {config} from "./config.js";
import {marketQuotes} from "./market/provider.js";
import {StrategyV1,VERSION as STRATEGY_V1_VERSION} from "./strategy-v1.js";
import {applyFill,createPortfolio,mark,planOrder,simulateFill,snapshot, type PortfolioState} from "./execution.js";
import type {Quote,Signal} from "./types.js";

const EXECUTION_TEST_VERSION="luna-th1h-execution-test-0.1.0";

let sessionId:string|null=null;
let auditChain="GENESIS";
let heartbeatTimer:NodeJS.Timeout|undefined;
let portfolio:PortfolioState;
let executionTestStep=0;
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

  await ingest("",{action:"tick",session_id:sessionId,quote:q});
  await ingest("",{action:"signal",session_id:sessionId,signal});

  console.log(JSON.stringify({event:"SIGNAL",quote:q,signal}));

  await executeSignal(q,signal);

  if(!heartbeatTimer){
    heartbeatTimer=setInterval(()=>{
      Promise.all([
        audit("HEARTBEAT",{
          provider:config.marketDataProvider,
          last_quote_ts:q.ts,
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

  if(config.mode!=="paper") throw new Error("Only paper mode is enabled in this build.");
  if(config.marketDataProvider!=="mock"){
    throw new Error("Market-data adapter not installed. Keep MARKET_DATA_PROVIDER=mock until an authorized provider is configured.");
  }
  if(!config.supabaseFunctionUrl || !config.supabaseAnonKey || !config.lunaAgentKey){
    throw new Error("Supabase ingest security configuration is incomplete.");
  }

  await startSession();

  for await(const q of marketQuotes(config.marketDataProvider)){
    if(!sessionId) throw new Error("Session is not active");
    await handleQuote(q);
  }
}

process.on("SIGINT",async()=>{await endSession("CLOSED");process.exit(0)});
process.on("SIGTERM",async()=>{await endSession("CLOSED");process.exit(0)});

main().catch(async err=>{
  console.error(JSON.stringify({event:"LUNA_FATAL",error:String(err)}));
  await endSession("ERROR");
  process.exit(1);
});
