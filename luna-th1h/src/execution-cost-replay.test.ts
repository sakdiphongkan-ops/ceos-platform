import {runBacktest} from "./backtest.js";
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
console.log("execution cost replay tests: PASS");
