import type {Quote} from "./types.js";

export type QuoteQualityReason =
  | "OK"
  | "MISSING_SYMBOL"
  | "INVALID_INGEST_TIMESTAMP"
  | "INGEST_TIMESTAMP_IN_FUTURE"
  | "INVALID_SOURCE_TIMESTAMP"
  | "SOURCE_TIMESTAMP_IN_FUTURE"
  | "SOURCE_TIMESTAMP_AFTER_INGEST"
  | "STALE_QUOTE"
  | "NO_USABLE_PRICE"
  | "INVALID_BID"
  | "INVALID_ASK"
  | "CROSSED_BOOK"
  | "INVALID_BID_SIZE"
  | "INVALID_ASK_SIZE";

export type QuoteQualityResult = {
  ok:boolean;
  reason:QuoteQualityReason;
  ageMs:number|null;
  sourceToIngestMs:number|null;
};

const isPositiveFinite=(value:number|null|undefined)=>Number.isFinite(Number(value)) && Number(value)>0;
const isNonNegativeFinite=(value:number|null|undefined)=>value==null || (Number.isFinite(Number(value)) && Number(value)>=0);

export function assessQuoteQuality(
  quote:Quote,
  nowMs=Date.now(),
  maxAgeMs=2000,
  maxFutureSkewMs=1000
):QuoteQualityResult{
  if(!quote.symbol?.trim()) return {ok:false,reason:"MISSING_SYMBOL",ageMs:null,sourceToIngestMs:null};

  const ingestMs=Date.parse(quote.ts);
  if(!Number.isFinite(ingestMs)) return {ok:false,reason:"INVALID_INGEST_TIMESTAMP",ageMs:null,sourceToIngestMs:null};
  if(ingestMs-nowMs>maxFutureSkewMs){
    return {ok:false,reason:"INGEST_TIMESTAMP_IN_FUTURE",ageMs:ingestMs-nowMs,sourceToIngestMs:null};
  }

  const ageMs=Math.max(0,nowMs-ingestMs);
  if(ageMs>maxAgeMs) return {ok:false,reason:"STALE_QUOTE",ageMs,sourceToIngestMs:null};

  let sourceToIngestMs:number|null=null;
  if(quote.sourceTs){
    const sourceMs=Date.parse(quote.sourceTs);
    if(!Number.isFinite(sourceMs)) return {ok:false,reason:"INVALID_SOURCE_TIMESTAMP",ageMs,sourceToIngestMs:null};
    if(sourceMs-nowMs>maxFutureSkewMs){
      return {ok:false,reason:"SOURCE_TIMESTAMP_IN_FUTURE",ageMs,sourceToIngestMs:null};
    }
    sourceToIngestMs=ingestMs-sourceMs;
    if(sourceToIngestMs<0) return {ok:false,reason:"SOURCE_TIMESTAMP_AFTER_INGEST",ageMs,sourceToIngestMs};
  }

  if(quote.last!=null && !isPositiveFinite(quote.last)) return {ok:false,reason:"NO_USABLE_PRICE",ageMs,sourceToIngestMs};
  if(quote.bid!=null && !isPositiveFinite(quote.bid)) return {ok:false,reason:"INVALID_BID",ageMs,sourceToIngestMs};
  if(quote.ask!=null && !isPositiveFinite(quote.ask)) return {ok:false,reason:"INVALID_ASK",ageMs,sourceToIngestMs};

  const hasPrice=isPositiveFinite(quote.last)||isPositiveFinite(quote.bid)||isPositiveFinite(quote.ask);
  if(!hasPrice) return {ok:false,reason:"NO_USABLE_PRICE",ageMs,sourceToIngestMs};

  if(isPositiveFinite(quote.bid)&&isPositiveFinite(quote.ask)&&Number(quote.bid)>Number(quote.ask)){
    return {ok:false,reason:"CROSSED_BOOK",ageMs,sourceToIngestMs};
  }

  if(!isNonNegativeFinite(quote.bidSize)) return {ok:false,reason:"INVALID_BID_SIZE",ageMs,sourceToIngestMs};
  if(!isNonNegativeFinite(quote.askSize)) return {ok:false,reason:"INVALID_ASK_SIZE",ageMs,sourceToIngestMs};

  return {ok:true,reason:"OK",ageMs,sourceToIngestMs};
}
