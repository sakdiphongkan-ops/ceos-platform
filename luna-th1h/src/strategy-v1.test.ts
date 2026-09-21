import {StrategyV1} from "./strategy-v1.js";

const strategy=new StrategyV1();
const prices=Array.from({length:25},(_,i)=>100+i*0.1);
strategy.prime("AAA",prices);

const sparse=new StrategyV1();
let qts="2026-09-21T03:00:00.000Z";
const base={
  symbol:"AAA",
  ts:qts,
  bid:102,
  ask:102.02,
  last:102.01,
  bidSize:1000,
  askSize:500,
  source:"test"
};
const first=sparse.evaluate(base,{positionQty:0,avgPrice:0,nowMs:Date.now()});
if(first.reason!=="WARMUP") throw new Error("expected live warmup before seed");

const applied=sparse.primeIfSparse("AAA",prices,2);
if(!applied) throw new Error("expected sparse seed to apply");

const second=sparse.evaluate({...base,last:102.3,bid:102.29,ask:102.31},{positionQty:0,avgPrice:0,nowMs:Date.now()});
if(second.reason==="WARMUP") throw new Error("seed did not remove warmup");

const mature=new StrategyV1();
for(let i=0;i<5;i++){
  mature.evaluate({
    ...base,
    ts:new Date(Date.parse(qts)+i*1000).toISOString(),
    last:102+i*0.1,
    bid:102+i*0.1-0.01,
    ask:102+i*0.1+0.01
  },{positionQty:0,avgPrice:0,nowMs:Date.now()});
}
const ignored=mature.primeIfSparse("AAA",prices,2);
if(ignored) throw new Error("mature live state must not be overwritten");

console.log("strategy sparse-seed tests: PASS");
