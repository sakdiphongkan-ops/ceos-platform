import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import path from "node:path";

type Row = Record<string,string>;

const input = process.env.SET_RAW_FILE ?? process.argv[2];
const output = process.env.NORMALIZED_CSV ?? process.argv[3] ?? input?.replace(/\.(csv|txt|dat)$/i, "") + ".normalized.csv";
if (!input) {
  console.error("Usage: SET_RAW_FILE=/path/file npm run normalize:set");
  process.exit(1);
}

const aliases: Record<string,string[]> = {
  ts: ["ts","timestamp","datetime","date_time","trade_time","time","trading_time","timestamp_local"],
  symbol: ["symbol","security","security_code","security_symbol","stock","stock_code","series","ticker"],
  bid: ["bid","best_bid","bid_price","buy_price","bid1","bid_1","buy1","buy_1"],
  ask: ["ask","best_ask","ask_price","sell_price","offer","offer_price","ask1","ask_1","sell1","sell_1"],
  last: ["last","last_price","trade_price","price","close","match_price"],
  bid_size: ["bid_size","best_bid_size","bid_qty","bid_quantity","bid_volume","buy_qty","buy_quantity","buy_volume","bid1_size","bid1_qty"],
  ask_size: ["ask_size","best_ask_size","ask_qty","ask_quantity","ask_volume","offer_qty","offer_quantity","offer_volume","ask1_size","ask1_qty"]
};

function normalizeHeader(s: string) {
  return s.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s./-]+/g, "_");
}
function detectDelimiter(line: string) {
  const ds = [",","\t","|",";"];
  const count = (d: string) => {
    let q=false,n=0;
    for (const c of line) { if(c === '"') q=!q; else if(c===d && !q)n++; }
    return n;
  };
  return ds.sort((a,b)=>count(b)-count(a))[0];
}
function parseLine(line: string, delimiter: string): string[] {
  const out:string[]=[]; let cur=""; let q=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c === '"'){
      if(q && line[i+1] === '"'){ cur+='"'; i++; } else q=!q;
    } else if(c === delimiter && !q){ out.push(cur.trim()); cur=""; }
    else cur+=c;
  }
  out.push(cur.trim());
  return out;
}
function parseTs(raw: string): Date | null {
  const s=raw.trim();
  if(!s) return null;
  if(/^\d{4}-\d{2}-\d{2}T/.test(s)){
    const d=new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
  if(m){
    const [,Y,M,D,h,mi,se="0",frac="0"]=m;
    const ms=Number((frac+"000").slice(0,3));
    return new Date(Date.UTC(+Y,+M-1,+D,+h,+mi,+se,ms));
  }
  const dmy=s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
  if(dmy){
    let Y=+dmy[3]; if(Y<100) Y+=2000;
    const ms=Number(((dmy[7]??"0")+"000").slice(0,3));
    return new Date(Date.UTC(Y,+dmy[2]-1,+dmy[1],+dmy[4],+dmy[5],+(dmy[6]??"0"),ms));
  }
  const d=new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function num(raw: string): number | null {
  const s=raw.replace(/,/g,"").trim();
  if(!s || /^[-–—]$/.test(s)) return null;
  const n=Number(s); return Number.isFinite(n) ? n : null;
}
function esc(s:string){ return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }

const raw=fs.readFileSync(input);
const text=path.extname(input).toLowerCase()===".gz" ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
const lines=text.split(/\r?\n/).filter(l=>l.trim());
if(!lines.length) throw new Error("Input is empty");

const delimiter=process.env.SET_DELIMITER
  ? (process.env.SET_DELIMITER === "TAB" ? "\t" : process.env.SET_DELIMITER)
  : detectDelimiter(lines[0]);

let headerIndex=-1;
for(let i=0;i<Math.min(lines.length,200);i++){
  const cols=parseLine(lines[i],delimiter).map(normalizeHeader);
  const hits=["symbol","last","bid","ask"].filter(k=>cols.some(c=>aliases[k].includes(c))).length;
  if(hits>=2){ headerIndex=i; break; }
}
if(headerIndex<0) throw new Error("Could not detect a data header. Run npm run inspect:set and provide SET_*_COLUMN overrides.");

const headers=parseLine(lines[headerIndex],delimiter).map(normalizeHeader);
const idx=(key:string, env:string)=>{
  const override=process.env[env];
  if(override) {
    const i=headers.indexOf(normalizeHeader(override));
    if(i>=0) return i;
  }
  for(const a of aliases[key]){ const i=headers.indexOf(a); if(i>=0)return i; }
  return -1;
};
const map={
  ts:idx("ts","SET_TS_COLUMN"), symbol:idx("symbol","SET_SYMBOL_COLUMN"),
  bid:idx("bid","SET_BID_COLUMN"), ask:idx("ask","SET_ASK_COLUMN"), last:idx("last","SET_LAST_COLUMN"),
  bid_size:idx("bid_size","SET_BID_SIZE_COLUMN"), ask_size:idx("ask_size","SET_ASK_SIZE_COLUMN")
};
for(const k of ["ts","symbol","last"] as const) if(map[k]<0) throw new Error(`Required column missing: ${k}`);

let seq=0, accepted=0, rejected=0, previousTs=0;
const out:string[]=["ts,symbol,bid,ask,last,bid_size,ask_size,source_seq"];
const errors:{line:number,reason:string}[]=[];
for(let i=headerIndex+1;i<lines.length;i++){
  const cells=parseLine(lines[i],delimiter); if(cells.length===1 && !cells[0]) continue;
  const ts=parseTs(cells[map.ts]); const symbol=cells[map.symbol]?.trim().toUpperCase(); const last=num(cells[map.last]);
  const bid=map.bid>=0?num(cells[map.bid]):null; const ask=map.ask>=0?num(cells[map.ask]):null;
  const bidSize=map.bid_size>=0?num(cells[map.bid_size]):null; const askSize=map.ask_size>=0?num(cells[map.ask_size]):null;
  seq++;
  let reason="";
  if(!ts) reason="invalid_timestamp";
  else if(!symbol) reason="missing_symbol";
  else if(last===null || last<=0) reason="invalid_last";
  else if(bid!==null && bid<0) reason="invalid_bid";
  else if(ask!==null && ask<0) reason="invalid_ask";
  else if(bid!==null && ask!==null && bid>ask) reason="bid_gt_ask";
  else if(ts.getTime()<previousTs) reason="timestamp_regression";
  if(reason){ rejected++; if(errors.length<20)errors.push({line:i+1,reason}); continue; }
  previousTs=ts!.getTime(); accepted++;
  out.push([ts!.toISOString(),symbol,bid??"",ask??"",last,bidSize??"",askSize??"",seq].join(","));
}
fs.writeFileSync(output,out.join("\n")+"\n","utf8");
const sha=crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");
console.log(JSON.stringify({input:path.resolve(input),output:path.resolve(output),delimiter:delimiter==="\t"?"TAB":delimiter,header_index:headerIndex,columns:map,accepted,rejected,errors,sha256:sha},null,2));
