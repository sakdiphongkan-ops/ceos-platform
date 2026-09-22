import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {buildTimeBars} from "./bar-builder.js";
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
  stress?:Record<string,number>;
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

function splitChronological(quotes:Quote[]){
  if(quotes.length<100) throw new Error(`Need at least 100 15m bars/quotes; got ${quotes.length}`);
  const n=quotes.length;
  const a=Math.floor(n*0.60);
  const b=Math.floor(n*0.80);
  if(!(a>0 && b>a && n>b)) throw new Error("Invalid chronological split.");
  return {
    train:quotes.slice(0,a),
    validation:quotes.slice(a,b),
    holdout:quotes.slice(b)
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
  train:any;validation:any;
  trainMonthlyGeo:number;
  validationMonthlyGeo:number;
  validationPositiveMonthRatio:number;
  validationDrawdownPct:number;
  validationTurnover:number;
}){
  const trades=Number(e.validation.tradeCount??0);
  if(trades<5) return -999;
  const stability=Math.min(e.trainMonthlyGeo,e.validationMonthlyGeo);
  const ddPenalty=Math.min(1,e.validationDrawdownPct/0.10);
  const turnoverPenalty=Math.min(1,e.validationTurnover/e.train.initialCapital);
  return 4*e.validationMonthlyGeo+2*stability+0.5*e.validationPositiveMonthRatio-1.5*ddPenalty-0.25*turnoverPenalty;
}

function evaluateCandidate(c:Candidate,split:any):Eval{
  const train=runBacktest(split.train,initialCapital,c);
  const validation=runBacktest(split.validation,initialCapital,c);
  const tm=monthlyStats(train.equityCurve,initialCapital);
  const vm=monthlyStats(validation.equityCurve,initialCapital);
  const validationTurnover=turnover(validation);
  const validationDrawdownPct=Number(validation.maxDrawdown)/initialCapital;
  const validationPositiveMonthRatio=vm.positiveRatio;
  const validationMonthlyGeo=vm.geo;
  const validationScore=score({
    train,validation,
    trainMonthlyGeo:tm.geo,
    validationMonthlyGeo,
    validationPositiveMonthRatio,
    validationDrawdownPct,
    validationTurnover
  });
  return {
    candidate:c,train,validation,
    trainMonthlyGeo:tm.geo,
    validationMonthlyGeo,
    validationPositiveMonthRatio,
    validationDrawdownPct,
    validationTurnover,
    validationScore
  };
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
  const bars=buildTimeBars(ticks,{intervalMinutes});
  const split=splitChronological(bars);

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
        validation_score:x.validationScore
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
    const holdout=runBacktest(split.holdout,initialCapital,e.candidate);
    const hm=monthlyStats(holdout.equityCurve,initialCapital);
    const holdoutTurnover=turnover(holdout);
    const holdoutDrawdownPct=Number(holdout.maxDrawdown)/initialCapital;
    const stress={
      extra_cost_5bps:stressPnl(holdout,5),
      extra_cost_10bps:stressPnl(holdout,10),
      extra_cost_20bps:stressPnl(holdout,20)
    };
    return {
      ...e,
      holdout,
      holdoutMonthlyGeo:hm.geo,
      holdoutPositiveMonthRatio:hm.positiveRatio,
      holdoutDrawdownPct,
      holdoutTurnover,
      holdoutNetPnl:holdout.netPnl,
      holdoutReturnPct:holdout.returnPct,
      stress
    };
  });

  const credible=holdoutEvaluated
    .filter(e=>e.validationMonthlyGeo>=TARGET_MONTHLY_GEO && e.holdoutMonthlyGeo!>=TARGET_MONTHLY_GEO)
    .filter(e=>(e.holdoutPositiveMonthRatio??0)>=0.50)
    .filter(e=>(e.holdoutDrawdownPct??1)<=0.20)
    .filter(e=>(e.stress?.extra_cost_10bps??-Infinity)>0)
    .sort((a,b)=>(b.holdoutMonthlyGeo??-999)-(a.holdoutMonthlyGeo??-999));

  const report={
    generated_at:new Date().toISOString(),
    dataset:{
      input,path: path.resolve(input),sha256:sha,input_rows:ticks.length,bar_rows:bars.length,
      symbols:new Set(bars.map(x=>x.symbol)).size,start_ts:bars[0]?.ts,end_ts:bars.at(-1)?.ts,
      interval_minutes:intervalMinutes
    },
    methodology:{
      search:"deterministic evolutionary parameter tournament",
      generations,populationSize,elites,globalEvaluated,
      split:"chronological 60% TRAIN / 20% VALIDATION / 20% HOLDOUT",
      selection_rule:"TRAIN+VALIDATION only; HOLDOUT untouched until finalists",
      leakage_guard:"HOLDOUT NEVER USED FOR CANDIDATE SELECTION",
      stress_model:"additional bps deducted from realized turnover",
      target_monthly_geometric_return:TARGET_MONTHLY_GEO,
      credible_gate:"validation AND holdout monthly geo must meet target; >=50% positive months; drawdown <=20%; 10bps stress remains profitable"
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
      holdout_max_drawdown:e.holdout.holdout?.maxDrawdown??e.holdout.maxDrawdown,
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
