import type {Quote,Signal} from "./types.js";
import {computeSignalSizing} from "./sizing.js";

export const VERSION="luna-th1h-v1.4.0-15m-riskgated";
export const PRICE_ONLY_VERSION="luna-th1h-v1.0.0-price-only-paper-warm5";

const BAR_INTERVAL_MS=15*60_000;

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
  cooldownMs:5*60_000,
  maxHoldMs:15*60_000,
  stopLossBps:75,
  takeProfitBps:125
};

interface SymbolState{
  completedBars:number[];
  emaFast:number|null;
  emaSlow:number|null;
  previousFast:number|null;
  previousSlow:number|null;
  currentBarStartMs:number|null;
  currentBarClose:number|null;
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
    completedBars:[],
    emaFast:null,
    emaSlow:null,
    previousFast:null,
    previousSlow:null,
    currentBarStartMs:null,
    currentBarClose:null,
    lastDecisionTs:0,
    entryTs:null
  };
  states.set(symbol,created);
  return created;
}

function finite(value:number|null|undefined):value is number{
  return typeof value==="number" && Number.isFinite(value) && value>0;
}

function bucketStartMs(ts:string){
  const ms=Date.parse(ts);
  if(!Number.isFinite(ms)) return null;
  return Math.floor(ms/BAR_INTERVAL_MS)*BAR_INTERVAL_MS;
}

function pushCompletedBar(st:SymbolState,close:number,params:StrategyParams){
  if(!finite(close)) return;
  st.previousFast=st.emaFast;
  st.previousSlow=st.emaSlow;
  st.emaFast=ema(st.emaFast,close,params.fastPeriod);
  st.emaSlow=ema(st.emaSlow,close,params.slowPeriod);
  st.completedBars.push(close);
  if(st.completedBars.length>80) st.completedBars.shift();
}

export class StrategyV1{
  readonly version:string;
  readonly params:StrategyParams;
  readonly priceOnlyFallback:boolean;
  private states=new Map<string,SymbolState>();

  constructor(params:Partial<StrategyParams>={},opts:{priceOnlyFallback?:boolean}={}){
    this.priceOnlyFallback=Boolean(opts.priceOnlyFallback);
    // Strategy identity stays on the production 15m engine. Data-access mode
    // (verified book vs paper price-only fallback) is an execution/data-state,
    // not a different strategy version.
    this.version=VERSION;
    this.params={...DEFAULT_PARAMS,...params};
    if(this.params.fastPeriod>=this.params.slowPeriod){
      throw new Error("fastPeriod must be smaller than slowPeriod");
    }
  }

  reset(){
    this.states.clear();
  }

  prime(symbol:string,barCloses:number[]){
    const st=stateFor(this.states,symbol);
    st.completedBars=[];
    st.emaFast=null;
    st.emaSlow=null;
    st.previousFast=null;
    st.previousSlow=null;
    st.currentBarStartMs=null;
    st.currentBarClose=null;
    st.lastDecisionTs=0;
    st.entryTs=null;
    for(const price of barCloses.slice(-80)){
      if(finite(price)) pushCompletedBar(st,price,this.params);
    }
  }

  primeIfSparse(symbol:string,barCloses:number[],maxLiveBars=2){
    if(!barCloses.length) return false;
    const st=stateFor(this.states,symbol);
    if(st.completedBars.length>maxLiveBars || st.currentBarStartMs!==null) return false;
    this.prime(symbol,barCloses);
    return true;
  }

  private evaluatePosition(q:Quote,ctx:StrategyContext,st:SymbolState):Signal|null{
    if(ctx.positionQty<=0) return null;
    if(st.entryTs===null) st.entryTs=ctx.nowMs;
    const executableSellPrice=finite(q.bid)?Number(q.bid):(finite(q.last)?Number(q.last):0);
    const stopLoss=ctx.avgPrice*(1-this.params.stopLossBps/10_000);
    const takeProfit=ctx.avgPrice*(1+this.params.takeProfitBps/10_000);
    const trendBroken=st.emaFast!==null && st.emaSlow!==null && st.emaFast<st.emaSlow;
    const timedOut=ctx.nowMs-st.entryTs>=this.params.maxHoldMs;
    if(executableSellPrice>0 && executableSellPrice<=stopLoss){
      st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
      return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"STOP_LOSS_EXECUTABLE_BID",strategyVersion:this.version};
    }
    if(executableSellPrice>0 && executableSellPrice>=takeProfit){
      st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
      return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"TAKE_PROFIT_EXECUTABLE_BID",strategyVersion:this.version};
    }
    if(trendBroken){
      st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
      return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"15M_EMA_TREND_BREAK",strategyVersion:this.version};
    }
    if(timedOut){
      st.lastDecisionTs=ctx.nowMs; st.entryTs=null;
      return {symbol:q.symbol,ts:q.ts,action:"SELL",reason:"MAX_HOLD_TIME",strategyVersion:this.version};
    }
    return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"HOLD_POSITION_15M",strategyVersion:this.version};
  }

  evaluate(q:Quote,ctx:StrategyContext):Signal{
    if(q.symbol.startsWith("__")){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"NON_TRADABLE_SYMBOL",strategyVersion:this.version};
    }
    if(!finite(q.last)){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"INVALID_QUOTE_LAST",strategyVersion:this.version};
    }

    const hasBook=finite(q.bid) && finite(q.ask) && Number(q.bid)<=Number(q.ask);
    const hasDepth=hasBook && Number(q.bidSize??0)>0 && Number(q.askSize??0)>0;
    const verifiedBook=hasDepth && !String(q.dataQuality??"").toLowerCase().includes("unverified");
    const allowPaperPriceOnly =
      this.priceOnlyFallback
      && String(process.env.LUNA_MODE ?? "paper").toLowerCase()==="paper"
      && String(process.env.LIVE_TRADING_ARMED ?? "false").toLowerCase()!=="true"
      && String(q.source ?? "").toLowerCase().includes("tradingview-public-screener");

    const st=stateFor(this.states,q.symbol);
    const positionBeforeBar=this.evaluatePosition(q,ctx,st);
    if(positionBeforeBar?.action==="SELL") return positionBeforeBar;

    const bucket=bucketStartMs(q.sourceTs ?? q.ts);
    let completedNewBar=false;
    if(bucket!==null){
      if(st.currentBarStartMs===null){
        st.currentBarStartMs=bucket;
        st.currentBarClose=q.last;
      }else if(bucket>st.currentBarStartMs){
        if(finite(st.currentBarClose)){
          pushCompletedBar(st,st.currentBarClose,this.params);
          completedNewBar=true;
        }
        st.currentBarStartMs=bucket;
        st.currentBarClose=q.last;
      }else if(bucket===st.currentBarStartMs){
        st.currentBarClose=q.last;
      }
    }

    if(ctx.positionQty>0){
      if(positionBeforeBar?.action==="HOLD" && !completedNewBar) return positionBeforeBar;
      return this.evaluatePosition(q,ctx,st) ?? {
        symbol:q.symbol,
        ts:q.ts,
        action:"HOLD",
        reason:"HOLD_POSITION_15M",
        strategyVersion:this.version
      };
    }

    if(!verifiedBook && !allowPaperPriceOnly){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"ENTRY_BLOCKED_BOOK_UNVERIFIED",strategyVersion:this.version};
    }
    if(!completedNewBar || st.completedBars.length<Math.max(this.params.slowPeriod,2) || st.emaFast===null || st.emaSlow===null){
      return {
        symbol:q.symbol,ts:q.ts,action:"HOLD",
        reason:completedNewBar?"WARMUP_15M":"WAIT_15M_BAR_CLOSE",
        strategyVersion:this.version
      };
    }
    if(ctx.nowMs-st.lastDecisionTs<this.params.cooldownMs){
      return {symbol:q.symbol,ts:q.ts,action:"HOLD",reason:"COOLDOWN_15M",strategyVersion:this.version};
    }

    const previousBar=st.completedBars.at(-1)!;
    const priorBar=st.completedBars.at(-2)!;
    const momentumBps=((previousBar/priorBar)-1)*10_000;
    const trendUp=st.emaFast>st.emaSlow;
    const trendGapBps=st.emaSlow>0?((st.emaFast/st.emaSlow)-1)*10_000:0;
    const spreadBps=hasBook
      ? ((Number(q.ask)-Number(q.bid))/Number(q.last))*10_000
      : Number.POSITIVE_INFINITY;
    const imbalance=hasDepth
      ? (Number(q.bidSize??0)-Number(q.askSize??0))/(Number(q.bidSize??0)+Number(q.askSize??0))
      : 0;

    const entryOk=trendUp
      && momentumBps>=this.params.minMomentumBps
      && (allowPaperPriceOnly || (
        spreadBps<=this.params.maxSpreadBps
        && imbalance>=this.params.minImbalance
      ));

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
        reason:(allowPaperPriceOnly
          ?"15M_CLOSED_BAR PRICE_ONLY_PAPER EMA5>EMA20"
          :"15M_CLOSED_BAR VERIFIED_BOOK EMA5>EMA20")
          +" momentum="+momentumBps.toFixed(2)+"bps"
          +" spread="+(Number.isFinite(spreadBps)?spreadBps.toFixed(2)+"bps":"NA")
          +" imbalance="+(allowPaperPriceOnly?"NA":imbalance.toFixed(3))
          +" strength="+sizing.strength.toFixed(3)
          +" target="+(sizing.targetFraction*100).toFixed(1)+"%",
        strategyVersion:this.version,
        signalStrength:sizing.strength,
        targetAllocationPct:sizing.targetFraction*100,
        sizingReason:"timeframe=15m "+sizing.reason
      };
    }

    return {
      symbol:q.symbol,ts:q.ts,action:"HOLD",
      reason:"NO_ENTRY_15M momentum="+momentumBps.toFixed(2)
        +"bps spread="+spreadBps.toFixed(2)
        +"bps imbalance="+imbalance.toFixed(3),
      strategyVersion:this.version
    };
  }
}

export function strategyCodeHash(){return VERSION;}
