function evaluateCandidate(c:Candidate,split:any):Eval{
  const foldResults=split.folds.map((fold:any)=>{
    const train=runBacktest(fold.train,initialCapital,c);
    const validation=runBacktest(
      fold.validation,initialCapital,c,{warmupQuotes:fold.warmupForValidation}
    );
    const tm=monthlyStats(train.equityCurve,initialCapital);
    const vm=monthlyStats(validation.equityCurve,initialCapital);
    return {
      fold:fold.index,
      trainMonthlyGeo:tm.geo,
      validationMonthlyGeo:vm.geo,
      validationPositiveMonthRatio:vm.positiveRatio,
      validationDrawdownPct:Number(validation.maxDrawdown)/initialCapital,
      validationTurnover:turnover(validation),
      validationReturnPct:validation.returnPct,
      validationTrades:validation.tradeCount
    };
  });
  const avgValidationMonthlyGeo=foldResults.reduce((s:any,x:any)=>s+x.validationMonthlyGeo,0)/foldResults.length;
  const minValidationMonthlyGeo=Math.min(...foldResults.map((x:any)=>x.validationMonthlyGeo));
  const avgPositiveRatio=foldResults.reduce((s:any,x:any)=>s+x.validationPositiveMonthRatio,0)/foldResults.length;
  const maxDrawdownPct=Math.max(...foldResults.map((x:any)=>x.validationDrawdownPct));
  const avgTurnover=foldResults.reduce((s:any,x:any)=>s+x.validationTurnover,0)/foldResults.length;
  const representativeFold=foldResults.at(-1);
  const train=runBacktest(
    split.folds.at(-1).train,initialCapital,c
  );
  const validation=runBacktest(
    split.folds.at(-1).validation,initialCapital,c,
    {warmupQuotes:split.folds.at(-1).warmupForValidation}
  );
  const validationScore=score({
    trainMonthlyGeo:representativeFold.trainMonthlyGeo,
    validationMonthlyGeo:representativeFold.validationMonthlyGeo,
    validationPositiveMonthRatio:avgPositiveRatio,
    validationDrawdownPct:maxDrawdownPct,
    validationTurnover:avgTurnover,
    validationTrades:representativeFold.validationTrades,
    walkForwardMinValidationMonthlyGeo:minValidationMonthlyGeo,
    walkForwardAvgValidationMonthlyGeo:avgValidationMonthlyGeo
  });
  return {
    candidate:c,train,validation,
    trainMonthlyGeo:representativeFold.trainMonthlyGeo,
    validationMonthlyGeo:avgValidationMonthlyGeo,
    validationPositiveMonthRatio:avgPositiveRatio,
    validationDrawdownPct:maxDrawdownPct,
    validationTurnover:avgTurnover,
    validationScore,
    walkForwardFoldCount:foldResults.length,
    walkForwardMinValidationMonthlyGeo:minValidationMonthlyGeo,
    walkForwardMaxValidationDrawdownPct:maxDrawdownPct,
    walkForwardAvgValidationMonthlyGeo:avgValidationMonthlyGeo,
    walkForwardAvgValidationPositiveMonthRatio:avgPositiveRatio,
    walkForwardAvgValidationTurnover:avgTurnover,
    foldResults
  };
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {readNormalizedCsv} from "./research-csv.js";
import {runBacktest} from "./backtest.js";
import type {Quote} from "./types.js";
import type {StrategyParams} from "./strategy-v1.js";

type Candidate = StrategyParams & {id:string; generation:number};
type Eval = {
  candidate:Candidate;
  train:any;
  validation:any;
  holdout?:any;
  trainMonthlyGeo:number;
  validationMonthlyGeo:number;
  validationPositiveMonthRatio:number;
  validationDrawdownPct:number;
  validationTurnover:number;
  validationScore:number;
  holdoutMonthlyGeo?:number;
  holdoutPositiveMonthRatio?:number;
  holdoutDrawdownPct?:number;
  holdoutTurnover?:number;
  holdoutNetPnl?:number;
  holdoutReturnPct?:number;
  walkForwardFoldCount:number;
  walkForwardMinValidationMonthlyGeo:number;
  walkForwardMaxValidationDrawdownPct:number;
  walkForwardAvgValidationMonthlyGeo:number;
  walkForwardAvgValidationPositiveMonthRatio:number;
  walkForwardAvgValidationTurnover:number;
  foldResults:Array<Record<string,number>>;
  stress?:Record<string,Record<string,number>>;
};

const input=process.env.BACKTEST_FILE ?? process.argv[2];
if(!input) throw new Error("BACKTEST_FILE is required.");

const initialCapital=Number(process.env.LUNA_INITIAL_CAPITAL ?? 1_000_000);
const intervalMinutes=15;
const populationSize=Math.max(50,Number(process.env.LUNA_RESEARCH_POPULATION ?? 300));
const generations=Math.max(1,Number(process.env.LUNA_RESEARCH_GENERATIONS ?? 5));
const elites=Math.max(5,Math.min(50,Number(process.env.LUNA_RESEARCH_ELITES ?? 20)));
const seed=process.env.LUNA_RESEARCH_SEED ?? "LUNA-15M-ITERATIVE-2026";
const outputPath=process.env.LUNA_RESEARCH_OUTPUT ?? "reports/luna-15m/iterative-tournament.json";
const TARGET_MONTHLY_GEO=Number(process.env.LUNA_RESEARCH_TARGET_MONTHLY_GEO ?? 0.07);
const WALK_FORWARD_FOLDS=Math.max(2,Math.min(6,Number(process.env.LUNA_RESEARCH_WALK_FORWARD_FOLDS ?? 3)));
const MIN_FOLD_MONTHLY_GEO=Number(process.env.LUNA_RESEARCH_MIN_FOLD_MONTHLY_GEO ?? 0);

const choices={
  fastPeriod:[3,5,8,13],
  slowPeriod:[12,20,30,40],
  minMomentumBps:[4,8,12,16,24],
  maxSpreadBps:[10,15,20,25,35],
  minImbalance:[-0.05,0,0.05,0.10,0.15],
  cooldownMs:[5,15,30].map(x=>x*60_000),
  maxHoldMs:[15,30,45,60].map(x=>x*60_000),
  stopLossBps:[50,75,100,125,150],
  takeProfitBps:[100,125,150,200,250,300]
} as const;

function hashFloat(key:string){
  const h=crypto.createHash("sha256").update(seed+"|"+key).digest();
  return h.readUInt32BE(0)/0xffffffff;
}
function pick<T>(a:readonly T[],key:string):T{
  return a[Math.min(a.length-1,Math.floor(hashFloat(key)*a.length))];
}
function candidateId(p:Partial<StrategyParams>,generation:number){
  const canonical=JSON.stringify({...p,generation});
  return crypto.createHash("sha1").update(canonical).digest("hex").slice(0,12);
}
function makeCandidate(key:string,generation:number,base?:Partial<StrategyParams>):Candidate{
  let c:StrategyParams={
    fastPeriod:base?.fastPeriod??pick(choices.fastPeriod,key+"|f"),
    slowPeriod:base?.slowPeriod??pick(choices.slowPeriod,key+"|s"),
    minMomentumBps:base?.minMomentumBps??pick(choices.minMomentumBps,key+"|m"),
    maxSpreadBps:base?.maxSpreadBps??pick(choices.maxSpreadBps,key+"|sp"),
    minImbalance:base?.minImbalance??pick(choices.minImbalance,key+"|im"),
    cooldownMs:base?.cooldownMs??pick(choices.cooldownMs,key+"|cd"),
    maxHoldMs:base?.maxHoldMs??pick(choices.maxHoldMs,key+"|h"),
    stopLossBps:base?.stopLossBps??pick(choices.stopLossBps,key+"|sl"),
    takeProfitBps:base?.takeProfitBps??pick(choices.takeProfitBps,key+"|tp")
  };
  if(c.fastPeriod>=c.slowPeriod){
    c={...c,slowPeriod:choices.slowPeriod.find(x=>x>c.fastPeriod)??40};
  }
  if(c.takeProfitBps<=c.stopLossBps){
    c={...c,takeProfitBps:choices.takeProfitBps.find(x=>x>c.stopLossBps)??300};
  }
  return {...c,id:candidateId(c,generation),generation};
}

function bucket15m(ts:string){
  const ms=Date.parse(ts);
  if(!Number.isFinite(ms)) return null;
  return Math.floor(ms/(15*60_000))*(15*60_000);
}

function splitChronologicalTicks(quotes:Quote[]){
  if(quotes.length<500) throw new Error("Need at least 500 raw ticks; got "+quotes.length);
  const buckets=[...new Set(quotes.map(q=>bucket15m(q.ts)).filter((x):x is number=>x!==null))].sort((a,b)=>a-b);
  if(buckets.length<100) throw new Error("Need at least 100 observed 15m buckets; got "+buckets.length);
  const holdoutStartIndex=Math.floor(buckets.length*0.80);
  const holdoutStart=buckets[holdoutStartIndex];
  if(!holdoutStart) throw new Error("Invalid holdout boundary.");

  const folds:any[]=[];
  for(let i=0;i<WALK_FORWARD_FOLDS;i++){
    const trainEndIndex=Math.floor(buckets.length*(0.50+i*(0.30/(WALK_FORWARD_FOLDS))));
    const validationEndIndex=Math.floor(buckets.length*(0.50+(i+1)*(0.30/(WALK_FORWARD_FOLDS))));
    if(trainEndIndex<=40 || validationEndIndex<=trainEndIndex || validationEndIndex>=holdoutStartIndex) continue;
    const trainEnd=buckets[trainEndIndex-1];
    const validationEnd=buckets[validationEndIndex-1];
    const train=quotes.filter(q=>(bucket15m(q.ts)??Infinity)<=trainEnd);
    const validation=quotes.filter(q=>{
      const x=bucket15m(q.ts);
      return x!==null && x>trainEnd && x<=validationEnd;
    });
    const warmupForValidation=quotes.filter(q=>{
      const x=bucket15m(q.ts);
      return x!==null && x<=trainEnd;
    });
    if(train.length && validation.length){
      folds.push({index:i+1,train,validation,warmupForValidation,bucket_start_index:0,train_end_index:trainEndIndex,validation_end_index:validationEndIndex});
    }
  }
  if(folds.length<2) throw new Error("Need at least 2 valid walk-forward folds.");
  const holdout=quotes.filter(q=>(bucket15m(q.ts)??-Infinity)>=holdoutStart);
  const warmupForHoldout=quotes.filter(q=>{
    const x=bucket15m(q.ts);
    return x!==null && x<holdoutStart;
  });
  return {
    folds,
    holdout,
    warmupForHoldout,
    buckets:buckets.length
  };
}
function monthlyStats(curve:any[],initial:number){
  const months=new Map<string,{first:number;last:number}>();
  for(const p of curve){
    const d=new Date(p.ts);
    const key=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    const x=months.get(key);
    if(!x) months.set(key,{first:p.equity,last:p.equity});
    else x.last=p.equity;
  }
  const returns=[...months.values()].map(x=>x.first>0?x.last/x.first-1:0);
  if(!returns.length) return {geo:0,positiveRatio:0,returns:[] as number[]};
  let logSum=0;
  for(const r of returns) logSum+=Math.log(Math.max(1e-9,1+r));
  return {
    geo:Math.exp(logSum/returns.length)-1,
    positiveRatio:returns.filter(r=>r>0).length/returns.length,
    returns
  };
}

function turnover(r:any){
  return (r.trades??[]).reduce((s:number,t:any)=>s+Number(t.notional??0),0);
}

function stressPnl(r:any,extraBps:number){
  return Number(r.netPnl??0)-turnover(r)*(extraBps/10_000);
}

function score(e:{
  trainMonthlyGeo:number;
  validationMonthlyGeo:number;
  validationPositiveMonthRatio:number;
  validationDrawdownPct:number;
  validationTurnover:number;
  validationTrades:number;
  walkForwardMinValidationMonthlyGeo:number;
  walkForwardAvgValidationMonthlyGeo:number;
}){
  if(e.validationTrades<5 || !Number.isFinite(e.walkForwardAvgValidationMonthlyGeo)) return -999;
  const stability=Math.min(
    e.trainMonthlyGeo,
    e.validationMonthlyGeo,
    e.walkForwardMinValidationMonthlyGeo
  );
  const ddPenalty=Math.min(1,e.validationDrawdownPct/0.10);
  const turnoverPenalty=Math.min(1,e.validationTurnover/1_000_000);
  const foldStability=Math.min(1,Math.max(0,(e.walkForwardMinValidationMonthlyGeo+0.02)/0.10));
  return 3*e.walkForwardAvgValidationMonthlyGeo
    +2*stability
    +0.5*e.validationPositiveMonthRatio
    +0.75*foldStability
    -1.5*ddPenalty
    -0.25*turnoverPenalty;
}

function mutate(parent:Candidate,key:string,generation:number):Candidate{
  const p={...parent};
  const mutatable:(keyof StrategyParams)[]=[
    "fastPeriod","slowPeriod","minMomentumBps","maxSpreadBps","minImbalance",
    "cooldownMs","maxHoldMs","stopLossBps","takeProfitBps"
  ];
  const field=mutatable[Math.floor(hashFloat(key+"|field")*mutatable.length)];
  const direction=hashFloat(key+"|dir")<0.5?-1:1;
  const pools:any=choices;
  const options=pools[field] as any[];
  const currentIndex=Math.max(0,options.indexOf((p as any)[field]));
  const jump=hashFloat(key+"|jump")<0.8?1:2;
  const next=Math.max(0,Math.min(options.length-1,currentIndex+direction*jump));
  (p as any)[field]=options[next];
  if(hashFloat(key+"|second")<0.25){
    const field2=mutatable[Math.floor(hashFloat(key+"|field2")*mutatable.length)];
    const opts2=pools[field2] as any[];
    const idx2=Math.max(0,opts2.indexOf((p as any)[field2]));
    const next2=Math.max(0,Math.min(opts2.length-1,idx2+(hashFloat(key+"|dir2")<0.5?-1:1)));
    (p as any)[field2]=opts2[next2];
  }
  return makeCandidate(key,generation,p);
}

function rank(a:Eval,b:Eval){
  return b.validationScore-a.validationScore;
}

async function main(){
  const raw=fs.readFileSync(input);
  const sha=crypto.createHash("sha256").update(raw).digest("hex");
  const ticks=await readNormalizedCsv(input);
  if(!ticks.length) throw new Error("No normalized quotes loaded.");
  const split=splitChronologicalTicks(ticks);

  let population:Candidate[]=Array.from({length:populationSize},(_,i)=>makeCandidate(`g0|${i}`,0));
  const generationReports:any[]=[];
  let globalEvaluated=0;
  let globalBest:Eval|null=null;

  for(let g=0;g<generations;g++){
    const evaluations=population.map(c=>evaluateCandidate(c,split));
    globalEvaluated+=evaluations.length;
    evaluations.sort(rank);
    if(!globalBest || evaluations[0].validationScore>globalBest.validationScore) globalBest=evaluations[0];

    const top=evaluations.slice(0,Math.min(elites,evaluations.length));
    generationReports.push({
      generation:g,
      evaluated:evaluations.length,
      top:top.slice(0,10).map(x=>({
        id:x.candidate.id,
        params:x.candidate,
        train_monthly_geo:x.trainMonthlyGeo,
        validation_monthly_geo:x.validationMonthlyGeo,
        validation_positive_month_ratio:x.validationPositiveMonthRatio,
        validation_return_pct:x.validation.returnPct,
        validation_max_drawdown:x.validation.maxDrawdown,
        validation_trades:x.validation.tradeCount,
        validation_score:x.validationScore,
        walk_forward_avg_monthly_geo:x.walkForwardAvgValidationMonthlyGeo,
        walk_forward_min_monthly_geo:x.walkForwardMinValidationMonthlyGeo,
        walk_forward_max_drawdown_pct:x.walkForwardMaxValidationDrawdownPct
      }))
    });

    const next:Candidate[]=[];
    for(let i=0;i<top.length;i++) next.push(top[i].candidate);
    let j=0;
    while(next.length<populationSize){
      const parent=top[j%top.length].candidate;
      next.push(mutate(parent,`g${g+1}|child${j}`,g+1));
      j++;
    }
    population=next;
  }

  const finalEvaluations=population.map(c=>evaluateCandidate(c,split)).sort(rank);
  const finalists=finalEvaluations.slice(0,Math.min(25,finalEvaluations.length));

  const holdoutEvaluated=finalists.map(e=>{
    const holdout=runBacktest(
      split.holdout,initialCapital,e.candidate,{warmupQuotes:split.warmupForHoldout}
    );
    const hm=monthlyStats(holdout.equityCurve,initialCapital);
    const holdoutTurnover=turnover(holdout);
    const holdoutDrawdownPct=Number(holdout.maxDrawdown)/initialCapital;
    const stressCosts=[5,10,20].reduce<Record<string,Record<string,number>>>((acc,bps)=>{
      const stressed=runBacktest(
        split.holdout,initialCapital,e.candidate,{
          warmupQuotes:split.warmupForHoldout,
          costModel:{extraSlippageBps:bps}
        }
      );
      acc[`extra_cost_${bps}bps`]={
        netPnl:stressed.netPnl,
        returnPct:stressed.returnPct,
        maxDrawdown:stressed.maxDrawdown,
        tradeCount:stressed.tradeCount,
        totalFees:stressed.totalFees,
        totalSlippage:stressed.totalSlippage,
        turnover:turnover(stressed)
      };
      return acc;
    },{});
    return {
      ...e,
      holdout,
      holdoutMonthlyGeo:hm.geo,
      holdoutPositiveMonthRatio:hm.positiveRatio,
      holdoutDrawdownPct,
      holdoutTurnover,
      holdoutNetPnl:holdout.netPnl,
      holdoutReturnPct:holdout.returnPct,
      stress:stressCosts
    };
  });

  const credible=holdoutEvaluated
    .filter(e=>e.walkForwardAvgValidationMonthlyGeo>=TARGET_MONTHLY_GEO && e.holdoutMonthlyGeo!>=TARGET_MONTHLY_GEO)
    .filter(e=>(e.walkForwardMinValidationMonthlyGeo??-Infinity)>=MIN_FOLD_MONTHLY_GEO)
    .filter(e=>(e.walkForwardAvgValidationPositiveMonthRatio??0)>=0.50)
    .filter(e=>(e.walkForwardMaxValidationDrawdownPct??1)<=0.20)
    .filter(e=>(e.holdoutPositiveMonthRatio??0)>=0.50)
    .filter(e=>(e.holdoutDrawdownPct??1)<=0.20)
    .filter(e=>(e.stress?.extra_cost_10bps?.netPnl??-Infinity)>0)
    .sort((a,b)=>(b.holdoutMonthlyGeo??-999)-(a.holdoutMonthlyGeo??-999));

  const report={
    generated_at:new Date().toISOString(),
    dataset:{
      input,path: path.resolve(input),sha256:sha,input_rows:ticks.length,observed_15m_buckets:split.buckets,
      symbols:new Set(ticks.map(x=>x.symbol)).size,start_ts:ticks[0]?.ts,end_ts:ticks.at(-1)?.ts,
      interval_minutes:intervalMinutes
    },
    methodology:{
      search:"deterministic evolutionary parameter tournament",
      generations,populationSize,elites,globalEvaluated,
      split:"chronological 60% TRAIN / 20% VALIDATION / 20% HOLDOUT",
      selection_rule:"TRAIN+VALIDATION only; HOLDOUT untouched until finalists",
      execution_timing:"raw ticks retained; completed 15m bar closes are warmed up from prior data, entry/exit executes only on subsequent observed ticks",
      leakage_guard:"HOLDOUT NEVER USED FOR CANDIDATE SELECTION",
      stress_model:"full event replay with extra slippage applied to execution price and affordability checks",
      target_monthly_geometric_return:TARGET_MONTHLY_GEO,
      walk_forward_folds:WALK_FORWARD_FOLDS,
      walk_forward_rule:"sequential expanding train windows 50/60/70% with validation ending at 60/70/80%; final 20% frozen holdout",
      credible_gate:"walk-forward average validation geo AND holdout geo meet target; minimum fold geo >= configured floor; >=50% positive months; validation/holdout DD <=20%; 10bps full replay remains profitable"
    },
    generationReports,
    finalists:holdoutEvaluated.map(e=>({
      id:e.candidate.id,params:e.candidate,
      validation_monthly_geo:e.validationMonthlyGeo,
      validation_return_pct:e.validation.returnPct,
      validation_max_drawdown:e.validation.maxDrawdown,
      validation_trades:e.validation.tradeCount,
      holdout_monthly_geo:e.holdoutMonthlyGeo,
      holdout_return_pct:e.holdoutReturnPct,
      walk_forward_avg_validation_monthly_geo:e.walkForwardAvgValidationMonthlyGeo,
      walk_forward_min_validation_monthly_geo:e.walkForwardMinValidationMonthlyGeo,
      walk_forward_max_validation_drawdown_pct:e.walkForwardMaxValidationDrawdownPct,
      fold_results:e.foldResults,
      holdout_max_drawdown:e.holdout.maxDrawdown,
      holdout_trades:e.holdout.tradeCount,
      holdout_positive_month_ratio:e.holdoutPositiveMonthRatio,
      stress:e.stress
    })),
    credibleCandidates:credible.slice(0,10).map(e=>({
      id:e.candidate.id,params:e.candidate,
      validationMonthlyGeo:e.validationMonthlyGeo,
      holdoutMonthlyGeo:e.holdoutMonthlyGeo,
      holdoutReturnPct:e.holdoutReturnPct,
      holdoutMaxDrawdown:e.holdout.maxDrawdown,
      holdoutTrades:e.holdout.tradeCount,
      holdoutPositiveMonthRatio:e.holdoutPositiveMonthRatio,
      stress:e.stress
    }))
  };
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    event:"LUNA_15M_ITERATIVE_RESEARCH_COMPLETE",
    generations,
    populationSize,
    globalEvaluated,
    credibleCandidates:credible.length,
    output:path.resolve(outputPath)
  }));
}
main().catch(err=>{
  console.error(JSON.stringify({event:"LUNA_15M_ITERATIVE_RESEARCH_ERROR",error:String(err)}));
  process.exit(1);
});
