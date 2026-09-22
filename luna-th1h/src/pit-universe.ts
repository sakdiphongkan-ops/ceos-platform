import {readFile} from "node:fs/promises";
import type {Quote} from "./types.js";

interface Interval {start:number;end:number|null;}

function split(line:string){
  return line.split(",").map(x=>x.trim().replace(/^"|"$/g,""));
}

function marketDate(ts:string){
  const d=new Date(ts);
  if(!Number.isFinite(d.getTime())) throw new Error("INVALID_PIT_TIMESTAMP");
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit",day:"2-digit"
  }).format(d);
}

function dateMs(value:string){
  const t=Date.parse(value+"T00:00:00Z");
  if(!Number.isFinite(t)) throw new Error("INVALID_PIT_DATE:"+value);
  return t;
}

export async function readPitMembershipCsv(file:string){
  const text=await readFile(file,"utf8");
  const lines=text.split(/\r?\n/).filter(Boolean);
  if(lines.length<2) throw new Error("PIT_UNIVERSE_FILE_EMPTY");
  const header=split(lines[0]).map(x=>x.toLowerCase());
  const iSymbol=header.indexOf("symbol");
  const iStart=header.indexOf("start_date");
  const iEnd=header.indexOf("end_date");
  if(iSymbol<0||iStart<0||iEnd<0) throw new Error("PIT_UNIVERSE_REQUIRES_SYMBOL_START_DATE_END_DATE");

  const map=new Map<string,Interval[]>();
  for(let i=1;i<lines.length;i++){
    const c=split(lines[i]);
    const symbol=(c[iSymbol]??"").toUpperCase();
    if(!symbol) throw new Error("PIT_UNIVERSE_MISSING_SYMBOL_LINE:"+ (i+1));
    const start=dateMs(c[iStart]);
    const end=c[iEnd]?dateMs(c[iEnd]):null;
    if(end!==null && end<start) throw new Error("PIT_UNIVERSE_INVALID_RANGE:"+symbol+":"+(i+1));
    const list=map.get(symbol)??[];
    list.push({start,end});
    map.set(symbol,list);
  }
  for(const list of map.values()) list.sort((a,b)=>a.start-b.start);
  return map;
}

export function applyPitUniverse(quotes:Quote[],membership:Map<string,Interval[]>){
  const out:Quote[]=[];
  let excludedRows=0;
  const activeSymbols=new Set<string>();
  for(const q of quotes){
    const symbol=q.symbol.toUpperCase();
    const intervals=membership.get(symbol)??[];
    const d=dateMs(marketDate(q.sourceTs??q.ts));
    let active=false;
    for(const x of intervals){
      if(d<x.start) break;
      if(d>=x.start && (x.end===null || d<=x.end)){active=true;break;}
    }
    if(active){
      out.push({...q,symbol});
      activeSymbols.add(symbol);
    }else excludedRows++;
  }
  if(!out.length) throw new Error("PIT_UNIVERSE_FILTER_REMOVED_ALL_ROWS");
  return {quotes:out,excludedRows,activeSymbols:activeSymbols.size};
}
