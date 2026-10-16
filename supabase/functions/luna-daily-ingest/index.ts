import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS["default"] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function sha256(value:string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function isAgent(req:Request) {
  const token=req.headers.get("x-luna-agent");
  if(!token)return false;
  const hash=await sha256(token);
  const {data,error}=await supabase.from("private.luna_agent_credentials").select("credential_id").eq("sha256_hash",hash).eq("enabled",true).limit(1);
  return !error && !!data?.length;
}
async function isResearchScheduler(req:Request) {
  const token=req.headers.get("x-luna-scheduler");
  if(!token)return false;
  const {data,error}=await supabase.rpc("luna_validate_research_scheduler_token",{p_token:token});
  return !error && data===true;
}
function out(body:unknown,status=200) {
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","access-control-allow-origin":"https://luna.floot.app"}});
}
async function fetchYahoo(symbol:string,period1:number,period2:number) {
  const url="https://query1.finance.yahoo.com/v8/finance/chart/"
    +encodeURIComponent(symbol.replaceAll("/","-")+".BK")
    +"?period1="+period1+"&period2="+period2
    +"&interval=1d&events=history&includeAdjustedClose=true";
  const res=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}});
  const text=await res.text();
  if(!res.ok) throw new Error("Yahoo HTTP "+res.status+": "+text.slice(0,200));
  return JSON.parse(text);
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return out({ok:true});
  if(req.method!=="POST") return out({ok:false,error:"POST_REQUIRED"},405);
  try {
    const agentAllowed=await isAgent(req);
    const schedulerAllowed=agentAllowed?false:await isResearchScheduler(req);
    if(!agentAllowed&&!schedulerAllowed) return out({ok:false,error:"unauthorized"},401);
    const body=await req.json().catch(()=>({}));
    const researchDatasetId=String(body.research_dataset_id||"");
    // Keep a rolling 35-calendar-day overlap. The scheduler can pass a fixed range for a backfill.
    const period1=Number(body.period1||Math.floor((Date.now()-35*24*60*60*1000)/1000));
    const period2=Number(body.period2||Math.floor((Date.now()+2*24*60*60*1000)/1000));
    const limit=Math.max(1,Math.min(Number(body.limit||40),100));
    if(!researchDatasetId) return out({ok:false,error:"research_dataset_id required"},400);

    const {data:jobs,error:jerr}=await supabase.rpc("luna_claim_research_ingest_symbols",{
      p_dataset_id:researchDatasetId,
      p_limit:limit
    });
    if(jerr) throw new Error("claim: "+jerr.message);

    const results:any[]=[];
    const claimedJobs=jobs ?? [];
    for(let jobIndex=0;jobIndex<claimedJobs.length;jobIndex++) {
      const job=claimedJobs[jobIndex];
      try {
        const raw=await fetchYahoo(job.symbol,period1,period2);
        const chart=raw?.chart?.result?.[0];
        if(!chart?.timestamp?.length) throw new Error("no timestamp");
        const q=chart?.indicators?.quote?.[0]??{};
        const a=chart?.indicators?.adjclose?.[0]?.adjclose??[];
        const rows=chart.timestamp.map((ts:number,i:number)=>({
          dataset_id:researchDatasetId,
          date:new Date(ts*1000).toISOString().slice(0,10),
          symbol:job.symbol,
          market:job.market,
          open:q.open?.[i]??null,
          high:q.high?.[i]??null,
          low:q.low?.[i]??null,
          close:q.close?.[i]??null,
          adj_close:a?.[i]??null,
          volume:q.volume?.[i]??null,
          amount:(q.close?.[i]!=null&&q.volume?.[i]!=null)?q.close[i]*q.volume[i]:null,
          available_at:new Date(ts*1000).toISOString(),
          source_seq:i,
          source:"YAHOO_FINANCE_CHART:1d",
          raw:{}
        }));
        for(let i=0;i<rows.length;i+=500){
          const {error}=await supabase.from("luna_research_prices")
            .upsert(rows.slice(i,i+500),{onConflict:"dataset_id,symbol,date"});
          if(error) throw new Error(error.message);
        }
        await supabase.from("luna_research_ingest_symbols")
          .update({status:"PROCESSED",row_count:rows.length,finished_at:new Date().toISOString(),updated_at:new Date().toISOString(),error:null})
          .eq("dataset_id",researchDatasetId).eq("symbol",job.symbol);
        results.push({symbol:job.symbol,status:"PROCESSED",rows:rows.length});
      } catch(e) {
        const message=e instanceof Error?e.message:String(e);
        if(message.includes("LUNA_STORAGE_GOVERNOR_BLOCKED_RESEARCH_WRITE")) {
          // Storage-quota blocking is an infrastructure pause, not a symbol/data failure.
          // Requeue claimed-but-unwritten symbols and stop the batch to avoid repeated blocked writes.
          const retrySymbols=claimedJobs.slice(jobIndex).map((item:any)=>String(item.symbol));
          const queuedAt=new Date().toISOString();
          const {error:queueError}=await supabase.from("luna_research_ingest_symbols")
            .update({status:"QUEUED",started_at:null,finished_at:null,updated_at:queuedAt,error:"WAITING_FOR_STORAGE_CAPACITY"})
            .eq("dataset_id",researchDatasetId)
            .in("symbol",retrySymbols)
            .eq("status","RUNNING");
          if(queueError) return out({ok:false,status:"STORAGE_CAPACITY_BLOCKED_QUEUE_RESTORE_FAILED",queued_for_retry:0,detail:"storage write blocked and queue could not be restored"},503);
          return out({
            ok:false,status:"STORAGE_CAPACITY_BLOCKED",requested:limit,
            processed:results.filter(x=>x.status==="PROCESSED").length,
            failed:results.filter(x=>x.status==="FAILED").length,
            rows:results.reduce((sum,x)=>sum+x.rows,0),
            queued_for_retry:retrySymbols.length,results
          },507);
        }
        await supabase.from("luna_research_ingest_symbols")
          .update({status:"FAILED",row_count:0,finished_at:new Date().toISOString(),updated_at:new Date().toISOString(),error:message})
          .eq("dataset_id",researchDatasetId).eq("symbol",job.symbol);
        results.push({symbol:job.symbol,status:"FAILED",rows:0,error:message});
      }
    }
    return out({
      ok:true,requested:limit,
      processed:results.filter(x=>x.status==="PROCESSED").length,
      failed:results.filter(x=>x.status==="FAILED").length,
      rows:results.reduce((s,x)=>s+x.rows,0),
      results
    });
  } catch(e) {
    return out({ok:false,error:"INGEST_INTERNAL_ERROR"},500);
  }
});