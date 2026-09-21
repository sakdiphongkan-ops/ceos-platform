export type Side = "BUY" | "SELL";

export interface Quote {
  symbol:string; ts:string; bid:number|null; ask:number|null; last:number|null;
  bidSize:number|null; askSize:number|null; source:string; dataQuality?:string;
}
export interface Signal {
  symbol:string; ts:string; action:"BUY"|"SELL"|"HOLD"; reason:string; strategyVersion:string;
}
