import type {Quote} from "./types.js";

export interface BarOptions{intervalMinutes?:number;timezone?:string}

function floorMs(ms:number,interval:number){
  return Math.floor(ms/interval)*interval;
}

/**
 * Builds deterministic time bars from tick/snapshot quotes.
 * The resulting Quote uses the last valid observation in each bucket.
 * It does NOT manufacture OHLC or order-book values that were not supplied.
 */
export function buildTimeBars(quotes:Quote[],options:BarOptions={}):Quote[]{
  const interval=Math.max(1,options.intervalMinutes??15)*60_000;
  const buckets=new Map<string,Quote>();
  for(const q of quotes){
    const ms=Date.parse(q.ts);
    if(!Number.isFinite(ms)||!q.symbol) continue;
    const bucketTs=new Date(floorMs(ms,interval)).toISOString();
    const key=q.symbol+"|"+bucketTs;
    const existing=buckets.get(key);
    if(!existing || q.ts>existing.ts){
      buckets.set(key,{...q,ts:bucketTs,source:`${q.source}:bar-${interval/60000}m`});
    }
  }
  return [...buckets.values()].sort((a,b)=>a.ts.localeCompare(b.ts)||a.symbol.localeCompare(b.symbol));
}
