process.env.LUNA_MODE="paper";
process.env.LUNA_PRICE_ONLY_FALLBACK="true";
process.env.LUNA_EXECUTION_MODE="paper";
process.env.LIVE_TRADING_ARMED="false";

const {config}=await import("./config.js");
const {createPortfolio,mark,planOrder,simulateFill,applyFill}=await import("./execution.js");

function priceOnlyQuote(ts:string,symbol="TVPAPER",last=100){
  return {
    symbol,ts,last,
    bid:null,
    ask:null,
    bidSize:0,
    askSize:0,
    source:"tradingview-public-screener",
    dataQuality:"unverified"
  };
}

const state=createPortfolio(config.initialCapital);
const ts="2026-09-23T03:00:00.000Z";
const quote=priceOnlyQuote(ts);
mark(state,quote);

const signal={
  symbol:quote.symbol,
  ts,
  action:"BUY" as const,
  reason:"TEST_PRICE_ONLY_PAPER",
  strategyVersion:"test",
  targetAllocationPct:5
};

const order=planOrder(signal,quote,state);
if(!order.accepted){
  throw new Error(`price-only paper BUY was blocked: ${order.reason}`);
}
if(order.referencePrice!==quote.last){
  throw new Error("price-only paper BUY must use last price when verified book is unavailable");
}
if(!order.reason.startsWith("PRICE_ONLY_PAPER_LAST:")){
  throw new Error("price-only execution reason was not tagged");
}
if(order.qty<=0){
  throw new Error("price-only paper BUY returned zero quantity");
}

const fill=simulateFill(order);
applyFill(state,fill);
if(!state.positions[quote.symbol] || state.positions[quote.symbol].qty<=0){
  throw new Error("price-only paper BUY did not produce a position after simulated fill");
}

// A prefix-spoofed source must not inherit the price-only fallback.
const spoofState=createPortfolio(config.initialCapital);
const spoofQuote={...quote,source:"tradingview-public-screener-spoof"};
mark(spoofState,spoofQuote);
const spoofOrder=planOrder({...signal,symbol:spoofQuote.symbol},spoofQuote,spoofState);
if(spoofOrder.accepted){
  throw new Error("spoofed public-screener source must not be executable");
}

// An invalid execution mode is not equivalent to paper mode.
const previousExecutionMode=config.executionMode;
config.executionMode="invalid-mode";
try{
  const invalidModeState=createPortfolio(config.initialCapital);
  mark(invalidModeState,quote);
  const invalidModeOrder=planOrder(signal,quote,invalidModeState);
  if(invalidModeOrder.accepted){
    throw new Error("invalid execution mode must not allow price-only paper execution");
  }
}finally{
  config.executionMode=previousExecutionMode;
}

console.log("execution price-only paper gate test: PASS");
