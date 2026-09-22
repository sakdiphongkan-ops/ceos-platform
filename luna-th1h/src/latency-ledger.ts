export type LatencyStage="source_to_ingest"|"ingest_to_decision"|"decision_to_submit"|"submit_to_ack"|"ack_to_fill"|"source_to_fill";
export interface LatencyLedger {
  sourceTs:string;
  ingestTs:string;
  decisionTs?:string;
  submitTs?:string;
  ackTs?:string;
  fillTs?:string;
}
export interface LatencyMetrics {stage:LatencyStage;ms:number;}
export function latencyMetrics(x:LatencyLedger):LatencyMetrics[]{
  const pairs:Array<[LatencyStage,string|undefined,string|undefined]>=[
    ["source_to_ingest",x.sourceTs,x.ingestTs],
    ["ingest_to_decision",x.ingestTs,x.decisionTs],
    ["decision_to_submit",x.decisionTs,x.submitTs],
    ["submit_to_ack",x.submitTs,x.ackTs],
    ["ack_to_fill",x.ackTs,x.fillTs],
    ["source_to_fill",x.sourceTs,x.fillTs]
  ];
  return pairs.flatMap(([stage,a,b])=>{
    if(!a||!b) return [];
    const ms=Date.parse(b)-Date.parse(a);
    if(!Number.isFinite(ms)||ms<0) throw new Error(`INVALID_LATENCY_SEQUENCE:${stage}`);
    return [{stage,ms}];
  });
}
export function assertFreshSourceTs(sourceTs:string,nowMs:number,maxAgeMs:number){
  const t=Date.parse(sourceTs);
  if(!Number.isFinite(t)) throw new Error("INVALID_SOURCE_TIMESTAMP");
  const age=nowMs-t;
  if(age<0) throw new Error("SOURCE_TIMESTAMP_IN_FUTURE");
  if(age>maxAgeMs) throw new Error("STALE_SOURCE_TIMESTAMP");
  return age;
}
