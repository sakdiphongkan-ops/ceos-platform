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

function executionCosts(overrides:ExecutionCostOverrides = {}){
  return {
    feeBps:Number.isFinite(overrides.feeBps)?Number(overrides.feeBps):config.feeBps,
    sellTaxBps:Number.isFinite(overrides.sellTaxBps)?Number(overrides.sellTaxBps):config.sellTaxBps,
    slippageBps:(Number.isFinite(overrides.slippageBps)?Number(overrides.slippageBps):config.slippageBps)
      +(Number.isFinite(overrides.extraSlippageBps)?Number(overrides.extraSlippageBps):0),
    marketImpactBps:Number.isFinite(overrides.marketImpactBps)?Number(overrides.marketImpactBps):config.marketImpactBps
  };
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

function position(state:PortfolioState,symbol:string):PositionState{
  return state.positions[symbol] ?? {qty:0,avgPrice:0,costBasis:0,realizedPnl:0};
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
  state.marks[q.symbol]=q;
  ensureDailyRiskState(state,q.ts);
}

export function planOrder(
  signal:Signal,
  q:Quote,
  state:PortfolioState,
  reservations:ExecutionReservations={reservedBuyCash:0,reservedGrossExposure:0,reservedSellQty:{}},
  costOverrides:ExecutionCostOverrides={}
):PlannedOrder{
  if(signal.action==="HOLD") return {accepted:false,reason:"SIGNAL_HOLD"};

  const side:Side=signal.action;
  ensureDailyRiskState(state,signal.ts);
  const hasBook=Number.isFinite(Number(q.bid))
    && Number(q.bid)>0
    && Number.isFinite(Number(q.ask))
    && Number(q.ask)>0
    && Number(q.ask)>=Number(q.bid);
  const hasDepth=Number(q.bidSize??0)>0 && Number(q.askSize??0)>0;
  const verifiedBook=hasBook
    && hasDepth
    && !String(q.dataQuality??"").toLowerCase().includes("unverified");

  // Entries require a verified executable book. Risk-reducing SELLs may fall
  // back to last price during a degraded feed so positions can still be closed.
  const referencePrice=side==="BUY"
    ? (verifiedBook?Number(q.ask):0)
    : (verifiedBook?Number(q.bid):usablePrice(q.last,q.bid,q.ask));
  if(side==="BUY" && !referencePrice){
    return {accepted:false,reason:"BUY_BLOCKED_NO_VERIFIED_BOOK"};
  }
  if(side==="SELL" && !referencePrice){
    return {accepted:false,reason:"NO_EXIT_PRICE"};
  }

  const pos=position(state,q.symbol);
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
    const estimatedAllInPerShare=referencePrice*(1+slippageRate)*(1+feeRate);
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
      symbol:q.symbol,side,notional,
      grossExposure:currentGrossExposure(state)+Math.max(0,reservations.reservedGrossExposure),
      currentPositionNotional:currentNotional,
      cash:availableCash
    });
    if(!risk.ok) return {accepted:false,reason:risk.reason};
    recent.push(orderNowMs);
    return {
      accepted:true,symbol:q.symbol,side,qty,referencePrice,
      visibleDepth:verifiedBook?(q.askLevels?.length?q.askLevels.reduce((s,l)=>s+Math.max(0,l.size),0):Number(q.askSize??0)):0,
      depthLevels:verifiedBook && q.depthComplete ? q.askLevels:undefined,
      depthComplete:verifiedBook && q.depthComplete===true,
      spreadBps:verifiedBook
        ? ((Number(q.ask)-Number(q.bid))/Number(q.last||q.ask))*10_000 : 0,
      reason:signal.reason
    };
  }

  const reservedForSymbol=Math.max(0,Number(reservations.reservedSellQty[q.symbol]??0));
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
    symbol:q.symbol,side,notional,
    grossExposure:currentGrossExposure(state)+Math.max(0,reservations.reservedGrossExposure),
    currentPositionNotional:currentNotional,
    cash:Math.max(0,state.cash-Math.max(0,reservations.reservedBuyCash))
  });
    if(!risk.ok) return {accepted:false,reason:risk.reason};
  return {
    accepted:true,symbol:q.symbol,side,qty,referencePrice,
    visibleDepth:verifiedBook?(q.bidLevels?.length?q.bidLevels.reduce((s,l)=>s+Math.max(0,l.size),0):Number(q.bidSize??0)):0,
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
  const costs=executionCosts(costOverrides);
  const slippageRate=costs.slippageBps/10000;
  const feeRate=costs.feeBps/10000;
  const taxRate=order.side==="SELL"?costs.sellTaxBps/10000:0;
  const participation=order.visibleDepth>0
    ? Math.min(1,Math.max(0,order.qty/order.visibleDepth))
    : 0;
  const impactRate=(costs.marketImpactBps/10000)*Math.sqrt(participation);
  const totalPricePenalty=slippageRate+impactRate;
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
  const notional=fillPrice*order.qty;
  const fee=notional*(feeRate+taxRate);
  const slippage=Math.abs(fillPrice-order.referencePrice)*order.qty;
  const totalCashDelta=order.side==="BUY"
    ? -(notional+fee)
    : (notional-fee);
  return {
    symbol:order.symbol,side:order.side,qty:order.qty,
    referencePrice:order.referencePrice,fillPrice,notional,fee,slippage,totalCashDelta
  };
}

export function applyFill(state:PortfolioState,fill:SimulatedFill){
  const pos=position(state,fill.symbol);
  if(fill.side==="BUY"){
    const newQty=pos.qty+fill.qty;
    const newCost=pos.costBasis+fill.notional+fill.fee;
    state.positions[fill.symbol]={
      qty:newQty,avgPrice:newCost/newQty,costBasis:newCost,realizedPnl:pos.realizedPnl
    };
  }else{
    if(fill.qty>pos.qty) throw new Error("SELL_EXCEEDS_POSITION");
    const realized=(fill.notional-fill.fee)-(pos.avgPrice*fill.qty);
    const newQty=pos.qty-fill.qty;
    const newCost=Math.max(0,pos.costBasis-(pos.avgPrice*fill.qty));
    state.positions[fill.symbol]={
      qty:newQty,
      avgPrice:newQty>0?newCost/newQty:0,
      costBasis:newCost,
      realizedPnl:pos.realizedPnl+realized
    };
  }
  state.cash+=fill.totalCashDelta;
  state.fees+=fill.fee;
  state.dailyTurnover=(Number(state.dailyTurnover??0)+fill.notional);
  state.slippageCost+=fill.slippage;
}

export function currentGrossExposure(state:PortfolioState){
  return Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[symbol];
    const price=usablePrice(q?.last,q?.bid,q?.ask,pos.avgPrice);
    return sum+Math.max(0,pos.qty*price);
  },0);
}

export function snapshot(state:PortfolioState){
  const marketValue=Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[symbol];
    const liquidationPrice=usablePrice(q?.bid,q?.last,q?.ask,pos.avgPrice);
    return sum+Math.max(0,pos.qty*liquidationPrice);
  },0);
  const grossExposure=currentGrossExposure(state);
  const realizedPnl=Object.values(state.positions).reduce((sum,p)=>sum+p.realizedPnl,0);
  const unrealizedPnl=Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[symbol];
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
