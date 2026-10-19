import {config} from "./config.js";
import {validateOrder} from "./risk.js";
import type {Quote,Signal,Side} from "./types.js";

export interface PositionState{
  qty:number;
  avgPrice:number;
  costBasis:number;
  realizedPnl:number;
}

export interface PortfolioState{
  cash:number;
  initialCapital:number;
  fees:number;
  slippageCost:number;
  positions:Record<string,PositionState>;
  marks:Record<string,Quote>;
  recentBuyTimestamps?:number[];
  riskDayKey?:string;
  dayStartEquity?:number;
  dailyTurnover?:number;
}

export interface ExecutionReservations{
  reservedBuyCash:number;
  reservedGrossExposure:number;
  reservedSellQty:Record<string,number>;
}

export interface ExecutionCostOverrides{
  feeBps?:number;
  sellTaxBps?:number;
  slippageBps?:number;
  marketImpactBps?:number;
  extraSlippageBps?:number;
}

function nonNegativeBps(value:unknown,fallback:number):number{
  return typeof value==="number" && Number.isFinite(value) && value>=0 && value<=10_000
    ? value
    : fallback;
}

function executionCosts(overrides:ExecutionCostOverrides = {}){
  return {
    feeBps:nonNegativeBps(overrides.feeBps,config.feeBps),
    sellTaxBps:nonNegativeBps(overrides.sellTaxBps,config.sellTaxBps),
    slippageBps:nonNegativeBps(overrides.slippageBps,config.slippageBps)
      +nonNegativeBps(overrides.extraSlippageBps,0),
    marketImpactBps:nonNegativeBps(overrides.marketImpactBps,config.marketImpactBps)
  };
}

function executionConfigurationIsValid():boolean{
  const values=[
    config.initialCapital,config.maxPositionPct,config.maxGrossExposurePct,
    config.entryNotionalPct,config.maxDailyLoss,config.maxDailyTurnover,
    config.maxOrderNotional,config.maxOrdersPerMinute,config.feeBps,
    config.sellTaxBps,config.slippageBps,config.marketImpactBps
  ];
  return values.every(value=>typeof value==="number" && Number.isFinite(value))
    && config.initialCapital>0
    && config.maxPositionPct>=0 && config.maxPositionPct<=1
    && config.maxGrossExposurePct>=0 && config.maxGrossExposurePct<=1
    && config.entryNotionalPct>=0 && config.entryNotionalPct<=1
    && config.maxDailyLoss>=0 && config.maxDailyTurnover>=0
    && config.maxOrderNotional>=0 && config.maxOrdersPerMinute>=1
    && [config.feeBps,config.sellTaxBps,config.slippageBps,config.marketImpactBps]
      .every(value=>value>=0 && value<=10_000);
}

function portfolioStateIsValid(state:PortfolioState):boolean{
  if(!state || typeof state!=="object" || Array.isArray(state)) return false;
  const finiteNonNegative=(value:unknown)=>
    typeof value==="number" && Number.isFinite(value) && value>=0;
  if(!finiteNonNegative(state.cash) || !finiteNonNegative(state.initialCapital) || state.initialCapital===0
    || !finiteNonNegative(state.fees) || !finiteNonNegative(state.slippageCost)) return false;
  if(state.dayStartEquity!==undefined && !finiteNonNegative(state.dayStartEquity)) return false;
  if(state.dailyTurnover!==undefined && !finiteNonNegative(state.dailyTurnover)) return false;
  if(state.recentBuyTimestamps!==undefined
    && (!Array.isArray(state.recentBuyTimestamps) || !state.recentBuyTimestamps.every(x=>typeof x==="number" && Number.isFinite(x)))) return false;
  if(!state.positions || typeof state.positions!=="object" || Array.isArray(state.positions)) return false;
  if(!state.marks || typeof state.marks!=="object" || Array.isArray(state.marks)) return false;
  const positionKeys=Object.keys(state.positions);
  const canonicalKeys=new Set<string>();
  for(const key of positionKeys){
    if(typeof key!=="string" || !key.trim()) return false;
    const canonical=canonicalSymbol(key);
    if(canonicalKeys.has(canonical)) return false;
    canonicalKeys.add(canonical);
  }
  return Object.values(state.positions).every(pos=>
    !!pos && typeof pos.qty==="number" && Number.isSafeInteger(pos.qty) && pos.qty>=0
    && finiteNonNegative(pos.avgPrice)
    && finiteNonNegative(pos.costBasis)
    && typeof pos.realizedPnl==="number" && Number.isFinite(pos.realizedPnl)
  );
}

function reservationsAreValid(reservations:ExecutionReservations):boolean{
  const finiteNonNegative=(value:unknown)=>
    typeof value==="number" && Number.isFinite(value) && value>=0;
  if(!reservations
    || !finiteNonNegative(reservations.reservedBuyCash)
    || !finiteNonNegative(reservations.reservedGrossExposure)
    || !reservations.reservedSellQty
    || typeof reservations.reservedSellQty!=="object"
    || Array.isArray(reservations.reservedSellQty)) return false;
  const canonicalKeys=new Set<string>();
  for(const key of Object.keys(reservations.reservedSellQty)){
    if(!key.trim()) return false;
    const canonical=canonicalSymbol(key);
    if(canonicalKeys.has(canonical)) return false;
    canonicalKeys.add(canonical);
  }
  return Object.values(reservations.reservedSellQty).every(finiteNonNegative);
}

function allowPaperPriceOnlyExecution(q:Quote){
  const mode=String(config.mode??"").toLowerCase();
  const executionMode=String(config.executionMode??"").toLowerCase();
  const liveTradingArmed=String(process.env.LIVE_TRADING_ARMED??"false").toLowerCase()==="true";
  const source=String(q.source??"").toLowerCase();
  return config.priceOnlyFallback
    && mode==="paper"
    && executionMode==="paper"
    && !liveTradingArmed
    && source==="tradingview-public-screener";
}

export type PlannedOrder = {
  accepted:true;
  symbol:string;
  side:Side;
  qty:number;
  referencePrice:number;
  visibleDepth:number;
  spreadBps:number;
  reason:string;
  depthLevels?:Array<{price:number;size:number}>;
  depthComplete?:boolean;
} | {
  accepted:false;
  reason:string;
};

export interface SimulatedFill{
  symbol:string;
  side:Side;
  qty:number;
  referencePrice:number;
  fillPrice:number;
  notional:number;
  fee:number;
  slippage:number;
  totalCashDelta:number;
}

export function createPortfolio(initialCapital:number):PortfolioState{
  return {cash:initialCapital,initialCapital,fees:0,slippageCost:0,positions:{},marks:{},recentBuyTimestamps:[],riskDayKey:undefined,dayStartEquity:initialCapital,dailyTurnover:0};
}

function canonicalSymbol(symbol:string):string{
  return symbol.trim().toUpperCase();
}

function existingPositionKey(state:PortfolioState,symbol:string):string{
  if(Object.prototype.hasOwnProperty.call(state.positions,symbol)) return symbol;
  return Object.keys(state.positions).find(key=>canonicalSymbol(key)===symbol) ?? symbol;
}

function position(state:PortfolioState,symbol:string):PositionState{
  return state.positions[existingPositionKey(state,canonicalSymbol(symbol))]
    ?? {qty:0,avgPrice:0,costBasis:0,realizedPnl:0};
}

function roundDown(n:number){
  return Math.max(0,Math.floor(n));
}
function usablePrice(...values:Array<number|null|undefined>){
  for(const value of values){
    if(typeof value==="number" && Number.isFinite(value) && value>0) return value;
  }
  return 0;
}

function recentBuys(state:PortfolioState){
  if(!state.recentBuyTimestamps) state.recentBuyTimestamps=[];
  return state.recentBuyTimestamps;
}

function marketDayKey(ts:string){
  const d=new Date(ts);
  if(!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit",day:"2-digit"
  }).format(d);
}

function ensureDailyRiskState(state:PortfolioState,ts:string){
  const day=marketDayKey(ts);
  if(!day) return;
  if(state.riskDayKey!==day){
    state.riskDayKey=day;
    const s=snapshot(state);
    state.dayStartEquity=s.cash+s.market_value;
    state.dailyTurnover=0;
  }
}

function pruneRecentBuys(state:PortfolioState,nowMs:number){
  const timestamps=recentBuys(state);
  const cutoff=nowMs-60_000;
  while(timestamps.length && timestamps[0]<cutoff) timestamps.shift();
}

export function mark(state:PortfolioState,q:Quote){
  const symbol=canonicalSymbol(q.symbol);
  state.marks[symbol]={...q,symbol};
  ensureDailyRiskState(state,q.ts);
}

export function planOrder(
  signal:Signal,
  q:Quote,
  state:PortfolioState,
  reservations:ExecutionReservations={reservedBuyCash:0,reservedGrossExposure:0,reservedSellQty:{}},
  costOverrides:ExecutionCostOverrides={}
):PlannedOrder{
  if(!signal || typeof signal!=="object" || !q || typeof q!=="object"){
    return {accepted:false,reason:"INVALID_EXECUTION_INPUT"};
  }
  if(signal.action==="HOLD") return {accepted:false,reason:"SIGNAL_HOLD"};
  if(signal.action!=="BUY" && signal.action!=="SELL"){
    return {accepted:false,reason:"INVALID_SIGNAL_ACTION"};
  }
  if(typeof signal.symbol!=="string" || typeof q.symbol!=="string"
    || !signal.symbol.trim() || !q.symbol.trim()
    || signal.symbol.trim().toUpperCase()!==q.symbol.trim().toUpperCase()){
    return {accepted:false,reason:"QUOTE_SYMBOL_MISMATCH"};
  }

  const side:Side=signal.action;
  const symbol=canonicalSymbol(signal.symbol);
  if(!executionConfigurationIsValid()){
    return {accepted:false,reason:"INVALID_EXECUTION_CONFIG"};
  }
  if(!portfolioStateIsValid(state)){
    return {accepted:false,reason:"INVALID_PORTFOLIO_STATE"};
  }
  if(!reservationsAreValid(reservations)){
    return {accepted:false,reason:"INVALID_EXECUTION_RESERVATIONS"};
  }
  if(signal.targetAllocationPct!==undefined
    && (typeof signal.targetAllocationPct!=="number"
      || !Number.isFinite(signal.targetAllocationPct)
      || signal.targetAllocationPct<0
      || signal.targetAllocationPct>100)){
    return {accepted:false,reason:"INVALID_TARGET_ALLOCATION"};
  }
  ensureDailyRiskState(state,signal.ts);
  const hasBook=typeof q.bid==="number" && Number.isFinite(q.bid)
    && q.bid>0
    && typeof q.ask==="number" && Number.isFinite(q.ask)
    && q.ask>0
    && q.ask>=q.bid;
  const hasDepth=typeof q.bidSize==="number" && Number.isFinite(q.bidSize) && q.bidSize>0
    && typeof q.askSize==="number" && Number.isFinite(q.askSize) && q.askSize>0;
  const quality=String(q.dataQuality??"").trim().toLowerCase().replace(/[\s-]+/g,"_");
  const verifiedQuality=["verified","verified_book","book_verified","verified_execution_book"].includes(quality);
  const explicitlyUnverified=quality.includes("unverified") || quality==="not_verified" || quality.startsWith("not_");
  const sourceName=String(q.source??"").trim().toLowerCase();
  const trustedRealtimeSource=
    sourceName==="settrade-open-api-realtime"
    || sourceName==="set-market-data-api-realtime";
  const verifiedBook=hasBook && hasDepth && (verifiedQuality || trustedRealtimeSource) && !explicitlyUnverified;
  const allowPriceOnlyPaper=allowPaperPriceOnlyExecution(q);

  // BUYs require a verified executable book in live/verified paths.
  // In the explicitly non-live paper fallback, TradingView last-price execution
  // is allowed because the strategy has already opted into the same fallback.
  const referencePrice=side==="BUY"
    ? (verifiedBook
      ? Number(q.ask)
      : (allowPriceOnlyPaper?usablePrice(q.last,q.ask,q.bid):0))
    : (verifiedBook
      ? Number(q.bid)
      : (allowPriceOnlyPaper?usablePrice(q.last,q.bid,q.ask):0));
  if(side==="BUY" && !referencePrice){
    return {accepted:false,reason:"BUY_BLOCKED_NO_VERIFIED_BOOK"};
  }
  if(side==="SELL" && !referencePrice){
    return {accepted:false,reason:"NO_EXIT_PRICE"};
  }

  const pos=position(state,symbol);
  const currentNotional=pos.qty*referencePrice;

  if(side==="BUY"){
    const simulatedNowMs=Date.parse(signal.ts);
    const orderNowMs=Number.isFinite(simulatedNowMs)?simulatedNowMs:Date.now();
    pruneRecentBuys(state,orderNowMs);
    const recent=recentBuys(state);
    if(recent.length>=Math.max(1,Math.floor(config.maxOrdersPerMinute))){
      return {accepted:false,reason:"MAX_ORDERS_PER_MINUTE_LOCAL"};
    }

    const current=snapshot(state);
    const currentEquity=Math.max(0,current.cash+current.market_value);
    const dayStart=Number(state.dayStartEquity??state.initialCapital);
    const dailyPnl=(current.cash+current.market_value)-dayStart;
    if(dailyPnl<=-Math.abs(config.maxDailyLoss)){
      return {accepted:false,reason:"MAX_DAILY_LOSS_LOCAL"};
    }

    const costs=executionCosts(costOverrides);
    const requestedTargetFraction=Math.max(
      0,
      Number(signal.targetAllocationPct??(config.entryNotionalPct*100))/100
    );
    const targetFraction=Math.min(
      config.maxPositionPct,
      requestedTargetFraction
    );
    const targetNotional=Math.max(0,currentEquity*targetFraction-currentNotional);
    const entryCapNotional=Math.max(0,currentEquity*config.entryNotionalPct);
    const slippageRate=costs.slippageBps/10_000;
    const conservativeImpactRate=costs.marketImpactBps/10_000;
    const conservativeExecutionRate=Math.max(0,slippageRate+conservativeImpactRate);
    const hardOrderReferenceCap=Math.max(
      0,
      config.maxOrderNotional/(1+conservativeExecutionRate)
    );
    const orderNotionalCap=Math.min(
      targetNotional,
      entryCapNotional,
      hardOrderReferenceCap
    );
    const dailyTurnoverHeadroom=Math.max(0,config.maxDailyTurnover-Number(state.dailyTurnover??0));
    const grossHeadroom=Math.max(
      0,
      currentEquity*config.maxGrossExposurePct
        -currentGrossExposure(state)
        -Math.max(0,reservations.reservedGrossExposure)
    );
    const feeRate=costs.feeBps/10000;
    const estimatedAllInPerShare=referencePrice*(1+conservativeExecutionRate)*(1+feeRate);
    const availableCash=Math.max(0,state.cash-Math.max(0,reservations.reservedBuyCash));
    const affordable=availableCash/estimatedAllInPerShare;
    let qty=roundDown(Math.min(
      orderNotionalCap/referencePrice,
      grossHeadroom/referencePrice,
      affordable,
      dailyTurnoverHeadroom/referencePrice
    ));
    if(verifiedBook){
      const availableAskDepth=q.depthComplete && q.askLevels?.length
        ? q.askLevels.reduce((s,l)=>s+Math.max(0,l.size),0)
        : Number(q.askSize??0);
      if(availableAskDepth>0) qty=Math.min(qty,roundDown(availableAskDepth));
    }
    if(qty<=0) return {accepted:false,reason:"INSUFFICIENT_CASH_OR_POSITION_HEADROOM"};

    const maxPositionNotional=currentEquity*config.maxPositionPct;
    if(currentNotional+qty*referencePrice>maxPositionNotional+1e-8){
      const cappedQty=roundDown(Math.max(0,maxPositionNotional-currentNotional)/referencePrice);
      qty=Math.min(qty,cappedQty);
    }
    if(qty<=0) return {accepted:false,reason:"MAX_POSITION_EXPOSURE"};

    const notional=qty*referencePrice;
    const risk=validateOrder({
      symbol,side,notional,
      grossExposure:currentGrossExposure(state)+Math.max(0,reservations.reservedGrossExposure),
      currentPositionNotional:currentNotional,
      cash:availableCash
    });
    if(!risk.ok) return {accepted:false,reason:risk.reason};
    recent.push(orderNowMs);
    return {
      accepted:true,symbol,side,qty,referencePrice,
      visibleDepth:verifiedBook?(q.depthComplete && q.askLevels?.length?q.askLevels.reduce((s,l)=>s+Math.max(0,l.size),0):Number(q.askSize??0)):0,
      depthLevels:verifiedBook && q.depthComplete ? q.askLevels:undefined,
      depthComplete:verifiedBook && q.depthComplete===true,
      spreadBps:verifiedBook
        ? ((Number(q.ask)-Number(q.bid))/Number(q.last||q.ask))*10_000 : 0,
      reason:allowPriceOnlyPaper && !verifiedBook ? "PRICE_ONLY_PAPER_LAST:"+signal.reason : signal.reason
    };
  }

  const reservedKey=Object.keys(reservations.reservedSellQty).find(key=>canonicalSymbol(key)===symbol);
  const reservedForSymbol=Math.max(0,Number(reservations.reservedSellQty[symbol]??(reservedKey?reservations.reservedSellQty[reservedKey]:0)??0));
  const availablePositionQty=Math.max(0,pos.qty-reservedForSymbol);
  if(availablePositionQty<=0) return {accepted:false,reason:"NO_LONG_POSITION"};
  let qty=availablePositionQty;
  if(verifiedBook){
    const availableBidDepth=q.depthComplete && q.bidLevels?.length
      ? q.bidLevels.reduce((s,l)=>s+Math.max(0,l.size),0)
      : Number(q.bidSize??0);
    if(availableBidDepth>0) qty=Math.min(qty,roundDown(availableBidDepth));
  }
  if(qty<=0) return {accepted:false,reason:"NO_SELLABLE_LIQUIDITY"};

  const notional=qty*referencePrice;
  const risk=validateOrder({
    symbol,side,notional,
    grossExposure:currentGrossExposure(state)+Math.max(0,reservations.reservedGrossExposure),
    currentPositionNotional:currentNotional,
    cash:Math.max(0,state.cash-Math.max(0,reservations.reservedBuyCash))
  });
  if(!risk.ok) return {accepted:false,reason:risk.reason};
  return {
    accepted:true,symbol,side,qty,referencePrice,
    visibleDepth:verifiedBook?(q.depthComplete && q.bidLevels?.length?q.bidLevels.reduce((s,l)=>s+Math.max(0,l.size),0):Number(q.bidSize??0)):0,
    depthLevels:verifiedBook && q.depthComplete ? q.bidLevels:undefined,
    depthComplete:verifiedBook && q.depthComplete===true,
    spreadBps:verifiedBook
      ? ((Number(q.ask)-Number(q.bid))/Number(q.last||q.bid))*10_000 : 0,
    reason:signal.reason
  };
}

export function simulateFill(
  order:Extract<PlannedOrder,{accepted:true}>,
  costOverrides:ExecutionCostOverrides={}
):SimulatedFill{
  if(!order || typeof order.symbol!=="string" || !order.symbol.trim()
    || (order.side!=="BUY" && order.side!=="SELL")
    || typeof order.qty!=="number" || !Number.isFinite(order.qty) || order.qty<=0
    || !Number.isSafeInteger(order.qty)
    || typeof order.referencePrice!=="number" || !Number.isFinite(order.referencePrice) || order.referencePrice<=0
    || typeof order.visibleDepth!=="number" || !Number.isFinite(order.visibleDepth) || order.visibleDepth<0
    || typeof order.spreadBps!=="number" || !Number.isFinite(order.spreadBps) || order.spreadBps<0){
    throw new Error("INVALID_SIMULATED_FILL_INPUT");
  }
  if(order.depthComplete===true && order.depthLevels?.length
    && !order.depthLevels.every(level=>
      !!level && typeof level.price==="number" && Number.isFinite(level.price) && level.price>0
      && typeof level.size==="number" && Number.isFinite(level.size) && level.size>0)){
    throw new Error("INVALID_SIMULATED_FILL_DEPTH");
  }
  const costs=executionCosts(costOverrides);
  if(![costs.feeBps,costs.sellTaxBps,costs.slippageBps,costs.marketImpactBps]
    .every(value=>typeof value==="number" && Number.isFinite(value) && value>=0 && value<=20_000)){
    throw new Error("INVALID_SIMULATED_FILL_COST");
  }
  const slippageRate=costs.slippageBps/10000;
  const feeRate=costs.feeBps/10000;
  const taxRate=order.side==="SELL"?costs.sellTaxBps/10000:0;
  const participation=order.visibleDepth>0
    ? Math.min(1,Math.max(0,order.qty/order.visibleDepth))
    : 0;
  const impactRate=(costs.marketImpactBps/10000)*Math.sqrt(participation);
  const totalPricePenalty=slippageRate+impactRate;
  if(!Number.isFinite(totalPricePenalty) || totalPricePenalty<0 || totalPricePenalty>0.5){
    throw new Error("INVALID_SIMULATED_FILL_COST");
  }
  let fillPrice=order.side==="BUY"
    ? order.referencePrice*(1+totalPricePenalty)
    : order.referencePrice*(1-totalPricePenalty);
  if(order.depthComplete===true && order.depthLevels?.length){
    let remaining=order.qty;
    let cash=0;
    const orderedDepth=[...order.depthLevels].sort((a,b)=>
      order.side==="BUY" ? a.price-b.price : b.price-a.price
    );
    for(const level of orderedDepth){
      if(remaining<=0) break;
      const take=Math.min(remaining,Math.max(0,level.size));
      cash+=take*level.price;
      remaining-=take;
    }
    if(remaining<=1e-9){
      fillPrice=cash/order.qty*(1+slippageRate);
      if(order.side==="SELL") fillPrice=cash/order.qty*(1-slippageRate);
    }
  }
  if(!Number.isFinite(fillPrice) || fillPrice<=0){
    throw new Error("INVALID_SIMULATED_FILL_PRICE");
  }
  const notional=fillPrice*order.qty;
  const fee=notional*(feeRate+taxRate);
  const slippage=Math.abs(fillPrice-order.referencePrice)*order.qty;
  const totalCashDelta=order.side==="BUY"
    ? -(notional+fee)
    : (notional-fee);
  if(![notional,fee,slippage,totalCashDelta].every(value=>Number.isFinite(value))
    || notional<=0 || fee<0 || slippage<0){
    throw new Error("INVALID_SIMULATED_FILL_RESULT");
  }
  return {
    symbol:order.symbol,side:order.side,qty:order.qty,
    referencePrice:order.referencePrice,fillPrice,notional,fee,slippage,totalCashDelta
  };
}

export function applyFill(state:PortfolioState,fill:SimulatedFill){
  if(!portfolioStateIsValid(state)
    || !fill || typeof fill.symbol!=="string" || !fill.symbol.trim()
    || (fill.side!=="BUY" && fill.side!=="SELL")
    || !Number.isSafeInteger(fill.qty) || fill.qty<=0
    || ![fill.referencePrice,fill.fillPrice,fill.notional,fill.fee,fill.slippage,fill.totalCashDelta]
      .every(value=>typeof value==="number" && Number.isFinite(value))
    || fill.referencePrice<=0 || fill.fillPrice<=0 || fill.notional<=0 || fill.fee<0 || fill.slippage<0){
    throw new Error("INVALID_SIMULATED_FILL");
  }
  const expectedNotional=fill.qty*fill.fillPrice;
  const expectedCashDelta=fill.side==="BUY" ? -(fill.notional+fill.fee) : fill.notional-fill.fee;
  const tolerance=Math.max(1e-6,Math.abs(expectedNotional)*1e-8);
  const expectedSlippage=Math.abs(fill.fillPrice-fill.referencePrice)*fill.qty;
  if(Math.abs(fill.notional-expectedNotional)>tolerance
    || Math.abs(fill.slippage-expectedSlippage)>Math.max(1e-6,Math.abs(expectedSlippage)*1e-8)
    || Math.abs(fill.totalCashDelta-expectedCashDelta)>Math.max(1e-6,Math.abs(expectedCashDelta)*1e-8)){
    throw new Error("INCONSISTENT_SIMULATED_FILL");
  }

  const symbol=canonicalSymbol(fill.symbol);
  const priorKey=existingPositionKey(state,symbol);
  const pos=position(state,symbol);
  // Validate all state-dependent constraints before mutating the portfolio.
  // In particular, an invalid SELL must not delete a legacy symbol key.
  if(fill.side==="SELL" && fill.qty>pos.qty) throw new Error("SELL_EXCEEDS_POSITION");
  const cashTolerance=Math.max(1e-6,state.cash*1e-12);
  if(fill.side==="BUY" && -fill.totalCashDelta>state.cash+cashTolerance){
    throw new Error("INSUFFICIENT_PAPER_CASH");
  }

  let nextPosition:PositionState;
  if(fill.side==="BUY"){
    const newQty=pos.qty+fill.qty;
    const newCost=pos.costBasis+fill.notional+fill.fee;
    nextPosition={
      qty:newQty,avgPrice:newCost/newQty,costBasis:newCost,realizedPnl:pos.realizedPnl
    };
  }else{
    const realized=(fill.notional-fill.fee)-(pos.avgPrice*fill.qty);
    const newQty=pos.qty-fill.qty;
    const newCost=Math.max(0,pos.costBasis-(pos.avgPrice*fill.qty));
    nextPosition={
      qty:newQty,
      avgPrice:newQty>0?newCost/newQty:0,
      costBasis:newCost,
      realizedPnl:pos.realizedPnl+realized
    };
  }

  const nextCash=state.cash+fill.totalCashDelta;
  const nextFees=state.fees+fill.fee;
  const nextDailyTurnover=Number(state.dailyTurnover??0)+fill.notional;
  const nextSlippageCost=state.slippageCost+fill.slippage;
  if(!Number.isSafeInteger(nextPosition.qty) || nextPosition.qty<0
    || ![nextPosition.avgPrice,nextPosition.costBasis,nextPosition.realizedPnl,
      nextCash,nextFees,nextDailyTurnover,nextSlippageCost]
      .every(value=>typeof value==="number" && Number.isFinite(value))
    || nextPosition.avgPrice<0 || nextPosition.costBasis<0
    || nextCash< -cashTolerance || nextFees<0 || nextDailyTurnover<0 || nextSlippageCost<0){
    throw new Error("INVALID_SIMULATED_FILL_RESULT");
  }

  // Commit the in-memory state only after every guard passes.
  if(priorKey!==symbol && Object.prototype.hasOwnProperty.call(state.positions,priorKey)){
    delete state.positions[priorKey];
  }
  state.positions[symbol]=nextPosition;
  state.cash=Math.max(0,nextCash);
  state.fees=nextFees;
  state.dailyTurnover=nextDailyTurnover;
  state.slippageCost=nextSlippageCost;
}

export function currentGrossExposure(state:PortfolioState){
  return Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[canonicalSymbol(symbol)] ?? state.marks[symbol];
    const price=usablePrice(q?.last,q?.bid,q?.ask,pos.avgPrice);
    return sum+Math.max(0,pos.qty*price);
  },0);
}

export function snapshot(state:PortfolioState){
  const marketValue=Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[canonicalSymbol(symbol)] ?? state.marks[symbol];
    const liquidationPrice=usablePrice(q?.bid,q?.last,q?.ask,pos.avgPrice);
    return sum+Math.max(0,pos.qty*liquidationPrice);
  },0);
  const grossExposure=currentGrossExposure(state);
  const realizedPnl=Object.values(state.positions).reduce((sum,p)=>sum+p.realizedPnl,0);
  const unrealizedPnl=Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[canonicalSymbol(symbol)] ?? state.marks[symbol];
    const markPrice=usablePrice(q?.bid,q?.last,q?.ask,pos.avgPrice);
    return sum+(markPrice*pos.qty-pos.costBasis);
  },0);
  return {
    cash:state.cash,
    market_value:marketValue,
    gross_exposure:grossExposure,
    realized_pnl:realizedPnl,
    unrealized_pnl:unrealizedPnl,
    fees:state.fees
  };
}
