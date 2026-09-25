import type {Quote,Side} from "./types.js";
import type {MarketPhase} from "./market-session.js";

export type LiveExecutionControl={
  execution_mode:string;
  armed:boolean;
  kill_switch:boolean;
  observe_only?:boolean;
  max_order_notional?:number;
};

export type LiveSafetyInput={
  control:LiveExecutionControl;
  marketPhase:MarketPhase;
  quote:Quote;
  side:Side;
  qty:number;
  referencePrice:number;
  maxOrderNotional:number;
  maxDailyLoss:number;
  dailyPnl:number;
  maxDailyTurnover:number;
  dailyTurnover:number;
  quoteMaxAgeMs:number;
  maxQuoteDeviationBps:number;
  maxClockSkewMs:number;
  clockSkewMs:number;
  reconciliationOk:boolean;
  gatewayHealthy:boolean;
  gatewayLiveArmed:boolean;
  hardOrderGateEnabled:boolean;
  nowMs?:number;
};

const LIVE_SAFETY_APPROVAL=Symbol("LUNA_LIVE_SAFETY_APPROVAL");
export type LiveSafetyApproval={readonly [LIVE_SAFETY_APPROVAL]:true;issuedAtMs:number};
export type LiveSafetyDecision={ok:true}|{ok:false;reason:string};

export type LiveSafetyStatus={
  tripped:boolean;
  tripReason:string|null;
  consecutiveGatewayFailures:number;
  lastTripAtMs:number|null;
};

export class LiveSafetyKernel{
  private tripped=false;
  private tripReason:string|null=null;
  private consecutiveGatewayFailures=0;
  private lastTripAtMs:number|null=null;
  private readonly gatewayFailureTripCount:number;

  constructor(options:{gatewayFailureTripCount?:number}={}){
    this.gatewayFailureTripCount=Math.max(1,Math.floor(options.gatewayFailureTripCount??3));
  }

  status():LiveSafetyStatus{
    return {
      tripped:this.tripped,
      tripReason:this.tripReason,
      consecutiveGatewayFailures:this.consecutiveGatewayFailures,
      lastTripAtMs:this.lastTripAtMs
    };
  }

  trip(reason:string,nowMs=Date.now()){
    this.tripped=true;
    this.tripReason=reason;
    this.lastTripAtMs=nowMs;
  }

  recordGatewayFailure(reason:string,nowMs=Date.now()){
    this.consecutiveGatewayFailures++;
    if(this.consecutiveGatewayFailures>=this.gatewayFailureTripCount){
      this.trip(`GATEWAY_CIRCUIT_BREAKER:${reason}`,nowMs);
    }
  }

  recordSuccess(){
    this.consecutiveGatewayFailures=0;
  }

  recordReconciliationFailure(reason:string,nowMs=Date.now()){
    this.trip(`RECONCILIATION_FAIL_CLOSED:${reason}`,nowMs);
  }

  recordFeedFailure(reason:string,nowMs=Date.now()){
    this.trip(`FEED_FAIL_CLOSED:${reason}`,nowMs);
  }

  issueApproval(input:LiveSafetyInput):LiveSafetyApproval|LiveSafetyDecision{
    const decision=this.evaluate(input);
    if(!decision.ok) return decision;
    return {[LIVE_SAFETY_APPROVAL]:true,issuedAtMs:Date.now()} as LiveSafetyApproval;
  }

  evaluate(input:LiveSafetyInput):LiveSafetyDecision{
    const evaluationNowMs=input.nowMs??Date.now();
    if(this.tripped) return {ok:false,reason:this.tripReason??"LIVE_SAFETY_KERNEL_TRIPPED"};
    if(!input.hardOrderGateEnabled) return {ok:false,reason:"LIVE_HARD_ORDER_GATE_DISABLED"};
    if(input.control.execution_mode!=="live") return {ok:false,reason:"LIVE_CONTROL_EXECUTION_MODE_MISMATCH"};
    if(input.control.armed!==true) return {ok:false,reason:"LIVE_CONTROL_DISARMED"};
    if(input.control.kill_switch===true) return {ok:false,reason:"LIVE_CONTROL_KILL_SWITCH"};
    if(input.control.observe_only===true) return {ok:false,reason:"LIVE_CONTROL_OBSERVE_ONLY"};
    if(!input.gatewayHealthy) return {ok:false,reason:"LIVE_GATEWAY_UNHEALTHY"};
    if(input.gatewayLiveArmed!==true) return {ok:false,reason:"LIVE_GATEWAY_DISARMED"};
    if(!input.reconciliationOk) return {ok:false,reason:"LIVE_RECONCILIATION_REQUIRED"};
    if(!Number.isFinite(input.clockSkewMs) || Math.abs(input.clockSkewMs)>input.maxClockSkewMs){
      return {ok:false,reason:"LIVE_CLOCK_SKEW"};
    }
    if(input.marketPhase==="CLOSED" || input.marketPhase==="BREAK"){
      return {ok:false,reason:`MARKET_PHASE_BLOCK:${input.marketPhase}`};
    }
    if(input.side==="BUY" && input.marketPhase!=="ACTIVE"){
      return {ok:false,reason:`BUY_PHASE_BLOCK:${input.marketPhase}`};
    }
    if(input.dailyPnl<=-Math.abs(input.maxDailyLoss)) return {ok:false,reason:"LIVE_MAX_DAILY_LOSS"};
    if(input.dailyTurnover>=input.maxDailyTurnover) return {ok:false,reason:"LIVE_MAX_DAILY_TURNOVER"};
    if(!Number.isFinite(input.qty) || input.qty<=0) return {ok:false,reason:"LIVE_INVALID_QTY"};
    if(!Number.isFinite(input.referencePrice) || input.referencePrice<=0){
      return {ok:false,reason:"LIVE_INVALID_REFERENCE_PRICE"};
    }
    const ageMs=evaluationNowMs-Date.parse(input.quote.ts);
    if(!Number.isFinite(ageMs) || ageMs<0 || ageMs>input.quoteMaxAgeMs){
      return {ok:false,reason:"LIVE_QUOTE_STALE_OR_INVALID"};
    }
    const bid=Number(input.quote.bid);
    const ask=Number(input.quote.ask);
    const bidSize=Number(input.quote.bidSize??0);
    const askSize=Number(input.quote.askSize??0);
    if(
      !Number.isFinite(bid) || bid<=0
      || !Number.isFinite(ask) || ask<=0
      || ask<bid
      || bidSize<=0
      || askSize<=0
      || String(input.quote.dataQuality??"").toLowerCase().includes("unverified")
    ){
      return {ok:false,reason:"LIVE_VERIFIED_BOOK_REQUIRED"};
    }
    const executable= input.side==="BUY" ? ask : bid;
    const deviationBps=Math.abs(input.referencePrice-executable)/executable*10_000;
    if(!Number.isFinite(deviationBps) || deviationBps>input.maxQuoteDeviationBps){
      return {ok:false,reason:"LIVE_PRICE_DEVIATION_GUARD"};
    }
    const notional=input.qty*input.referencePrice;
    if(!Number.isFinite(notional) || notional<=0) return {ok:false,reason:"LIVE_INVALID_NOTIONAL"};
    if(notional>input.maxOrderNotional+1e-8) return {ok:false,reason:"LIVE_MAX_ORDER_NOTIONAL"};
    return {ok:true};
  }
}
