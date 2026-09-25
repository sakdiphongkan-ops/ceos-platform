import {LiveSafetyKernel} from "./live-safety-kernel.js";

const now=new Date("2026-09-25T05:00:00.000Z");
const baseQuote={
  symbol:"AAA",
  ts:new Date(now.getTime()-100).toISOString(),
  sourceTs:new Date(now.getTime()-100).toISOString(),
  last:100,
  bid:99.9,
  ask:100.1,
  bidSize:1000,
  askSize:1000,
  source:"settrade",
  dataQuality:"verified"
};
const control={execution_mode:"live",armed:true,kill_switch:false,observe_only:false};

function check(name:string,condition:boolean){
  if(!condition) throw new Error(name);
}

function input(overrides:Record<string,unknown>={}){
  return {
    control,
    marketPhase:"ACTIVE" as const,
    quote:baseQuote,
    side:"BUY" as const,
    qty:100,
    referencePrice:100.1,
    maxOrderNotional:50_000,
    quoteMaxAgeMs:2_000,
    maxQuoteDeviationBps:75,
    maxClockSkewMs:1_500,
    clockSkewMs:50,
    reconciliationOk:true,
    gatewayHealthy:true,
    gatewayLiveArmed:true,
    hardOrderGateEnabled:true,
    nowMs:now.getTime(),
    ...overrides
  };
}

let kernel=new LiveSafetyKernel();
check("baseline should pass",kernel.evaluate(input()).ok===true);

kernel=new LiveSafetyKernel();
check("kill switch must block",kernel.evaluate(input({control:{...control,kill_switch:true}})).reason==="LIVE_CONTROL_KILL_SWITCH");

kernel=new LiveSafetyKernel();
check("gate disabled must block",kernel.evaluate(input({hardOrderGateEnabled:false})).reason==="LIVE_HARD_ORDER_GATE_DISABLED");

kernel=new LiveSafetyKernel();
check("stale quote must block",kernel.evaluate(input({
  quote:{...baseQuote,ts:new Date(now.getTime()-5_000).toISOString()}
})).reason==="LIVE_QUOTE_STALE_OR_INVALID");

kernel=new LiveSafetyKernel();
check("bad book must block",kernel.evaluate(input({
  quote:{...baseQuote,bidSize:0}
})).reason==="LIVE_VERIFIED_BOOK_REQUIRED");

kernel=new LiveSafetyKernel();
check("price deviation must block",kernel.evaluate(input({referencePrice:102})).reason==="LIVE_PRICE_DEVIATION_GUARD");

kernel=new LiveSafetyKernel();
check("max notional must block",kernel.evaluate(input({qty:600})).reason==="LIVE_MAX_ORDER_NOTIONAL");

kernel=new LiveSafetyKernel();
check("reconciliation must block",kernel.evaluate(input({reconciliationOk:false})).reason==="LIVE_RECONCILIATION_REQUIRED");

kernel=new LiveSafetyKernel({gatewayFailureTripCount:3});
kernel.recordGatewayFailure("timeout");
kernel.recordGatewayFailure("timeout");
check("breaker remains open before threshold",kernel.status().tripped===false);
kernel.recordGatewayFailure("timeout");
check("breaker trips at threshold",kernel.status().tripped===true);
check("tripped kernel blocks",kernel.evaluate(input()).ok===false);

kernel=new LiveSafetyKernel();
kernel.trip("manual");
check("manual trip is latched",kernel.status().tripped===true);

console.log("live safety kernel tests: PASS");
