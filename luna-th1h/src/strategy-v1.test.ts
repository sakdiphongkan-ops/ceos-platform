import {StrategyV1,VERSION} from "./strategy-v1.js";

function quote(ts:string,last:number,book=true){
  return {
    symbol:"AAA",ts,last,
    bid:book?last-0.01:null,
    ask:book?last+0.01:null,
    bidSize:book?1000:null,
    askSize:book?500:null,
    source:"test",
    dataQuality:book?"verified":"unverified"
  };
}

const strategy=new StrategyV1();
const start=Date.parse("2026-09-21T03:00:00.000Z");

for(let i=0;i<20;i++){
  const ts=new Date(start+i*15*60_000).toISOString();
  const signal=strategy.evaluate(
    quote(ts,100+i*0.10),
    {positionQty:0,avgPrice:0,nowMs:start+i*15*60_000+1000}
  );
  if(signal.action==="BUY") throw new Error("must not enter before 20 completed bars");
}

const entryTs=start+20*15*60_000+1000;
const entry=strategy.evaluate(
  quote(new Date(entryTs).toISOString(),102.20),
  {positionQty:0,avgPrice:0,nowMs:entryTs}
);
if(entry.action!=="BUY") throw new Error("expected 15m BUY after completed-bar warmup");

const blocked=new StrategyV1();
for(let i=0;i<20;i++){
  blocked.evaluate(
    quote(new Date(start+i*15*60_000).toISOString(),100+i*0.10),
    {positionQty:0,avgPrice:0,nowMs:start+i*15*60_000+1000}
  );
}
const noBook=blocked.evaluate(
  {
    ...quote(new Date(entryTs).toISOString(),102.20,false),
    bid:0,ask:0,bidSize:0,askSize:0,last:102.20
  },
  {positionQty:0,avgPrice:0,nowMs:entryTs}
);
if(noBook.action==="BUY") throw new Error("unverified book must block BUY");


const priceOnlyStrategy=new StrategyV1({}, {priceOnlyFallback:true});
for(let i=0;i<20;i++){
  const ts=new Date(start+i*15*60_000).toISOString();
  priceOnlyStrategy.evaluate(
    {
      ...quote(ts,100+i*0.10,false),
      bid:0,ask:0,bidSize:0,askSize:0,last:100+i*0.10,
      source:"tradingview-public-screener",
      dataQuality:"public_screener_unverified_latency"
    },
    {positionQty:0,avgPrice:0,nowMs:start+i*15*60_000+1000}
  );
}
const priceOnlyEntry=priceOnlyStrategy.evaluate(
  {
    ...quote(new Date(entryTs).toISOString(),102.20,false),
    bid:0,ask:0,bidSize:0,askSize:0,last:102.20,
    source:"tradingview-public-screener",
    dataQuality:"public_screener_unverified_latency"
  },
  {positionQty:0,avgPrice:0,nowMs:entryTs}
);
if(priceOnlyEntry.action!=="BUY") throw new Error("paper price-only fallback should allow BUY after warmup");
if(priceOnlyEntry.strategyVersion!==VERSION) throw new Error("price-only fallback strategy version mismatch");
if(Number(priceOnlyEntry.targetAllocationPct??0)>=7.5) throw new Error("price-only fallback must remain inside reduced sizing envelope");

const exitStrategy=new StrategyV1();
exitStrategy.prime("AAA",Array.from({length:20},(_,i)=>100+i*0.10));
const exit=exitStrategy.evaluate(
  quote(new Date(entryTs).toISOString(),99.0),
  {positionQty:10,avgPrice:100,nowMs:entryTs+1000}
);
if(exit.action!=="SELL" || exit.reason!=="STOP_LOSS_EXECUTABLE_BID") throw new Error("stop-loss exit failed");

console.log("15m strategy tests: PASS");
