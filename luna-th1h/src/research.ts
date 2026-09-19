import {runBacktest} from "./backtest.js";
import {StrategyV1,VERSION as STRATEGY_V1_VERSION,type StrategyParams} from "./strategy-v1.js";
import type {Quote} from "./types.js";
import {makeFixture} from "./research-fixture.js";

export type ResearchSplit={name:"TRAIN"|"VALIDATION"|"TEST";quotes:Quote[]};

export interface ResearchRun{
  variant:number;
  params:Partial<StrategyParams>;
  train:any;
  validation:any;
  test:any;
}

const grid:Array<Partial<StrategyParams>>=[
  {minMomentumBps:4,maxSpreadBps:30,minImbalance:0},
  {minMomentumBps:8,maxSpreadBps:25,minImbalance:0.05},
  {minMomentumBps:12,maxSpreadBps:20,minImbalance:0.10},
  {minMomentumBps:16,maxSpreadBps:20,minImbalance:0.10}
];

function splitQuotes(quotes:Quote[]):ResearchSplit[]{
  const n=quotes.length;
  const a=Math.max(1,Math.floor(n*0.6));
  const b=Math.max(a+1,Math.floor(n*0.8));
  return [
    {name:"TRAIN",quotes:quotes.slice(0,a)},
    {name:"VALIDATION",quotes:quotes.slice(a,b)},
    {name:"TEST",quotes:quotes.slice(b)}
  ];
}

function summary(r:any){
  return {
    strategyVersion:r.strategyVersion,
    finalEquity:Number(r.finalEquity.toFixed(2)),
    netPnl:Number(r.netPnl.toFixed(2)),
    returnPct:Number(r.returnPct.toFixed(4)),
    maxDrawdown:Number(r.maxDrawdown.toFixed(2)),
    tradeCount:r.tradeCount,
    winCount:r.winCount,
    lossCount:r.lossCount,
    fees:Number(r.totalFees.toFixed(2)),
    slippage:Number(r.totalSlippage.toFixed(2))
  };
}

async function persist(run:any,index:number,split:"TRAIN"|"VALIDATION"|"TEST"){
  if(process.env.PERSIST_BACKTEST!=="true") return;
  const api=process.env.SUPABASE_FUNCTION_URL, anon=process.env.SUPABASE_ANON_KEY, agent=process.env.LUNA_AGENT_KEY;
  if(!api||!anon||!agent) throw new Error("Missing Supabase backtest persistence configuration");
  const res=await fetch(api,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${anon}`,"x-luna-agent":agent},
    body:JSON.stringify({action:"record_backtest",run:{
      name:`walkforward-v1-variant-${index+1}-${split.toLowerCase()}`,
      strategy_version:run.strategyVersion,dataset_name:"luna-v1-research-fixture",
      initial_capital:run.initialCapital,final_equity:run.finalEquity,net_pnl:run.netPnl,
      return_pct:run.returnPct,max_drawdown:run.maxDrawdown,trade_count:run.tradeCount,
      win_count:run.winCount,loss_count:run.lossCount,total_fees:run.totalFees,total_slippage:run.totalSlippage,
      config:{...grid[index],split},status:"COMPLETED"
    },equity_curve:run.equityCurve,trades:run.trades})});
  if(!res.ok) throw new Error(`Backtest persistence failed: HTTP ${res.status} ${await res.text()}`);
}

export function runResearch(quotes:Quote[],initialCapital=1_000_000){
  const splits=splitQuotes(quotes);
  return grid.map((params,i)=>{
    const train=runBacktest(splits[0].quotes,initialCapital,params);
    const validation=runBacktest(splits[1].quotes,initialCapital,params);
    const test=runBacktest(splits[2].quotes,initialCapital,params);
    return {variant:i+1,params,train,validation,test};
  });
}

const fixtureQuotes:Quote[]=[];
if(process.env.RESEARCH_FIXTURE==="true"){
  // Kept deterministic and explicitly labeled; never mixed with live-market data.
  fixtureQuotes.push(...makeFixture());
  const runs=runResearch(fixtureQuotes);
  for(const x of runs){
    console.log(JSON.stringify({variant:x.variant,params:x.params,train:summary(x.train),validation:summary(x.validation),test:summary(x.test)}));
    await persist(x.train,x.variant-1,"TRAIN");
    await persist(x.validation,x.variant-1,"VALIDATION");
    await persist(x.test,x.variant-1,"TEST");
  }
}else{
  console.log(JSON.stringify({event:"RESEARCH_IDLE",strategy:STRATEGY_V1_VERSION,message:"Provide historical 15m SET quotes to run non-fixture research."}));
}
