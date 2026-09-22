import {TelemetryQueue,type TelemetryItem} from "./telemetry-queue.js";

function assert(condition:boolean,message:string){
  if(!condition) throw new Error(message);
}

async function main(){
  const flushed:TelemetryItem[][]=[];
  const queue=new TelemetryQueue(async items=>{
    flushed.push(items);
  },{maxBatchSize:10,flushMs:5});

  queue.enqueueTick({
    action:"tick",
    session_id:"session-1",
    quote:{symbol:"AAA",ts:"2026-09-22T10:00:00.000Z",last:100}
  });
  queue.enqueueTick({
    action:"tick",
    session_id:"session-1",
    quote:{symbol:"AAA",ts:"2026-09-22T10:00:00.100Z",last:101}
  });
  queue.enqueueTick({
    action:"tick",
    session_id:"session-1",
    quote:{symbol:"BBB",ts:"2026-09-22T10:00:00.100Z",last:50}
  });
  queue.enqueueSignal({
    action:"signal",
    session_id:"session-1",
    signal:{symbol:"AAA",ts:"2026-09-22T10:00:00.100Z",action:"BUY"}
  });
  queue.enqueueSignal({
    action:"signal",
    session_id:"session-1",
    signal:{symbol:"BBB",ts:"2026-09-22T10:00:00.100Z",action:"SELL"}
  });

  await queue.flushAll();

  assert(flushed.length===1,"expected one telemetry batch");
  assert(flushed[0].length===4,"expected two signals plus two latest ticks");

  const ticks=flushed[0].filter(x=>x.action==="tick");
  const signals=flushed[0].filter(x=>x.action==="signal");
  assert(ticks.length===2,"expected two coalesced ticks");
  assert(signals.length===2,"expected two signals");
  assert(
    ticks.some(x=>x.action==="tick" && x.quote.symbol==="AAA" && x.quote.last===101),
    "latest AAA tick was not retained"
  );
  assert(
    !ticks.some(x=>x.action==="tick" && x.quote.symbol==="AAA" && x.quote.last===100),
    "stale AAA tick was not coalesced"
  );
  assert(queue.stats().coalesced_ticks===1,"coalesced tick metric is incorrect");
  assert(queue.stats().flushed_batches===1,"flushed batch metric is incorrect");
  assert(queue.stats().flushed_items===4,"flushed item metric is incorrect");

  const fairness:TelemetryItem[][]=[];
  const fairnessQueue=new TelemetryQueue(async items=>{
    fairness.push(items);
  },{maxBatchSize:10,flushMs:5,tickBatchShare:0.25});
  for(let i=0;i<30;i++){
    fairnessQueue.enqueueSignal({
      action:"signal",
      session_id:"session-fair",
      signal:{symbol:"S"+i,ts:"2026-09-22T10:00:00."+String(i).padStart(3,"0")+"Z",action:"BUY"}
    });
  }
  fairnessQueue.enqueueTick({
    action:"tick",
    session_id:"session-fair",
    quote:{symbol:"AAA",ts:"2026-09-22T10:00:00.999Z",last:999}
  });
  await fairnessQueue.flushAll();
  assert(
    fairness.some(batch=>batch.some(item=>item.action==="tick" && item.quote.symbol==="AAA")),
    "tick starvation detected"
  );

  let attempts=0;
  const retryQueue=new TelemetryQueue(async items=>{
    attempts++;
    if(attempts===1) throw new Error("synthetic flush failure");
    flushed.push(items);
  },{maxBatchSize:10,flushMs:5});

  retryQueue.enqueueSignal({
    action:"signal",
    session_id:"session-2",
    signal:{symbol:"CCC",ts:"2026-09-22T10:00:00.200Z",action:"BUY"}
  });

  let failed=false;
  try{
    await retryQueue.flushAll();
  }catch{
    failed=true;
  }
  assert(failed,"first synthetic flush should fail");

  await retryQueue.flushAll();
  assert(attempts===2,"queued telemetry was not retained for retry");
  assert(retryQueue.stats().failed_flushes===1,"failed flush metric is incorrect");

  console.log("PASS");
}

main().catch(err=>{
  console.error(err);
  process.exit(1);
});