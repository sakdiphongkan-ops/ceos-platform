import {config} from "./config.js";
import {mockQuotes} from "./market/mock.js";
import {evaluate, VERSION as STRATEGY_VERSION} from "./strategy.js";
import type {Quote, Signal} from "./types.js";

let sessionId:string|null=null;
let auditChain="GENESIS";
let heartbeatTimer:NodeJS.Timeout|undefined;

function todayInTimezone(timezone:string){
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:timezone,
    year:"numeric",
    month:"2-digit",
    day:"2-digit"
  }).format(new Date());
}

async function sha256(value:string){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function ingest(path:string,body:Record<string,unknown>,agentRequired=true){
  if(!config.supabaseFunctionUrl || !config.supabaseAnonKey){
    throw new Error("Supabase ingest endpoint is not configured");
  }

  const headers:Record<string,string>={
    "Content-Type":"application/json",
    "Authorization":`Bearer ${config.supabaseAnonKey}`
  };
  if(agentRequired) headers["x-luna-agent"]=config.lunaAgentKey;

  let lastError:unknown;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const res=await fetch(`${config.supabaseFunctionUrl}/${path}`,{
        method:"POST",
        headers,
        body:JSON.stringify(body)
      });
      const text=await res.text();
      let payload:unknown=text;
      try{payload=JSON.parse(text)}catch{}
      if(!res.ok) throw new Error(`HTTP ${res.status}: ${typeof payload==="string"?payload:JSON.stringify(payload)}`);
      return payload;
    }catch(err){
      lastError=err;
      await new Promise(r=>setTimeout(r,250*attempt));
    }
  }
  throw lastError instanceof Error?lastError:new Error(String(lastError));
}

async function audit(eventType:string,payload:Record<string,unknown>,strategyVersion=STRATEGY_VERSION){
  const ts=new Date().toISOString();
  const canonical=JSON.stringify({prev:auditChain,ts,eventType,payload,strategyVersion});
  auditChain=await sha256(canonical);
  await ingest("",{
    action:"audit",
    session_id:sessionId,
    ts,
    event_type:eventType,
    payload,
    strategy_version:strategyVersion,
    hash:auditChain
  });
}

async function startSession(){
  const response=await ingest("",{
    action:"start_session",
    session:{
      session_date:todayInTimezone(config.timezone),
      mode:config.mode,
      strategy_version:STRATEGY_VERSION,
      strategy_description:"LUNA-TH1H bootstrap paper-trading worker; no live entries.",
      initial_capital:config.initialCapital
    }
  });
  const data=response as {session?:{id?:string}};
  if(!data.session?.id) throw new Error("Supabase did not return a session id");
  sessionId=data.session.id;
  await audit("SESSION_STARTED",{provider:config.marketDataProvider,capital:config.initialCapital});
  console.log(JSON.stringify({event:"LUNA_SESSION_STARTED",sessionId,strategyVersion:STRATEGY_VERSION}));
}

async function handleQuote(q:Quote){
  const signal:Signal=evaluate(q);

  await ingest("",{action:"tick",session_id:sessionId,quote:q});
  await ingest("",{action:"signal",session_id:sessionId,signal});

  console.log(JSON.stringify({event:"SIGNAL",quote:q,signal}));

  if(!heartbeatTimer){
    heartbeatTimer=setInterval(()=>{
      audit("HEARTBEAT",{
        provider:config.marketDataProvider,
        last_quote_ts:q.ts
      }).catch(err=>console.error(JSON.stringify({event:"AUDIT_ERROR",error:String(err)})));
    },60_000);
  }
}

async function endSession(status="CLOSED"){
  if(heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer=undefined;
  if(!sessionId) return;
  try{
    await audit("SESSION_ENDED",{status});
    await ingest("",{action:"end_session",session_id:sessionId,status});
  }catch(err){
    console.error(JSON.stringify({event:"SESSION_END_ERROR",error:String(err)}));
  }finally{
    sessionId=null;
  }
}

async function main(){
  console.log(JSON.stringify({
    event:"LUNA_BOOT",
    mode:config.mode,
    provider:config.marketDataProvider,
    capital:config.initialCapital
  }));

  if(config.mode!=="paper") throw new Error("Only paper mode is enabled in this build.");
  if(config.marketDataProvider!=="mock"){
    throw new Error("Market-data adapter not installed. Keep MARKET_DATA_PROVIDER=mock until an authorized provider is configured.");
  }
  if(!config.supabaseFunctionUrl || !config.supabaseAnonKey || !config.lunaAgentKey){
    throw new Error("Supabase ingest security configuration is incomplete.");
  }

  await startSession();

  for await(const q of mockQuotes()){
    if(!sessionId) throw new Error("Session is not active");
    await handleQuote(q);
  }
}

process.on("SIGINT",async()=>{await endSession("CLOSED");process.exit(0)});
process.on("SIGTERM",async()=>{await endSession("CLOSED");process.exit(0)});

main().catch(async err=>{
  console.error(JSON.stringify({event:"LUNA_FATAL",error:String(err)}));
  await endSession("ERROR");
  process.exit(1);
});
