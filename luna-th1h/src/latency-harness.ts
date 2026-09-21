#!/usr/bin/env node
/**
 * Deterministic LUNA latency/backpressure harness.
 *
 * It models the worker's bounded global analysis concurrency and measures:
 * quote arrival rate, service latency, queue wait, end-to-end latency,
 * p50/p95/p99, utilization, and saturation.
 *
 * This is a capacity test, not a market-performance backtest.
 */
type Scenario = {
  name:string;
  pollMs:number;
  activeSymbols:number;
  changeFraction:number;
  durationMs:number;
  concurrency:number;
  serviceMeanMs:number;
  serviceP95Ms:number;
};

type Result = Scenario & {
  events:number;
  eventsPerSec:number;
  utilization:number;
  queueWaitMs:{p50:number;p95:number;p99:number;max:number};
  serviceMs:{p50:number;p95:number;p99:number;max:number};
  endToEndMs:{p50:number;p95:number;p99:number;max:number};
  saturated:boolean;
  status:"SUSTAINED"|"BACKPRESSURE";
};

function percentile(values:number[],p:number){
  if(!values.length) return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  const idx=(sorted.length-1)*p;
  const lo=Math.floor(idx),hi=Math.ceil(idx);
  if(lo===hi) return sorted[lo];
  const w=idx-lo;
  return sorted[lo]*(1-w)+sorted[hi]*w;
}

function rng(seed:number){
  let x=seed>>>0;
  return ()=>((x=(1664525*x+1013904223)>>>0)/4294967296);
}

function serviceSample(rand:()=>number,mean:number,p95:number){
  // Deterministic two-regime service model. Roughly 95% short work, 5% long work.
  const short=Math.max(0.05,mean*0.65);
  const tail=Math.max(short,p95);
  return rand()<0.95
    ? short + rand()*Math.max(0.05,mean-short)
    : tail + rand()*Math.max(0.05,tail*0.25);
}

function minIndex(values:number[]){
  let idx=0;
  for(let i=1;i<values.length;i++) if(values[i]<values[idx]) idx=i;
  return idx;
}

function maxValue(values:number[]){
  let max=0;
  for(const value of values) if(value>max) max=value;
  return max;
}

function simulate(s:Scenario,seed:number):Result{
  const rand=rng(seed);
  const interval=s.pollMs;
  const symbolStep=Math.max(1,Math.round(interval));
  const nextAvailable=Array.from({length:s.concurrency},()=>0);
  const queueWait:number[]=[];
  const service:number[]=[];
  const endToEnd:number[]=[];

  let events=0;
  for(let ts=0;ts<s.durationMs;ts+=symbolStep){
    for(let symbol=0;symbol<s.activeSymbols;symbol++){
      // Deterministic approximation of changed-quote filtering.
      if(rand()>s.changeFraction) continue;
      const arrival=ts + rand()*interval;
      const worker=minIndex(nextAvailable);
      const svc=serviceSample(rand,s.serviceMeanMs,s.serviceP95Ms);
      const start=Math.max(arrival,nextAvailable[worker]);
      const wait=start-arrival;
      const finish=start+svc;
      nextAvailable[worker]=finish;
      queueWait.push(wait);
      service.push(svc);
      endToEnd.push(wait+svc);
      events++;
    }
  }

  const durationSeconds=s.durationMs/1000;
  const eventsPerSec=events/durationSeconds;
  const utilization=Math.min(99,eventsPerSec*(s.serviceMeanMs/1000)/s.concurrency);
  const result:Result={
    ...s,
    events,
    eventsPerSec,
    utilization,
    queueWaitMs:{
      p50:percentile(queueWait,0.50),
      p95:percentile(queueWait,0.95),
      p99:percentile(queueWait,0.99),
      max:maxValue(queueWait)
    },
    serviceMs:{
      p50:percentile(service,0.50),
      p95:percentile(service,0.95),
      p99:percentile(service,0.99),
      max:maxValue(service)
    },
    endToEndMs:{
      p50:percentile(endToEnd,0.50),
      p95:percentile(endToEnd,0.95),
      p99:percentile(endToEnd,0.99),
      max:maxValue(endToEnd)
    },
    saturated:false,
    status:"SUSTAINED"
  };
  result.saturated=result.utilization>=0.80 || result.queueWaitMs.p95>100 || result.endToEndMs.p99>250;
  result.status=result.saturated?"BACKPRESSURE":"SUSTAINED";
  return result;
}

const scenarios:Scenario[]=[
  {name:"reference-250ms",pollMs:250,activeSymbols:100,changeFraction:0.75,durationMs:30_000,concurrency:16,serviceMeanMs:3,serviceP95Ms:8},
  {name:"reference-100ms",pollMs:100,activeSymbols:100,changeFraction:0.75,durationMs:30_000,concurrency:16,serviceMeanMs:3,serviceP95Ms:8},
  {name:"stress-50ms",pollMs:50,activeSymbols:200,changeFraction:0.85,durationMs:30_000,concurrency:16,serviceMeanMs:4,serviceP95Ms:10},
  {name:"stress-25ms",pollMs:25,activeSymbols:200,changeFraction:0.90,durationMs:30_000,concurrency:16,serviceMeanMs:5,serviceP95Ms:14},
  {name:"stress-10ms",pollMs:10,activeSymbols:500,changeFraction:0.95,durationMs:30_000,concurrency:16,serviceMeanMs:5,serviceP95Ms:14},
];

const results=scenarios.map((s,i)=>simulate(s,20260921+i));
const reference=results.find(r=>r.name==="reference-100ms");
if(!reference) throw new Error("reference scenario missing");
if(reference.status!=="SUSTAINED") throw new Error("reference-100ms failed sustained-latency gate");

const output={
  engine:"luna-th1h-latency-backpressure-v1",
  generated_at:new Date().toISOString(),
  contract:{
    reference_poll_ms:100,
    reference_active_symbols:100,
    global_concurrency:16,
    sustained_gate:"utilization < 80%, p95 queue wait <= 100ms, p99 end-to-end <= 250ms"
  },
  results,
  interpretation:"Deterministic capacity model. BACKPRESSURE means the configured workload exceeds the modeled processing capacity; it is an expected diagnostic, not a trading-performance claim."
};

console.log(JSON.stringify(output,null,2));
