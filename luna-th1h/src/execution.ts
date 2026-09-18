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
}

export type PlannedOrder = {
  accepted:true;
  symbol:string;
  side:Side;
  qty:number;
  referencePrice:number;
  reason:string;
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
  return {cash:initialCapital,initialCapital,fees:0,slippageCost:0,positions:{},marks:{}};
}

function position(state:PortfolioState,symbol:string):PositionState{
  return state.positions[symbol] ?? {qty:0,avgPrice:0,costBasis:0,realizedPnl:0};
}

function roundDown(n:number){
  return Math.max(0,Math.floor(n));
}

export function mark(state:PortfolioState,q:Quote){
  state.marks[q.symbol]=q;
}

export function planOrder(signal:Signal,q:Quote,state:PortfolioState):PlannedOrder{
  if(signal.action==="HOLD") return {accepted:false,reason:"SIGNAL_HOLD"};

  const side:Side=signal.action;
  const referencePrice=side==="BUY"?q.ask:q.bid;
  if(!referencePrice || referencePrice<=0) return {accepted:false,reason:"NO_EXECUTABLE_PRICE"};

  const pos=position(state,q.symbol);
  const currentNotional=pos.qty*referencePrice;
  const maxPositionNotional=state.initialCapital*config.maxPositionPct;

  if(side==="BUY"){
    const remainingPosition=Math.max(0,maxPositionNotional-currentNotional);
    const targetNotional=state.initialCapital*config.entryNotionalPct;
    const slippageRate=config.slippageBps/10000;
    const feeRate=config.feeBps/10000;
    const estimatedAllInPerShare=referencePrice*(1+slippageRate)*(1+feeRate);
    const affordable=state.cash/estimatedAllInPerShare;
    let qty=roundDown(Math.min(remainingPosition/referencePrice,targetNotional/referencePrice,affordable));
    if(q.askSize && q.askSize>0) qty=Math.min(qty,roundDown(q.askSize));
    if(qty<=0) return {accepted:false,reason:"INSUFFICIENT_CASH_OR_POSITION_HEADROOM"};

    const notional=qty*referencePrice;
    const risk=validateOrder({
      symbol:q.symbol,side,notional,
      grossExposure:currentGrossExposure(state),
      currentPositionNotional:currentNotional,
      cash:state.cash
    });
    if(!risk.ok) return risk;
    return {accepted:true,symbol:q.symbol,side,qty,referencePrice,reason:signal.reason};
  }

  if(pos.qty<=0) return {accepted:false,reason:"NO_LONG_POSITION"};
  let qty=pos.qty;
  if(q.bidSize && q.bidSize>0) qty=Math.min(qty,roundDown(q.bidSize));
  if(qty<=0) return {accepted:false,reason:"NO_SELLABLE_LIQUIDITY"};

  const notional=qty*referencePrice;
  const risk=validateOrder({
    symbol:q.symbol,side,notional,
    grossExposure:currentGrossExposure(state),
    currentPositionNotional:currentNotional,
    cash:state.cash
  });
  if(!risk.ok) return risk;
  return {accepted:true,symbol:q.symbol,side,qty,referencePrice,reason:signal.reason};
}

export function simulateFill(order:Extract<PlannedOrder,{accepted:true}>):SimulatedFill{
  const slippageRate=config.slippageBps/10000;
  const feeRate=config.feeBps/10000;
  const taxRate=order.side==="SELL"?config.sellTaxBps/10000:0;
  const fillPrice=order.side==="BUY"
    ? order.referencePrice*(1+slippageRate)
    : order.referencePrice*(1-slippageRate);
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
  state.slippageCost+=fill.slippage;
}

export function currentGrossExposure(state:PortfolioState){
  return Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[symbol];
    const price=q?.last ?? q?.bid ?? q?.ask ?? pos.avgPrice;
    return sum+Math.max(0,pos.qty*price);
  },0);
}

export function snapshot(state:PortfolioState){
  const marketValue=Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[symbol];
    const liquidationPrice=q?.bid ?? q?.last ?? q?.ask ?? pos.avgPrice;
    return sum+Math.max(0,pos.qty*liquidationPrice);
  },0);
  const grossExposure=currentGrossExposure(state);
  const realizedPnl=Object.values(state.positions).reduce((sum,p)=>sum+p.realizedPnl,0);
  const unrealizedPnl=Object.entries(state.positions).reduce((sum,[symbol,pos])=>{
    const q=state.marks[symbol];
    const markPrice=q?.bid ?? q?.last ?? q?.ask ?? pos.avgPrice;
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
