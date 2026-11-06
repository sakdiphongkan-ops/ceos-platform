import {config} from "./config.js";

export function validateOrder(input:{
  symbol:string;
  side:"BUY"|"SELL";
  notional:number;
  grossExposure:number;
  currentPositionNotional:number;
  cash:number;
}){
  const finiteInputs=[
    input.notional,input.grossExposure,input.currentPositionNotional,input.cash,
    config.initialCapital,config.maxGrossExposurePct,config.maxPositionPct,config.maxOrderNotional
  ];
  if(!finiteInputs.every(value=>typeof value==="number" && Number.isFinite(value))
    || config.initialCapital<=0
    || config.maxGrossExposurePct<0 || config.maxGrossExposurePct>1
    || config.maxPositionPct<0 || config.maxPositionPct>1
    || config.maxOrderNotional<0
    || input.grossExposure<0 || input.currentPositionNotional<0 || input.cash<0){
    return {ok:false as const,reason:"INVALID_ORDER_INPUT_OR_CONFIG"};
  }
  const maxGross=config.initialCapital*config.maxGrossExposurePct;
  if(!Number.isFinite(maxGross)) return {ok:false as const,reason:"INVALID_RISK_LIMIT"};

  if(input.notional<=0) return {ok:false as const,reason:"INVALID_NOTIONAL"};
  if(input.side==="BUY" && input.notional>config.maxOrderNotional+1e-8){
    return {ok:false as const,reason:"MAX_ORDER_NOTIONAL"};
  }
  if(input.side==="BUY" && input.currentPositionNotional+input.notional>
    config.initialCapital*config.maxPositionPct+1e-8){
    return {ok:false as const,reason:"MAX_POSITION_EXPOSURE"};
  }
  if(input.side==="BUY" && input.grossExposure+input.notional>maxGross+1e-8){
    return {ok:false as const,reason:"MAX_GROSS_EXPOSURE"};
  }
  if(input.side==="BUY" && input.cash<=0){
    return {ok:false as const,reason:"NO_CASH"};
  }
  return {ok:true as const};
}