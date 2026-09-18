import type {Quote,Signal} from "./types.js";

export const VERSION="luna-th1h-v1.0.0";

export interface StrategyParams{
  fastPeriod:number;
  slowPeriod:number;
  minMomentumBps:number;
  maxSpreadBps:number;
  minImbalance:number;
  cooldownMs:number;
  maxHoldMs:number;
  stopLossBps:number;
  takeProfitBps:number;
}

export const DEFAULT_PARAMS:StrategyParams={
  fastPeriod:5,
  slowPeriod:20,
  minMomentumBps:8,
  maxSpreadBps:25,
  minImbalance:0.05,
  cooldownMs:30_000,
  maxHoldMs:10*60_000,
  stopLossBps:50,
  takeProfitBps:100
};

interface SymbolState{
  prices:number[];
  emaFast:number|null;
  emaSlow:number|null;
  previousFast:number|null;
  previousSlow:number|null;
  lastDecisionTs:number;
  entryTs:number|null;
}

export interface StrategyContext{
  positionQty:number;
  avgPrice:number;
  nowMs:number;
}

function ema(previous:number|null,value:number,period:number){
  if(previous===null) return value;
  const k=2/(period+1);
  return previous+(value-previous)*k;
}

function stateFor(states:Map<string,SymbolState>,symbol:string){
  const existing=states.get(symbol);
  if(existing) return existing;
  const created:SymbolState={
    prices:[],emaFast:null,emaSlow:null,previousFast:null,previousSlow:null,
    lastDecisionTs:0,entryTs:null
  };
  states.set(symbol,created);
  return created;
}

function finite(value:number|null|undefined):value is number{
  return typeof value==="number" && Number.isFinite(value) && value>0;
}

export class StrategyV1{
  readonly version=VERSION;
  readonly params:StrategyParams;
  private states=new Map<string,SymbolState>();

  constructor(params:Partial<StrategyParams>={}){
    this.params={...DEFAULT_PARAMS,...params};
    if(this.params.fastPeriod>=this.params.slowPeriod){
      throw new Error("fastPeriod must be smaller than slowPeriod");
    }
  }

  evaluate(q:Quote,ctx:StrategyContext):Signal{
    if(q.symbol.startsWith("__")){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"NON_TRADABLE_SYMBOL",strategyVersion:VERSION};
    }

    const price=q.last;
    if(!finite(price) || !finite(q.bid) || !finite(q.ask)){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"INVALID_QUOTE",strategyVersion:VERSION};
    }

    const st=stateFor(this.states,q.symbol);
    st.prices.push(price);
    if(st.prices.length>this.params.slowPeriod*4) st.prices.shift();

    st.previousFast=st.emaFast;
    st.previousSlow=st.emaSlow;
    st.emaFast=ema(st.emaFast,price,this.params.fastPeriod);
    st.emaSlow=ema(st.emaSlow,price,this.params.slowPeriod);

    const spreadBps=((q.ask-q.bid)/price)*10_000;
    const imbalance=(Number(q.bidSize??0)+Number(q.askSize??0))>0
      ? (Number(q.bidSize??0)-Number(q.askSize??0))/(Number(q.bidSize??0)+Number(q.askSize??0))
      : 0;
    const previousPrice=st.prices.length>=2?st.prices[st.prices.length-2]:null;
    const momentumBps=previousPrice?((price/previousPrice)-1)*10_000:0;

    if(st.prices.length<this.params.slowPeriod || st.emaFast===null || st.emaSlow===null){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"WARMUP",strategyVersion:VERSION};
    }

    if(ctx.positionQty>0){
      if(st.entryTs===null) st.entryTs=ctx.nowMs;
      const stopLoss=ctx.avgPrice*(1-this.params.stopLossBps/10_000);
      const takeProfit=ctx.avgPrice*(1+this.params.takeProfitBps/10_000);
      const crossDown=st.previousFast!==null && st.previousSlow!==null &&
        st.previousFast>=st.previousSlow && st.emaFast<st.emaSlow;
      const timedOut=ctx.nowMs-st.entryTs>=this.params.maxHoldMs;

      if(crossDown){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"EMA_CROSS_DOWN",strategyVersion:VERSION};
      }
      if(price<=stopLoss){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"STOP_LOSS",strategyVersion:VERSION};
      }
      if(price>=takeProfit){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"TAKE_PROFIT",strategyVersion:VERSION};
      }
      if(timedOut){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"MAX_HOLD_TIME",strategyVersion:VERSION};
      }

      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"HOLD_POSITION",strategyVersion:VERSION};
    }

    if(ctx.nowMs-st.lastDecisionTs<this.params.cooldownMs){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"COOLDOWN",strategyVersion:VERSION};
    }

    const crossUp=st.previousFast!==null && st.previousSlow!==null &&
      st.previousFast<=st.previousSlow && st.emaFast>st.emaSlow;

    if(crossUp && momentumBps>=this.params.minMomentumBps && spreadBps<=this.params.maxSpreadBps && imbalance>=this.params.minImbalance){
      st.lastDecisionTs=ctx.nowMs;
      st.entryTs=ctx.nowMs;
      return {
        symbol:q.symbol,ts:q.ts,action:"BUY",
        reason:`EMA_CROSS_UP momentum=${momentumBps.toFixed(2)}bps spread=${spreadBps.toFixed(2)}bps imbalance=${imbalance.toFixed(3)}`,
        strategyVersion:VERSION
      };
    }

    return {
      symbol:q.symbol,ts:q.ts,action:"HOLD",
      reason:`NO_ENTRY momentum=${momentumBps.toFixed(2)}bps spread=${spreadBps.toFixed(2)}bps imbalance=${imbalance.toFixed(3)}`,
      strategyVersion:VERSION
    };
  }
}

export function strategyCodeHash(){
  return VERSION;
}
