import {createClient} from "@supabase/supabase-js";
import {randomUUID} from "node:crypto";

const VERSION="luna-research-worker-v1.0.0";
const workerId=process.env.LUNA_RESEARCH_WORKER_ID?.trim() || `research-${randomUUID()}`;
const pollMs=Math.max(500,Number(process.env.LUNA_RESEARCH_POLL_MS??2000));
const leaseSeconds=Math.max(30,Math.min(3600,Number(process.env.LUNA_RESEARCH_LEASE_SECONDS??180)));
const supabaseUrl=process.env.SUPABASE_URL??"";
const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY??"";
if(!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
if(!Number.isFinite(pollMs) || !Number.isFinite(leaseSeconds)) throw new Error("Invalid worker timing configuration");

const db=createClient(supabaseUrl,serviceRoleKey,{
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{headers:{"x-luna-component":"research-worker","x-luna-worker-version":VERSION}}
});

type Job={id:string;job_type:string;payload:Record<string,unknown>;attempts:number;checkpoint:Record<string,unknown>;idempotency_key:string};
let stopping=false;
let currentJobId:string|null=null;
let lastScheduleBucket="";

function bangkokParts(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(date);
  const get=(t:string)=>parts.find(p=>p.type===t)?.value??"";
  return {date:`${get("year")}-${get("month")}-${get("day")}`,hour:Number(get("hour")),minute:Number(get("minute"))};
}
function isoBucket(minutes:number){
  const now=new Date();
  const floored=Math.floor(now.getTime()/(minutes*60_000))*(minutes*60_000);
  return new Date(floored).toISOString();
}
async function enqueue(type:string,key:string,priority:number,payload:Record<string,unknown>={}){
  const {error}=await db.from("luna_research_jobs").upsert({
    job_type:type,status:"QUEUED",priority,scheduled_at:new Date().toISOString(),
    available_at:new Date().toISOString(),idempotency_key:key,payload,max_attempts:5
  },{onConflict:"idempotency_key",ignoreDuplicates:true});
  if(error) throw error;
}
async function scheduleJobs(){
  const b=bangkokParts();
  const bucket=isoBucket(5);
  if(bucket!==lastScheduleBucket){
    lastScheduleBucket=bucket;
    await enqueue("RESEARCH_HEALTH_AUDIT",`health:${bucket}`,100,{bucket});
  }
  const minuteOfDay=b.hour*60+b.minute;
  const windows=[
    {at:7*60+5,key:"morning"},
    {at:12*60+35,key:"midday"},
    {at:16*60+45,key:"close"},
    {at:20*60,key:"night"}
  ];
  for(const w of windows){
    if(minuteOfDay>=w.at && minuteOfDay<w.at+5){
      await enqueue("DATASET_INVENTORY_AUDIT",`dataset:${b.date}:${w.key}`,50,{window:w.key,local_date:b.date});
    }
  }
}
async function heartbeat(status="ONLINE"){
  const {error}=await db.from("luna_research_worker_heartbeats").upsert({
    worker_id:workerId,worker_version:VERSION,status,last_seen_at:new Date().toISOString(),
    current_job_id:currentJobId,metadata:{pid:process.pid,node:process.version,timezone:"Asia/Bangkok"}
  },{onConflict:"worker_id"});
  if(error) throw error;
}
async function exactCount(table:string){
  const {count,error}=await db.from(table).select("*",{count:"exact",head:true});
  if(error) throw error;
  return count??0;
}
async function runJob(job:Job){
  if(job.job_type==="RESEARCH_HEALTH_AUDIT"){
    const [queued,running,retry,dead,succeeded,datasets,runs]=await Promise.all([
      countStatus("QUEUED"),countStatus("RUNNING"),countStatus("RETRY"),
      countStatus("DEAD_LETTER"),countStatus("SUCCEEDED"),
      exactCount("luna_research_datasets"),exactCount("luna_backtest_runs")
    ]);
    return {kind:job.job_type,observed_at:new Date().toISOString(),queue:{queued,running,retry,dead_letter:dead,succeeded},research:{datasets,backtest_runs:runs},worker_version:VERSION,source_of_truth:"Supabase exact row counts"};
  }
  if(job.job_type==="DATASET_INVENTORY_AUDIT"){
    const {data,error}=await db.from("luna_research_datasets")
      .select("id,name,source,checksum_sha256,created_at")
      .order("created_at",{ascending:false}).limit(500);
    if(error) throw error;
    const rows=data??[];
    const invalid=rows.filter(x=>!x.checksum_sha256 || !x.source || !x.status || Number(x.row_count??0)<0);
    const statuses=rows.reduce((acc:Record<string,number>,x)=>{const k=String(x.status??"UNKNOWN");acc[k]=(acc[k]??0)+1;return acc;},{});
    return {kind:job.job_type,observed_at:new Date().toISOString(),scanned_rows:rows.length,invalid_manifest_count:invalid.length,window:job.payload.window??null,local_date:job.payload.local_date??null,warning:rows.length===500?"CAPPED_AT_500_LATEST_DATASETS":null,worker_version:VERSION};
  }
  throw new Error(`NO_HANDLER_REGISTERED:${job.job_type}`);
}
async function countStatus(status:string){
  const {count,error}=await db.from("luna_research_jobs").select("*",{count:"exact",head:true}).eq("status",status);
  if(error) throw error;
  return count??0;
}
async function claim():Promise<Job|null>{
  const {data,error}=await db.rpc("luna_claim_research_job",{p_worker_id:workerId,p_lease_seconds:leaseSeconds});
  if(error) throw error;
  return Array.isArray(data)&&data.length?data[0] as Job:null;
}
async function processOne(){
  const job=await claim();
  if(!job) return false;
  currentJobId=job.id;
  await heartbeat("BUSY");
  try{
    const result=await runJob(job);
    const {data,error}=await db.rpc("luna_complete_research_job",{
      p_job_id:job.id,p_worker_id:workerId,p_result:result
    });
    if(error) throw error;
    if(data!==true) throw new Error("JOB_LEASE_LOST_BEFORE_COMPLETION");
    console.log(JSON.stringify({event:"RESEARCH_JOB_SUCCEEDED",job_id:job.id,job_type:job.job_type,result}));
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    const {data:status,error:rpcError}=await db.rpc("luna_fail_research_job",{
      p_job_id:job.id,p_worker_id:workerId,p_error:{message,at:new Date().toISOString()}
    });
    if(rpcError) throw rpcError;
    console.error(JSON.stringify({event:"RESEARCH_JOB_FAILED",job_id:job.id,job_type:job.job_type,status,error:message}));
  }finally{
    currentJobId=null;
    await heartbeat(stopping?"STOPPING":"ONLINE");
  }
  return true;
}
async function sleep(ms:number){await new Promise(resolve=>setTimeout(resolve,ms));}
async function main(){
  console.log(JSON.stringify({event:"LUNA_RESEARCH_WORKER_BOOT",worker_id:workerId,version:VERSION,poll_ms:pollMs,lease_seconds:leaseSeconds,timezone:"Asia/Bangkok"}));
  await heartbeat();
  while(!stopping){
    try{
      await scheduleJobs();
      const processed=await processOne();
      if(!processed) await sleep(pollMs);
    }catch(error){
      console.error(JSON.stringify({event:"LUNA_RESEARCH_WORKER_LOOP_ERROR",error:String(error)}));
      await sleep(Math.min(30_000,pollMs*5));
    }
  }
  await heartbeat("OFFLINE");
}
process.on("SIGINT",()=>{stopping=true;});
process.on("SIGTERM",()=>{stopping=true;});
void main().catch(async error=>{
  console.error(JSON.stringify({event:"LUNA_RESEARCH_WORKER_FATAL",error:String(error)}));
  try{await heartbeat("FATAL")}catch{}
  process.exit(1);
});
