import {readFile} from "node:fs/promises";
import type {Quote} from "./types.js";

function parseNumber(value:string|undefined){
  if(value===undefined || value.trim()==="") return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
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

  if(iTs<0 || iSymbol<0) throw new Error("CSV requires ts/time and symbol columns.");

  const rows:Quote[]=[];
  for(let n=1;n<lines.length;n++){
    const c=splitCsvLine(lines[n]);
    const rawTs=c[iTs];
    const parsedTs=new Date(rawTs);
    if(!Number.isFinite(parsedTs.getTime())) throw new Error(`INVALID_CSV_TIMESTAMP at line ${n+1}: ${rawTs}`);

    rows.push({
      ts:parsedTs.toISOString(),
      symbol:c[iSymbol],
      bid:parseNumber(c[iBid]),
      ask:parseNumber(c[iAsk]),
      last:parseNumber(c[iLast]),
      bidSize:parseNumber(c[iBidSize]),
      askSize:parseNumber(c[iAskSize]),
      source:"historical-csv"
    });
  }

  rows.sort((a,b)=>a.ts.localeCompare(b.ts)||a.symbol.localeCompare(b.symbol));
  return rows;
}
