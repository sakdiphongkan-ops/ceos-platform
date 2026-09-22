import type {Quote} from "./types.js";

export interface ResearchPreflightResult {
  rows:number;
  symbols:number;
  verifiedBookRatio:number;
  sourceTimestampRatio:number;
  lateSourceEvents:number;
  duplicateEvents:number;
  startTs:string;
  endTs:string;
}

function validPositive(x:number|null|undefined){
  return typeof x==="number" && Number.isFinite(x) && x>0;
}

function verifiedBook(q:Quote){
  return validPositive(q.bid)
    && validPositive(q.ask)
    && validPositive(q.bidSize)
    && validPositive(q.askSize)
    && Number(q.ask)>=Number(q.bid)
    && !String(q.dataQuality??"").toLowerCase().includes("unverified");
}

export function validateResearchQuotes(
  quotes:Quote[],
  options:{requireSourceTs?:boolean;requireVerifiedBook?:boolean;minSymbols?:number}={}
):ResearchPreflightResult{
  const requireSourceTs=options.requireSourceTs!==false;
  const requireVerifiedBook=options.requireVerifiedBook!==false;
  if(!quotes.length) throw new Error("RESEARCH_DATASET_EMPTY");

  const symbols=new Set<string>();
  const lastSourceBySymbol=new Map<string,number>();
  const seen=new Set<string>();
  let verified=0;
  let sourceTimestampRows=0;
  let lateSourceEvents=0;
  let duplicateEvents=0;
  let startTs=Infinity;
  let endTs=-Infinity;

  for(const q of quotes){
    if(!q.symbol) throw new Error("RESEARCH_QUOTE_MISSING_SYMBOL");
    const ingest=Date.parse(q.ts);
    if(!Number.isFinite(ingest)) throw new Error("RESEARCH_QUOTE_INVALID_INGEST_TS");
    startTs=Math.min(startTs,ingest);
    endTs=Math.max(endTs,ingest);
    symbols.add(q.symbol);

    const source=q.sourceTs?Date.parse(q.sourceTs):NaN;
    if(Number.isFinite(source)){
      sourceTimestampRows++;
      if(source>ingest) throw new Error("SOURCE_TS_AFTER_INGEST:"+q.symbol+":"+q.sourceTs+">"+q.ts);
      const prev=lastSourceBySymbol.get(q.symbol);
      if(prev!==undefined && source<prev) lateSourceEvents++;
      lastSourceBySymbol.set(q.symbol,Math.max(prev??-Infinity,source));
    }else if(requireSourceTs){
      throw new Error("MISSING_SOURCE_TS:"+q.symbol+":"+q.ts);
    }

    if(verifiedBook(q)) verified++;
    else if(requireVerifiedBook) throw new Error("UNVERIFIED_BOOK_ROW:"+q.symbol+":"+q.ts);

    const key=[
      q.symbol,q.sourceTs??q.ts,
      q.bid,q.ask,q.last,q.bidSize,q.askSize
    ].join("|");
    if(seen.has(key)) duplicateEvents++;
    seen.add(key);
  }

  if(lateSourceEvents>0) throw new Error("OUT_OF_ORDER_SOURCE_TS:"+lateSourceEvents);
  if(duplicateEvents>0) throw new Error("DUPLICATE_MARKET_EVENTS:"+duplicateEvents);
  if(requireSourceTs && sourceTimestampRows!==quotes.length){
    throw new Error("SOURCE_TS_COVERAGE:"+sourceTimestampRows+"/"+quotes.length);
  }
  if(requireVerifiedBook && verified!==quotes.length){
    throw new Error("VERIFIED_BOOK_COVERAGE:"+verified+"/"+quotes.length);
  }
  const minSymbols=Math.max(1,Number(options.minSymbols??1));
  if(symbols.size<minSymbols) throw new Error("RESEARCH_SYMBOL_COUNT:"+symbols.size+"<"+minSymbols);

  return {
    rows:quotes.length,
    symbols:symbols.size,
    verifiedBookRatio:verified/quotes.length,
    sourceTimestampRatio:sourceTimestampRows/quotes.length,
    lateSourceEvents,
    duplicateEvents,
    startTs:new Date(startTs).toISOString(),
    endTs:new Date(endTs).toISOString()
  };
}
