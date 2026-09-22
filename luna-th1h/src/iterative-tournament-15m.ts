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
import {validateResearchQuotes} from "./research-preflight.js";
import {applyPitUniverse,readPitMembershipCsv} from "./pit-universe.js";
import {assertPitMembershipProvenance,assertFrozenHoldoutAllowed,writeHoldoutExposureLedger,digestQuotes} from "./research-governance.js";
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
  const buckets=[...new Set(quotes.map(q=>bucket15m(q.sourceTs??q.ts)).filter((x):x is number=>x!==null))].sort((a,b)=>a-b);
  if(buckets.length<100) throw new Error("Need at least 100 observed 15m buckets; got "+buckets.length);
  const selectionEndIndex=Math.floor(buckets.length*0.60);
  const auditEndIndex=Math.floor(buckets.length*0.80);
  const holdoutStartIndex=auditEndIndex;
  const selectionEnd=buckets[selectionEndIndex-1];
  const auditEnd=buckets[auditEndIndex-1];
  const holdoutStart=buckets[holdoutStartIndex];
  if(!selectionEnd || !auditEnd || !holdoutStart) throw new Error("Invalid nested research boundaries.");
  const folds:any[]=[];
  for(let i=0;i<WALK_FORWARD_FOLDS;i++){
    const trainEndIndex=Math.floor(buckets.length*(0.30+i*(0.30/WALK_FORWARD_FOLDS)));
    const validationEndIndex=Math.floor(buckets.length*(0.30+(i+1)*(0.30/WALK_FORWARD_FOLDS)));
    if(trainEndIndex<=40 || validationEndIndex<=trainEndIndex || validationEndIndex>selectionEndIndex) continue;
    const trainEnd=buckets[trainEndIndex-1];
    const validationEnd=buckets[validationEndIndex-1];
    const train=quotes.filter(q=>(bucket15m(q.sourceTs??q.ts)??Infinity)<=trainEnd);
    const validation=quotes.filter(q=>{const x=bucket15m(q.sourceTs??q.ts);return x!==null&&x>trainEnd&&x<=validationEnd;});
    const warmupForValidation=quotes.filter(q=>{const x=bucket15m(q.sourceTs??q.ts);return x!==null&&x<=trainEnd;});
    if(train.length&&validation.length) folds.push({index:i+1,train,validation,warmupForValidation,train_end_index:trainEndIndex,validation_end_index:validationEndIndex});
  }
  if(folds.length<2) throw new Error("Need at least 2 valid inner walk-forward folds.");
  const audit=quotes.filter(q=>{const x=bucket15m(q.sourceTs??q.ts);return x!==null&&x>selectionEnd&&x<=auditEnd;});
  const warmupForAudit=quotes.filter(q=>{const x=bucket15m(q.sourceTs??q.ts);return x!==null&&x<=selectionEnd;});
  const holdout=quotes.filter(q=>(bucket15m(q.sourceTs??q.ts)??-Infinity)>=holdoutStart);
  const warmupForHoldout=quotes.filter(q=>{const x=bucket15m(q.sourceTs??q.ts);return x!==null&&x<holdoutStart;});
  return {folds,selectionEndIndex,auditEndIndex,holdoutStartIndex,selectionEnd,auditEnd,holdoutStart,audit,warmupForAudit,holdout,warmupForHoldout,buckets:buckets.length};
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
  const returnComponent=3*Math.tanh(10*e.walkForwardAvgValidationMonthlyGeo);
  const stabilityComponent=2*Math.tanh(10*stability);
  const consistencyComponent=0.5*e.validationPositiveMonthRatio;
  return returnComponent
    +stabilityComponent
    +consistencyComponent
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
  let ticks=await readNormalizedCsv(input);
  if(!ticks.length) throw new Error("No normalized quotes loaded.");

  const pitUniverseFile=process.env.LUNA_PIT_UNIVERSE_FILE;
  const requirePit=String(process.env.LUNA_RESEARCH_REQUIRE_PIT??"true").toLowerCase()!=="false";
  let pitExcludedRows=0;
  let pitActiveSymbols=new Set<string>();
  if(pitUniverseFile){
    const manifestFile=process.env.LUNA_PIT_MEMBERSHIP_MANIFEST_FILE;
    const requirePitProvenance=String(process.env.LUNA_RESEARCH_REQUIRE_PIT_PROVENANCE??"true").toLowerCase()!=="false";
    if(requirePitProvenance && !manifestFile){
      throw new Error("PIT_MEMBERSHIP_PROVENANCE_REQUIRED_SET_LUNA_PIT_MEMBERSHIP_MANIFEST_FILE");
    }
    if(manifestFile) assertPitMembershipProvenance(pitUniverseFile,manifestFile);
    const membership=await readPitMembershipCsv(pitUniverseFile);
    const filtered=applyPitUniverse(ticks,membership);
    ticks=filtered.quotes;
    pitExcludedRows=filtered.excludedRows;
    pitActiveSymbols=new Set(ticks.map(q=>q.symbol));
  }else if(requirePit){
    throw new Error("PIT_UNIVERSE_REQUIRED_SET_LUNA_PIT_UNIVERSE_FILE");
  }

  const preflight=validateResearchQuotes(ticks,{
    requireSourceTs:true,
    requireVerifiedBook:true,
    minSymbols:Number(process.env.LUNA_RESEARCH_MIN_SYMBOLS??1)
  });
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

  // Development + audit decide the finalists. Final holdout is locked away from normal iteration.
  const auditEvaluated=finalists.map(e=>{
    const audit=runBacktest(
      split.audit,initialCapital,e.candidate,{warmupQuotes:split.warmupForAudit}
    );
    const am=monthlyStats(audit.equityCurve,initialCapital);
    return {...e,audit,
      auditMonthlyGeo:am.geo,
      auditPositiveMonthRatio:am.positiveRatio,
      auditDrawdownPct:Number(audit.maxDrawdown)/initialCapital,
      auditTurnover:turnover(audit)};
  });

  const credible=auditEvaluated
    .filter(e=>e.walkForwardAvgValidationMonthlyGeo>=TARGET_MONTHLY_GEO)
    .filter(e=>(e.walkForwardMinValidationMonthlyGeo??-Infinity)>=MIN_FOLD_MONTHLY_GEO)
    .filter(e=>(e.walkForwardAvgValidationPositiveMonthRatio??0)>=0.50)
    .filter(e=>(e.walkForwardMaxValidationDrawdownPct??1)<=0.20)
    .filter(e=>(e.auditMonthlyGeo??-Infinity)>=TARGET_MONTHLY_GEO)
    .filter(e=>(e.auditPositiveMonthRatio??0)>=0.50)
    .filter(e=>(e.auditDrawdownPct??1)<=0.20)
    .sort((x,y)=>{
      const xScore=(x.auditMonthlyGeo??-999)*100+(x.walkForwardAvgValidationMonthlyGeo??-999)*10+(x.auditPositiveMonthRatio??0);
      const yScore=(y.auditMonthlyGeo??-999)*100+(y.walkForwardAvgValidationMonthlyGeo??-999)*10+(y.auditPositiveMonthRatio??0);
      return yScore-xScore;
    });

  let holdoutConfirmation:any[]=[];
  let holdoutEvaluation:any={status:"NOT_RUN_FROZEN_REQUIRED"};
  const runFrozenHoldout=String(process.env.LUNA_RUN_FROZEN_HOLDOUT??"false").toLowerCase()==="true";
  if(runFrozenHoldout){
    const lockFile=process.env.LUNA_HOLDOUT_LOCK_FILE;
    const exposureLedger=process.env.LUNA_HOLDOUT_EXPOSURE_LEDGER_FILE;
    if(!lockFile||!exposureLedger) throw new Error("FROZEN_HOLDOUT_REQUIRES_LOCK_AND_EXPOSURE_LEDGER");
    const holdoutDigest=digestQuotes(split.holdout);
    assertFrozenHoldoutAllowed({
      lockFile,exposureLedger,datasetSha256:sha,
      holdoutStart:split.holdoutStart,holdoutDigest
    });

    const holdoutEvaluated=credible.map(e=>{
      const holdout=runBacktest(split.holdout,initialCapital,e.candidate,{warmupQuotes:split.warmupForHoldout});
      const hm=monthlyStats(holdout.equityCurve,initialCapital);
      const holdoutDrawdownPct=Number(holdout.maxDrawdown)/initialCapital;
      const stress=[5,10,20].reduce<Record<string,Record<string,number>>>((acc,bps)=>{
        const stressed=runBacktest(split.holdout,initialCapital,e.candidate,{
          warmupQuotes:split.warmupForHoldout,
          costModel:{extraSlippageBps:bps}
        });
        acc[`extra_cost_${bps}bps`]={
          netPnl:stressed.netPnl,returnPct:stressed.returnPct,maxDrawdown:stressed.maxDrawdown,
          tradeCount:stressed.tradeCount,totalFees:stressed.totalFees,
          totalSlippage:stressed.totalSlippage,turnover:turnover(stressed)
        };
        return acc;
      },{});
      return {...e,holdout,holdoutMonthlyGeo:hm.geo,
        holdoutPositiveMonthRatio:hm.positiveRatio,holdoutDrawdownPct,
        holdoutNetPnl:holdout.netPnl,holdoutReturnPct:holdout.returnPct,stress};
    });
    holdoutConfirmation=holdoutEvaluated.map(e=>({
      candidate:e.candidate,
      holdoutMonthlyGeo:e.holdoutMonthlyGeo,
      holdoutPositiveMonthRatio:e.holdoutPositiveMonthRatio,
      holdoutDrawdownPct:e.holdoutDrawdownPct,
      holdout10bpsNetPnl:e.stress?.extra_cost_10bps?.netPnl??null,
      holdoutPass:
        (e.holdoutMonthlyGeo??-Infinity)>=TARGET_MONTHLY_GEO &&
        (e.holdoutPositiveMonthRatio??0)>=0.50 &&
        (e.holdoutDrawdownPct??1)<=0.20 &&
        (e.stress?.extra_cost_10bps?.netPnl??-Infinity)>0
    }));
    writeHoldoutExposureLedger(exposureLedger,{
      protocolVersion:"LUNA-15M-HOLDOUT-V1",datasetSha256:sha,
      holdoutStart:split.holdoutStart,holdoutDigest,exposedAt:new Date().toISOString(),
      candidateCount:holdoutEvaluated.length,selectionBasis:"development+audit_only"
    });
    holdoutEvaluation={
      status:"EXPOSED_ONCE",holdoutDigest,exposureLedger,candidateCount:holdoutEvaluated.length
    };
  }
  const report={
    generated_at:new Date().toISOString(),
    dataset:{
      input,path: path.resolve(input),sha256:sha,input_rows:ticks.length,observed_15m_buckets:split.buckets,
      symbols:new Set(ticks.map(x=>x.symbol)).size,start_ts:ticks[0]?.ts,end_ts:ticks.at(-1)?.ts,
      interval_minutes:intervalMinutes,
      pit_universe_required:requirePit,
      pit_universe_file:pitUniverseFile??null,
      pit_excluded_rows:pitExcludedRows,
      pit_active_symbols:pitActiveSymbols.size,
      pit_membership_manifest:process.env.LUNA_PIT_MEMBERSHIP_MANIFEST_FILE??null,
      pit_provenance_required:String(process.env.LUNA_RESEARCH_REQUIRE_PIT_PROVENANCE??"true").toLowerCase()!=="false",
      preflight
    },
    methodology:{
      search:"deterministic evolutionary parameter tournament",
      generations,populationSize,elites,globalEvaluated,
      split:"nested chronological 60% DEVELOPMENT / 20% AUDIT / 20% FINAL HOLDOUT",
      selection_rule:"inner walk-forward folds inside first 60% select candidates; 20% AUDIT is unseen during evolution; FINAL HOLDOUT is frozen and evaluated only after audit",
      execution_timing:"raw ticks retained; completed 15m bar closes are warmed up from prior data, entry/exit executes only on subsequent observed ticks",
      leakage_guard:"HOLDOUT NEVER USED FOR CANDIDATE SELECTION",
      holdout_selection_forbidden:true,
      holdout_exposure_rule:"FINAL HOLDOUT MAY BE OPENED ONLY ONCE WITH AN IMMUTABLE LOCK AND EXPOSURE LEDGER",
      pit_provenance_rule:"PIT membership must carry a SHA-256-pinned provenance manifest from an allowed authoritative domain",
      stress_model:"full event replay with extra slippage applied to execution price and affordability checks",
      acceptance_hurdle_monthly_geometric_return:TARGET_MONTHLY_GEO,
      walk_forward_folds:WALK_FORWARD_FOLDS,
      walk_forward_rule:"inner expanding train windows inside first 60%; 20% audit and final 20% holdout remain unseen during candidate evolution",
      credible_gate:"candidate selection uses development+audit only; frozen final holdout is confirmation-only and never used for ranking/selection; 7% monthly is an acceptance hurdle; >=50% positive months; audit DD <=20%; holdout is inaccessible during normal iteration and can be opened only once with an immutable lock + exposure ledger"
    },
    generationReports,
    finalists:auditEvaluated.map(e=>({
      id:e.candidate.id,params:e.candidate,
      validation_monthly_geo:e.validationMonthlyGeo,
      validation_return_pct:e.validation.returnPct,
      validation_max_drawdown:e.validation.maxDrawdown,
      validation_trades:e.validation.tradeCount,
      audit_monthly_geo:e.auditMonthlyGeo,
      audit_positive_month_ratio:e.auditPositiveMonthRatio,
      audit_drawdown_pct:e.auditDrawdownPct,
      walk_forward_avg_validation_monthly_geo:e.walkForwardAvgValidationMonthlyGeo,
      walk_forward_min_validation_monthly_geo:e.walkForwardMinValidationMonthlyGeo,
      walk_forward_max_validation_drawdown_pct:e.walkForwardMaxValidationDrawdownPct,
      fold_results:e.foldResults
    })),
    credibleCandidates:credible.slice(0,10).map(e=>({
      id:e.candidate.id,params:e.candidate,
      validationMonthlyGeo:e.validationMonthlyGeo,
      auditMonthlyGeo:e.auditMonthlyGeo,
      auditPositiveMonthRatio:e.auditPositiveMonthRatio,
      auditDrawdownPct:e.auditDrawdownPct
    })),
    holdoutEvaluation,
    holdoutConfirmation
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
