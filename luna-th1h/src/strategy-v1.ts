import type {Quote,Signal} from "./types.js";
import {computeSignalSizing} from "./sizing.js";

export const VERSION="luna-th1h-v1.0.0";
export const PRICE_ONLY_VERSION="luna-th1h-v1.0.0-price-only-paper-warm5";

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
  readonly version:string;
  readonly params:StrategyParams;
  readonly priceOnlyFallback:boolean;
  private states=new Map<string,SymbolState>();

  constructor(params:Partial<StrategyParams>={},opts:{priceOnlyFallback?:boolean}={}){
    this.priceOnlyFallback=Boolean(opts.priceOnlyFallback);
    this.version=this.priceOnlyFallback?PRICE_ONLY_VERSION:VERSION;
    this.params={...DEFAULT_PARAMS,...params};
    if(this.params.fastPeriod>=this.params.slowPeriod){
      throw new Error("fastPeriod must be smaller than slowPeriod");
    }
  }

  reset(){
    this.states.clear();
  }

  prime(symbol:string,prices:number[]){
    const st=stateFor(this.states,symbol);
    st.prices=[];
    st.emaFast=null;
    st.emaSlow=null;
    st.previousFast=null;
    st.previousSlow=null;
    st.lastDecisionTs=0;
    st.entryTs=null;
    for(const price of prices){
      if(!finite(price)) continue;
      st.previousFast=st.emaFast;
      st.previousSlow=st.emaSlow;
      st.emaFast=ema(st.emaFast,price,this.params.fastPeriod);
      st.emaSlow=ema(st.emaSlow,price,this.params.slowPeriod);
      st.prices.push(price);
      if(st.prices.length>this.params.slowPeriod*4) st.prices.shift();
    }
  }

  primeIfSparse(symbol:string,prices:number[],maxLivePrices=2){
    if(!prices.length) return false;
    const st=stateFor(this.states,symbol);
    if(st.prices.length>maxLivePrices) return false;
    const livePrices=[...st.prices];
    this.prime(symbol,prices);
    const replay=stateFor(this.states,symbol);
    for(const price of livePrices){
      if(!finite(price)) continue;
      replay.previousFast=replay.emaFast;
      replay.previousSlow=replay.emaSlow;
      replay.emaFast=ema(replay.emaFast,price,this.params.fastPeriod);
      replay.emaSlow=ema(replay.emaSlow,price,this.params.slowPeriod);
      replay.prices.push(price);
      if(replay.prices.length>this.params.slowPeriod*4) replay.prices.shift();
    }
    return true;
  }

  evaluate(q:Quote,ctx:StrategyContext):Signal{
    if(q.symbol.startsWith("__")){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"NON_TRADABLE_SYMBOL",strategyVersion:this.version};
    }

    const price=q.last;
    if(!finite(price)){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"INVALID_QUOTE_LAST",strategyVersion:this.version};
    }
    const hasBook=finite(q.bid) && finite(q.ask) && Number(q.bid)<=Number(q.ask);
    if(!hasBook && !this.priceOnlyFallback){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"INVALID_QUOTE_BOOK_REQUIRED",strategyVersion:this.version};
    }

    const st=stateFor(this.states,q.symbol);
    st.prices.push(price);
    if(st.prices.length>this.params.slowPeriod*4) st.prices.shift();

    st.previousFast=st.emaFast;
    st.previousSlow=st.emaSlow;
    st.emaFast=ema(st.emaFast,price,this.params.fastPeriod);
    st.emaSlow=ema(st.emaSlow,price,this.params.slowPeriod);

    const spreadBps=hasBook?((Number(q.ask)-Number(q.bid))/price)*10_000:0;
    const imbalance=hasBook && (Number(q.bidSize??0)+Number(q.askSize??0))>0
      ? (Number(q.bidSize??0)-Number(q.askSize??0))/(Number(q.bidSize??0)+Number(q.askSize??0))
      : 0;
    const previousPrice=st.prices.length>=2?st.prices[st.prices.length-2]:null;
    const momentumBps=previousPrice?((price/previousPrice)-1)*10_000:0;

    const warmupPeriod=this.priceOnlyFallback?Math.min(this.params.fastPeriod,5):this.params.slowPeriod;
    if(st.prices.length<warmupPeriod || st.emaFast===null || st.emaSlow===null){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"WARMUP",strategyVersion:this.version};
    }

    if(ctx.positionQty>0){
      if(st.entryTs===null) st.entryTs=ctx.nowMs;
      const stopLoss=ctx.avgPrice*(1-this.params.stopLossBps/10_000);
      const takeProfit=ctx.avgPrice*(1+this.params.takeProfitBps/10_000);
      const trendBroken=st.emaFast<st.emaSlow;
      const timedOut=ctx.nowMs-st.entryTs>=this.params.maxHoldMs;

      if(trendBroken){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"EMA_TREND_BREAK",strategyVersion:this.version};
      }
      if(price<=stopLoss){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"STOP_LOSS",strategyVersion:this.version};
      }
      if(price>=takeProfit){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"TAKE_PROFIT",strategyVersion:this.version};
      }
      if(timedOut){
        st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
        return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"MAX_HOLD_TIME",strategyVersion:this.version};
      }

      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"HOLD_POSITION",strategyVersion:this.version};
    }

    if(ctx.nowMs-st.lastDecisionTs<this.params.cooldownMs){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"COOLDOWN",strategyVersion:this.version};
    }

    const trendUp=st.emaFast>st.emaSlow;
    const trendGapBps=st.emaSlow>0?((st.emaFast/st.emaSlow)-1)*10_000:0;

    const entryOk = trendUp
      && momentumBps>=this.params.minMomentumBps
      && (this.priceOnlyFallback ? true : spreadBps<=this.params.maxSpreadBps && imbalance>=this.params.minImbalance);

    if(entryOk){
      st.lastDecisionTs=ctx.nowMs;
      st.entryTs=ctx.nowMs;
      const sizing=computeSignalSizing({
        momentumBps,
        minMomentumBps:this.params.minMomentumBps,
        trendGapBps,
        hasBook,
        dataQuality:q.dataQuality
      });
      return {
        symbol:q.symbol,ts:q.ts,action:"BUY",
        reason:(this.priceOnlyFallback && !hasBook ? "PRICE_ONLY_FALLBACK " : "")
          + "EMA_TREND_UP momentum="+momentumBps.toFixed(2)+"bps"
          + " spread="+spreadBps.toFixed(2)+"bps"
          + " imbalance="+imbalance.toFixed(3)
          + " strength="+sizing.strength.toFixed(3)
          + " target="+(sizing.targetFraction*100).toFixed(1)+"%",
        strategyVersion:this.version,
        signalStrength:sizing.strength,
        targetAllocationPct:sizing.targetFraction*100,
        sizingReason:sizing.reason
      };
    }
    return {
      symbol:q.symbol,ts:q.ts,action:"HOLD",
      reason:`${this.priceOnlyFallback && !hasBook ? "PRICE_ONLY_FALLBACK " : ""}NO_ENTRY momentum=${momentumBps.toFixed(2)}bps spread=${spreadBps.toFixed(2)}bps imbalance=${imbalance.toFixed(3)}`,
      strategyVersion:this.version
    };
  }
}

export function strategyCodeHash(){
  return VERSION;
}
