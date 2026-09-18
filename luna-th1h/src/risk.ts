import {config} from "./config.js";
export function validateOrder(symbol:string,notional:number,grossExposure:number){
  if(notional>config.initialCapital*config.maxPositionPct) return {ok:false,reason:"MAX_POSITION"};
  if(grossExposure+notional>config.initialCapital*config.maxGrossExposurePct) return {ok:false,reason:"MAX_GROSS_EXPOSURE"};
  return {ok:true as const};
}
