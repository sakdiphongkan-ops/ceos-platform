import type {Quote} from "../types.js";

const BASE_URL=process.env.SET_MARKETPLACE_BASE_URL ?? "https://marketplace.set.or.th/api/public/realtime-data/stock";
const API_KEY=process.env.SET_MARKETPLACE_API_KEY ?? "";
const MARKETS=process.env.SET_MARKETPLACE_MARKETS ?? "SET,mai";
const POLL_MS=Math.max(500,Number(process.env.SET_MARKETPLACE_POLL_MS ?? 1000));

type SetLevel={rank:number;price:number|null;volume:number|null};
type SetStock={
  time?:string;
  symbol?:string;
  market?:string;
  last?:number|null;
  bid?:SetLevel[];
  offer?:SetLevel[];
};

function numberOrNull(v:unknown){
  const n=Number(v);
  return Number.isFinite(n)?n:null;
}

function normalizeTime(value:unknown){
  const s=String(value ?? "");
  const ms=Date.parse(s);
  if(!Number.isFinite(ms)) throw new Error(`SET_BAD_TIMESTAMP: ${s}`);
  return new Date(ms).toISOString();
}

function toQuote(row:SetStock):Quote|null{
  if(!row.symbol || !row.time) return null;
  const bid=(row.bid ?? []).find(x=>x?.rank===1) ?? row.bid?.[0];
  const offer=(row.offer ?? []).find(x=>x?.rank===1) ?? row.offer?.[0];
  const sourceTs=normalizeTime(row.time);
  const bidLevels=(row.bid ?? [])
    .map(x=>({price:numberOrNull(x?.price),size:numberOrNull(x?.volume)}))
    .filter((x):x is {price:number;size:number}=>x.price!==null&&x.price>0&&x.size!==null&&x.size>0);
  const askLevels=(row.offer ?? [])
    .map(x=>({price:numberOrNull(x?.price),size:numberOrNull(x?.volume)}))
    .filter((x):x is {price:number;size:number}=>x.price!==null&&x.price>0&&x.size!==null&&x.size>0);
  const bidPrice=numberOrNull(bid?.price);
  const askPrice=numberOrNull(offer?.price);
  const last=numberOrNull(row.last);
  const verified = bidPrice!==null && askPrice!==null
    && bidPrice>0 && askPrice>0 && askPrice>=bidPrice
    && Number(bid?.volume??0)>0 && Number(offer?.volume??0)>0;
  return {
    symbol:row.symbol,
    ts:new Date().toISOString(),
    sourceTs,
    bid:bidPrice,
    ask:askPrice,
    last,
    bidSize:numberOrNull(bid?.volume),
    askSize:numberOrNull(offer?.volume),
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

  return rows.map((row):Quote|null=>toQuote(row as SetStock)).filter((x):x is Quote=>x!==null);
}

export async function* setMarketplaceQuotes():AsyncGenerator<Quote>{
  while(true){
    const quotes=await fetchSnapshot();
    for(const quote of quotes) yield quote;
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
}
