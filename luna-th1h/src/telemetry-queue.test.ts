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
  console.log("PASS");
}

main().catch(err=>{
  console.error(err);
  process.exit(1);
});
