import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {readNormalizedCsv} from "./research-csv.js";

async function sha256File(path:string){
  const raw=await readFile(path);
  return createHash("sha256").update(raw).digest("hex");
}

async function main(){
  const path=process.env.HISTORICAL_CSV;
  if(!path) throw new Error("HISTORICAL_CSV is required.");

  const [quotes,checksum]=await Promise.all([
    readNormalizedCsv(path),
    sha256File(path)
  ]);
  if(!quotes.length) throw new Error("Historical CSV contains no quotes.");

  const api=process.env.SUPABASE_FUNCTION_URL;
  const anon=process.env.SUPABASE_ANON_KEY;
  const agent=process.env.LUNA_AGENT_KEY;
  if(!api || !anon || !agent) throw new Error("Supabase ingestion credentials are required.");

  const name=process.env.HISTORICAL_DATASET_NAME ?? `set-${new Date().toISOString().slice(0,10)}-${checksum.slice(0,12)}`;
  const dataset={
    name,
    source:process.env.HISTORICAL_SOURCE ?? "SET",
    granularity:process.env.HISTORICAL_GRANULARITY ?? "tick",
    start_ts:quotes[0].ts,
    end_ts:quotes.at(-1)!.ts,
    symbol_count:new Set(quotes.map(x=>x.symbol)).size,
    row_count:quotes.length,
    checksum_sha256:checksum,
    metadata:{
      file:path,
      normalized_schema:"ts,symbol,bid,ask,last,bid_size,ask_size",
      source_contract:"SET historical tick / normalized import"
    }
  };

  const headers={
    "Content-Type":"application/json",
    "Authorization":`Bearer ${anon}`,
    "x-luna-agent":agent
  };

  const create=await fetch(api,{
    method:"POST",headers,
    body:JSON.stringify({action:"create_dataset",dataset})
  });
  if(!create.ok) throw new Error(`create_dataset HTTP ${create.status}: ${await create.text()}`);
  const created=await create.json() as {dataset_id:string};

  const CHUNK=500;
  for(let i=0;i<quotes.length;i+=CHUNK){
    const rows=quotes.slice(i,i+CHUNK).map((q,index)=>({
      ts:q.ts,symbol:q.symbol,bid:q.bid,ask:q.ask,last:q.last,
      bid_size:q.bidSize,ask_size:q.askSize,source:q.source,source_seq:i+index,raw:q
    }));
    const res=await fetch(api,{
      method:"POST",headers,
      body:JSON.stringify({action:"insert_dataset_ticks",dataset_id:created.dataset_id,rows})
    });
    if(!res.ok) throw new Error(`insert_dataset_ticks HTTP ${res.status}: ${await res.text()}`);
    console.log(JSON.stringify({event:"HISTORICAL_CHUNK_IMPORTED",from:i,to:Math.min(i+CHUNK,quotes.length),total:quotes.length}));
  }

  console.log(JSON.stringify({event:"HISTORICAL_IMPORT_COMPLETE",dataset, dataset_id:created.dataset_id}));
}

main().catch(err=>{
  console.error(JSON.stringify({event:"HISTORICAL_IMPORT_ERROR",error:String(err)}));
  process.exit(1);
});
