import {readFile} from "node:fs/promises";

export interface UniverseMembership{
  symbol:string;
  market:"SET"|"mai";
  startDate:string;
  endDate:string|null;
}

function split(line:string){
  const c:string[]=[]; let x=""; let q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){ q=!q; continue; }
    if(ch===","&&!q){c.push(x.trim());x="";continue;}
    x+=ch;
  }
  c.push(x.trim()); return c;
}

export async function readUniverseCsv(file:string):Promise<UniverseMembership[]>{
  const lines=(await readFile(file,"utf8")).split(/\r?\n/).filter(Boolean);
  if(lines.length<2) return [];
  const h=split(lines[0]).map(x=>x.toLowerCase().replace(/[\s-]+/g,"_"));
  const idx=(...names:string[])=>names.map(n=>h.indexOf(n)).find(i=>i>=0)??-1;
  const iSymbol=idx("symbol","ticker","stock");
  const iMarket=idx("market","exchange");
  const iStart=idx("start_date","start","listing_date");
  const iEnd=idx("end_date","end","delisting_date");
  if(iSymbol<0||iStart<0) throw new Error("Universe CSV requires symbol,start_date; market optional; end_date optional.");
  return lines.slice(1).map((line,n)=>{
    const c=split(line);
    const symbol=c[iSymbol].trim().toUpperCase();
    const market=(c[iMarket]?.trim()||"SET") as "SET"|"mai";
    const start=new Date(c[iStart]); if(!symbol||!Number.isFinite(start.getTime())) throw new Error(`INVALID_UNIVERSE_ROW ${n+2}`);
    const endRaw=c[iEnd]?.trim();
    const end=endRaw?new Date(endRaw):null;
    if(endRaw && (!end||!Number.isFinite(end.getTime()))) throw new Error(`INVALID_UNIVERSE_END_DATE ${n+2}`);
    if(market!=="SET"&&market!=="mai") throw new Error(`INVALID_UNIVERSE_MARKET ${n+2}: ${market}`);
    return {symbol,market,startDate:start.toISOString().slice(0,10),endDate:end?end.toISOString().slice(0,10):null};
  });
}

export function createUniverseFilter(memberships:UniverseMembership[],allowedMarkets=("SET,mai").split(",")){
  const allowed=new Set(allowedMarkets.map(x=>x.trim().toUpperCase()));
  return (symbol:string,ts:string)=>{
    const date=ts.slice(0,10);
    return memberships.some(m=>m.symbol===symbol.toUpperCase()&&allowed.has(m.market.toUpperCase())&&m.startDate<=date&&(!m.endDate||date<=m.endDate));
  };
}
