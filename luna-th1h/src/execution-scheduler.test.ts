import {LatestExecutionScheduler} from "./execution-scheduler.js";

function deferred<T=void>(){
  let resolve!: (value:T)=>void;
  let reject!: (error:unknown)=>void;
  const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej});
  return {promise,resolve,reject};
}

const scheduler=new LatestExecutionScheduler(2);
const events:string[]=[];

const gate=deferred<void>();
const first=scheduler.enqueue("AAA",async()=>{
  events.push("AAA-1-start");
  await gate.promise;
  events.push("AAA-1-end");
});

const superseded=scheduler.enqueue("AAA",async()=>{
  events.push("AAA-2-ran");
});

const latest=scheduler.enqueue("AAA",async()=>{
  events.push("AAA-3-ran");
});

const other=scheduler.enqueue("BBB",async()=>{
  events.push("BBB-1-ran");
});

const supersededResult=await superseded;
if(!supersededResult.superseded) throw new Error("older pending signal was not superseded");

if(!events.includes("BBB-1-ran")) throw new Error("different symbol should execute concurrently");

gate.resolve();
await Promise.all([first,latest,other]);

if(events.includes("AAA-2-ran")) throw new Error("superseded AAA task executed");
if(events.indexOf("AAA-1-end")>events.indexOf("AAA-3-ran")) throw new Error("same-symbol ordering broken");

const stats=scheduler.stats();
if(stats.activeJobs!==0 || stats.pendingJobs!==0 || stats.queuedSymbols!==0){
  throw new Error("scheduler did not drain cleanly");
}

console.log("latest-execution-scheduler tests: PASS");
