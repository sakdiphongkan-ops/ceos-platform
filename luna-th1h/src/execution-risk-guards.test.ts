import {config} from "./config.js";
import {createPortfolio,mark,planOrder,simulateFill,applyFill} from "./execution.js";

function q(ts:string,symbol="AAA",last=100){
  return {
    symbol,ts,last,
    bid:last-0.01,
    ask:last+0.01,
    bidSize:100_000,
    askSize:100_000,
    source:"test",
    dataQuality:"verified"
  };
}

function buySignal(ts:string,symbol="AAA"){
  return {
    symbol,ts,action:"BUY" as const,
    reason:"TEST",
    strategyVersion:"test",
    targetAllocationPct:100
  };
}

const startTs="2026-09-22T03:00:00.000Z";
const state=createPortfolio(config.initialCapital);
const quote=q(startTs);
mark(state,quote);

const first=planOrder(buySignal(startTs),quote,state);
if(!first.accepted) throw new Error("expected first BUY to pass");
const conservativeMaxReference=config.maxOrderNotional/
  (1+Math.max(0,config.slippageBps/10_000+config.marketImpactBps/10_000));
if(first.qty*first.referencePrice>conservativeMaxReference+1e-8){
  throw new Error("reference notional exceeded conservative all-in order cap");
}

const fill=simulateFill(first);
if(fill.notional>config.maxOrderNotional+1e-8){
  throw new Error("simulated fill exceeded hard max order notional");
}
applyFill(state,fill);

const unverified=createPortfolio(config.initialCapital);
const nextTs="2026-09-22T03:02:00.000Z";
const degraded={...q(nextTs,"UNVERIFIED"),bid:null,ask:null,bidSize:0,askSize:0,dataQuality:"unverified"};
mark(unverified,degraded);
const blockedByBook=planOrder(buySignal(degraded.ts,"UNVERIFIED"),degraded,unverified);
if(blockedByBook.accepted || blockedByBook.reason!=="BUY_BLOCKED_NO_VERIFIED_BOOK"){
  throw new Error("BUY must be blocked when executable book/depth is unverified");
}
const tooLargePosition=createPortfolio(config.initialCapital);
tooLargePosition.positions.AAA={
  qty:Math.floor((config.initialCapital*config.maxPositionPct)/quote.ask),
  avgPrice:quote.ask,
  costBasis:Math.floor((config.initialCapital*config.maxPositionPct)/quote.ask)*quote.ask,
  realizedPnl:0
};
mark(tooLargePosition,quote);
const blockedByPosition=planOrder(buySignal(nextTs),quote,tooLargePosition);
if(blockedByPosition.accepted){
  throw new Error("BUY should not increase an already maxed position");
}

const dailyLoss=createPortfolio(config.initialCapital);
mark(dailyLoss,quote);
dailyLoss.cash=config.initialCapital-config.maxDailyLoss-1;
dailyLoss.dayStartEquity=config.initialCapital;
const blockedByDailyLoss=planOrder(buySignal(nextTs,"BBB"),q(nextTs,"BBB"),dailyLoss);
if(blockedByDailyLoss.accepted || blockedByDailyLoss.reason!=="MAX_DAILY_LOSS_LOCAL"){
  throw new Error("daily loss guard failed");
}

const turnover=createPortfolio(config.initialCapital);
mark(turnover,quote);
turnover.dailyTurnover=config.maxDailyTurnover-1;
const blockedByTurnover=planOrder(buySignal(nextTs,"CCC"),q(nextTs,"CCC"),turnover);
if(blockedByTurnover.accepted){
  throw new Error("daily turnover guard failed");
}

console.log("execution risk guard tests: PASS");
