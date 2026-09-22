import {runBacktest} from "./backtest.js";
import {simulateFill,type PlannedOrder} from "./execution.js";
import type {Quote} from "./types.js";

function quote(i:number,last:number):Quote{
  const ts=new Date(Date.parse("2026-09-20T03:00:00.000Z")+i*60_000).toISOString();
  return {
    symbol:"AAA",ts,last,
    bid:last-0.01,ask:last+0.01,bidSize:100_000,askSize:100_000,
    source:"test",dataQuality:"verified"
  };
}

const quotes:Quote[]=Array.from({length:2_000},(_,i)=>quote(i,100+(i/250)));
const base=runBacktest(quotes,1_000_000);
const stress=runBacktest(quotes,1_000_000,undefined,{
  costModel:{extraSlippageBps:20}
});
if(!Number.isFinite(base.finalEquity) || !Number.isFinite(stress.finalEquity)){
  throw new Error("cost replay produced non-finite equity");
}
if(stress.finalEquity>base.finalEquity+1e-8){
  throw new Error("higher execution cost unexpectedly improved final equity");
}
const order:PlannedOrder={
  accepted:true,
  symbol:"AAA",
  side:"BUY",
  qty:50,
  referencePrice:100,
  visibleDepth:100,
  spreadBps:2,
  reason:"COST_REPLAY_TEST"
};
const depthOrder:PlannedOrder={...order,qty:150,visibleDepth:150,depthComplete:true,depthLevels:[{price:100,size:100},{price:101,size:50}]};
const partialDepthOrder:PlannedOrder={...order,qty:150,visibleDepth:100,depthComplete:false,depthLevels:[{price:100,size:100},{price:90,size:50}]};
const partialDepthFill=simulateFill(partialDepthOrder,{slippageBps:0,marketImpactBps:0});
if(Math.abs(partialDepthFill.fillPrice-100)>1e-9){
  throw new Error("partial L2 snapshot must not be replayed as complete depth");
}
const depthFill=simulateFill(depthOrder,{slippageBps:0,marketImpactBps:0});
if(Math.abs(depthFill.fillPrice-(100*100+101*50)/150)>1e-9) throw new Error("depth replay VWAP mismatch");
const baselineFill=simulateFill(order,{marketImpactBps:8});
const stressedImpactFill=simulateFill(order,{marketImpactBps:20});
if(!(stressedImpactFill.fillPrice>baselineFill.fillPrice)){
  throw new Error("market impact override did not increase stressed BUY fill price");
}
if(!(stressedImpactFill.slippage>baselineFill.slippage)){
  throw new Error("market impact override did not increase stressed slippage");
}
console.log("execution cost replay tests: PASS");


{
  const unsortedSell = simulateFill({
    accepted:true,
    symbol:"ZZZ",
    side:"SELL",
    qty:15,
    referencePrice:100,
    visibleDepth:20,
    depthComplete:true,
    depthLevels:[
      {price:98,size:10},
      {price:100,size:10}
    ],
    spreadBps:0,
    reason:"TEST"
  },{slippageBps:0,marketImpactBps:0});
  if(Math.abs(unsortedSell.fillPrice-(100*10+98*5)/15)>1e-9){
    throw new Error("unsorted SELL depth was not executed best-price-first");
  }
  console.log("unsorted SELL depth replay: PASS");
}
