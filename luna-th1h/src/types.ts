export type Side = "BUY" | "SELL";

export interface Quote {
  symbol:string; ts:string; sourceTs?:string; bid:number|null; ask:number|null; last:number|null;
  bidSize:number|null; askSize:number|null; source:string; dataQuality?:string;
  bidLevels?:Array<{price:number;size:number}>; askLevels?:Array<{price:number;size:number}>;
  // True only when the provider guarantees the supplied L2 levels cover the complete executable depth snapshot.
  depthComplete?:boolean;
}
export interface Signal {
  symbol:string; ts:string; action:"BUY"|"SELL"|"HOLD"; reason:string; strategyVersion:string;
  signalStrength?:number;
  targetAllocationPct?:number;
  sizingReason?:string;
}
