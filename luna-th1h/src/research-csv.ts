import {readFile} from "node:fs/promises";
import type {Quote} from "./types.js";

function parseNumber(value:string|undefined){
  if(value===undefined || value.trim()==="") return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

function parseLevels(value:string|undefined){
  if(value===undefined || value.trim()==="") return undefined;
  try{
    const parsed=JSON.parse(value);
    if(!Array.isArray(parsed)) return undefined;
    const levels=parsed
      .map((x:any)=>({price:Number(x?.price),size:Number(x?.size)}))
      .filter((x:{price:number;size:number})=>Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.size)&&x.size>0);
    return levels.length?levels:undefined;
  }catch{
    return undefined;
  }
}

function splitCsvLine(line:string){
  const cells:string[]=[];
  let cell="";
  let quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){
      if(quoted && line[i+1]==='"'){cell+='"';i++;continue;}
      quoted=!quoted;continue;
    }
    if(c==="," && !quoted){cells.push(cell);cell="";continue;}
    cell+=c;
  }
  cells.push(cell);
  return cells.map(x=>x.trim());
}

export async function readNormalizedCsv(path:string):Promise<Quote[]>{
  const text=await readFile(path,"utf8");
  const lines=text.split(/\r?\n/).filter(Boolean);
  if(lines.length<2) return [];

  const header=splitCsvLine(lines[0]).map(x=>x.toLowerCase());
  const index=(...names:string[])=>{
    for(const name of names){
      const i=header.indexOf(name);
      if(i>=0) return i;
    }
    return -1;
  };

  const iTs=index("ts","time","timestamp");
  const iSymbol=index("symbol","ticker");
  const iBid=index("bid","best_bid","bid_price");
  const iAsk=index("ask","best_ask","ask_price","offer");
  const iLast=index("last","last_price","price");
  const iBidSize=index("bid_size","best_bid_size","bid_volume");
  const iAskSize=index("ask_size","best_ask_size","offer_volume");
  const iSourceTs=index("source_ts","source_time","event_ts");
  const iSource=index("source");
  const iQuality=index("data_quality","quality");
  const iBidLevels=index("bid_levels_json","bid_levels");
  const iAskLevels=index("ask_levels_json","ask_levels");
  const iDepthComplete=index("depth_complete","l2_complete","book_complete");

  if(iTs<0 || iSymbol<0) throw new Error("CSV requires ts/time and symbol columns.");

  const rows:Quote[]=[];
  for(let n=1;n<lines.length;n++){
    const c=splitCsvLine(lines[n]);
    const rawTs=c[iTs];
    const parsedTs=new Date(rawTs);
    if(!Number.isFinite(parsedTs.getTime())) throw new Error(`INVALID_CSV_TIMESTAMP at line ${n+1}: ${rawTs}`);

    const sourceTsRaw=iSourceTs>=0?c[iSourceTs]:undefined;
    const sourceTs=sourceTsRaw?new Date(sourceTsRaw):undefined;
    if(sourceTsRaw && (!sourceTs || !Number.isFinite(sourceTs.getTime()))){
      throw new Error("INVALID_CSV_SOURCE_TIMESTAMP at line "+(n+1)+": "+sourceTsRaw);
    }
    rows.push({
      ts:parsedTs.toISOString(),
      sourceTs:sourceTs?sourceTs.toISOString():undefined,
      symbol:c[iSymbol],
      bid:parseNumber(c[iBid]),
      ask:parseNumber(c[iAsk]),
      last:parseNumber(c[iLast]),
      bidSize:parseNumber(c[iBidSize]),
      askSize:parseNumber(c[iAskSize]),
      source:iSource>=0 && c[iSource]?c[iSource]:"historical-csv",
      dataQuality:iQuality>=0 && c[iQuality]?c[iQuality]:undefined,
      bidLevels:parseLevels(iBidLevels>=0?c[iBidLevels]:undefined),
      askLevels:parseLevels(iAskLevels>=0?c[iAskLevels]:undefined),
      depthComplete:iDepthComplete>=0 ? ["1","true","yes","y"].includes(String(c[iDepthComplete]).trim().toLowerCase()) : undefined
    });
  }

  rows.sort((a,b)=>a.ts.localeCompare(b.ts)||a.symbol.localeCompare(b.symbol));
  return rows;
}
