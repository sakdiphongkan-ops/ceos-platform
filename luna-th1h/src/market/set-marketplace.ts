import type {Quote} from "../types.js";

const BASE_URL=process.env.SET_MARKETPLACE_BASE_URL ?? "https://marketplace.set.or.th/api/public/realtime-data/stock";
const API_KEY=process.env.SET_MARKETPLACE_API_KEY ?? "";
const MARKETS=process.env.SET_MARKETPLACE_MARKETS ?? "SET,mai";
const pollCandidate=Number(process.env.SET_MARKETPLACE_POLL_MS ?? 1000);
const POLL_MS=Number.isFinite(pollCandidate) && pollCandidate>=500 && pollCandidate<=60_000
  ? pollCandidate
  : 1000;
const ageCandidate=Number(process.env.SET_MARKETPLACE_MAX_QUOTE_AGE_MS ?? 8_000);
const MAX_QUOTE_AGE_MS=Number.isFinite(ageCandidate) && ageCandidate>=1_000 && ageCandidate<=60_000
  ? ageCandidate
  : 8_000;

type SetLevel={rank:number;price:number|null;volume:number|null};
type SetStock={
  time?:string;
  symbol?:string;
  market?:string;
  last?:number|null;
  bid?:SetLevel[];
  offer?:SetLevel[];
};

export function numberOrNull(v:unknown):number|null{
  if(v===null || v===undefined) return null;
  if(typeof v==="string" && v.trim()==="") return null;
  if(typeof v!=="number" && typeof v!=="string") return null;
  const n=Number(v);
  return Number.isFinite(n)?n:null;
}

function normalizeTime(value:unknown){
  const s=String(value ?? "");
  const ms=Date.parse(s);
  if(!Number.isFinite(ms)) throw new Error(`SET_BAD_TIMESTAMP: ${s}`);
  return new Date(ms).toISOString();
}

export function normalizeSetStockQuote(value:unknown,nowMs:number=Date.now(),maxQuoteAgeMs:number=MAX_QUOTE_AGE_MS):Quote|null{
  if(!value || typeof value!=="object" || Array.isArray(value)) return null;
  const row=value as SetStock;
  if(typeof row.symbol!=="string" || !row.symbol.trim()
    || typeof row.time!=="string" || !row.time.trim()) return null;
  // External JSON must not be trusted to honor the TypeScript interface.
  // Malformed book containers must reject the row, not throw from .find().
  if((row.bid!==undefined && !Array.isArray(row.bid))
    || (row.offer!==undefined && !Array.isArray(row.offer))) return null;
  const bidRows=(row.bid ?? []).filter((x):x is SetLevel=>!!x && typeof x==="object" && !Array.isArray(x));
  const offerRows=(row.offer ?? []).filter((x):x is SetLevel=>!!x && typeof x==="object" && !Array.isArray(x));
  const bid=bidRows.find(x=>x.rank===1) ?? bidRows[0];
  const offer=offerRows.find(x=>x.rank===1) ?? offerRows[0];
  let sourceTs:string;
  try{
    sourceTs=normalizeTime(row.time);
  }catch{
    return null;
  }
  const sourceTsMs=Date.parse(sourceTs);
  const effectiveMaxAge=Number.isFinite(maxQuoteAgeMs) && maxQuoteAgeMs>=1_000 && maxQuoteAgeMs<=60_000
    ? maxQuoteAgeMs
    : MAX_QUOTE_AGE_MS;
  if(!Number.isFinite(sourceTsMs) || sourceTsMs>nowMs || nowMs-sourceTsMs>effectiveMaxAge){
    return null;
  }
  const bidLevels=bidRows
    .map(x=>({price:numberOrNull(x?.price),size:numberOrNull(x?.volume)}))
    .filter((x):x is {price:number;size:number}=>x.price!==null&&x.price>0&&x.size!==null&&x.size>0);
  const askLevels=offerRows
    .map(x=>({price:numberOrNull(x?.price),size:numberOrNull(x?.volume)}))
    .filter((x):x is {price:number;size:number}=>x.price!==null&&x.price>0&&x.size!==null&&x.size>0);
  const bidPrice=numberOrNull(bid?.price);
  const askPrice=numberOrNull(offer?.price);
  const last=numberOrNull(row.last);
  if((last!==null && last<=0) || (bidPrice!==null && bidPrice<=0) || (askPrice!==null && askPrice<=0)){
    return null;
  }
  if(bidPrice!==null && askPrice!==null && askPrice<bidPrice) return null;
  if(last===null && bidPrice===null && askPrice===null) return null;

  const bidSize=numberOrNull(bid?.volume);
  const askSize=numberOrNull(offer?.volume);
  const verified = bidPrice!==null && askPrice!==null
    && bidPrice>0 && askPrice>0 && askPrice>=bidPrice
    && bidSize!==null && bidSize>0 && askSize!==null && askSize>0;
  return {
    symbol:row.symbol.trim().toUpperCase(),
    ts:new Date(nowMs).toISOString(),
    sourceTs,
    bid:bidPrice,
    ask:askPrice,
    last,
    bidSize,
    askSize,
    bookReceivedTs:verified?new Date(nowMs).toISOString():undefined,
    bookSourceTs:verified?sourceTs:undefined,
    bidLevels,
    askLevels,
    source:"set-marketplace",
    dataQuality:verified?"VERIFIED_BOOK":"UNVERIFIED_BOOK"
  };
}

async function fetchSnapshot():Promise<Quote[]>{
  if(!API_KEY) throw new Error("SET_MARKETPLACE_API_KEY is required for live SET data.");
  const url=new URL(BASE_URL);
  url.searchParams.set("market",MARKETS);
  url.searchParams.set("oddLotFlag","false");

  const res=await fetch(url,{headers:{"api-key":API_KEY,"accept":"application/json"}});
  const text=await res.text();
  if(!res.ok) throw new Error(`SET_API_HTTP_${res.status}: ${text.slice(0,300)}`);

  const payload=JSON.parse(text) as unknown;
  const rows:unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.data)
      ? (payload as any).data
      : Array.isArray((payload as any)?.stock)
        ? (payload as any).stock
        : [];

  return rows.map((row):Quote|null=>normalizeSetStockQuote(row as SetStock)).filter((x):x is Quote=>x!==null);
}

export async function* setMarketplaceQuotes():AsyncGenerator<Quote>{
  while(true){
    const quotes=await fetchSnapshot();
    for(const quote of quotes) yield quote;
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
}
