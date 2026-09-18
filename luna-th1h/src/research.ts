import {makeFixture} from "./research-fixture.js";
import {runBacktest} from "./backtest.js";
import type {StrategyParams} from "./strategy-v1.js";

const grid:Array<Partial<StrategyParams>>=[
  {minMomentumBps:4,maxSpreadBps:30,minImbalance:0},
  {minMomentumBps:8,maxSpreadBps:25,minImbalance:0.05},
  {minMomentumBps:12,maxSpreadBps:20,minImbalance:0.10},
  {minMomentumBps:16,maxSpreadBps:20,minImbalance:0.10}
];

async function persist(run:any,index:number){
  if(process.env.PERSIST_BACKTEST!=="true") return;

  const api=process.env.SUPABASE_FUNCTION_URL;
  const anon=process.env.SUPABASE_ANON_KEY;
  const agent=process.env.LUNA_AGENT_KEY;
  if(!api || !anon || !agent) throw new Error("Missing Supabase backtest persistence configuration");

  const res=await fetch(api,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${anon}`,
      "x-luna-agent":agent
    },
    body:JSON.stringify({
      action:"record_backtest",
      run:{
        name:`fixture-v1-variant-${index+1}`,
        strategy_version:run.strategyVersion,
        dataset_name:"luna-v1-research-fixture",
        initial_capital:run.initialCapital,
        final_equity:run.finalEquity,
        net_pnl:run.netPnl,
        return_pct:run.returnPct,
        max_drawdown:run.maxDrawdown,
        trade_count:run.tradeCount,
        win_count:run.winCount,
        loss_count:run.lossCount,
        total_fees:run.totalFees,
        total_slippage:run.totalSlippage,
        config:grid[index],
        status:"COMPLETED"
      },
      equity_curve:run.equityCurve,
      trades:run.trades
    })
  });
  if(!res.ok) throw new Error(`Backtest persistence failed: HTTP ${res.status} ${await res.text()}`);
  console.log(JSON.stringify({event:"BACKTEST_PERSISTED",variant:index+1,response:await res.json()}));
}

const quotes=makeFixture();
const results=grid.map(params=>runBacktest(quotes,1_000_000,params));

for(const [i,r] of results.entries()){
  console.log(JSON.stringify({
    variant:i+1,
    strategy:r.strategyVersion,
    params:grid[i],
    finalEquity:Number(r.finalEquity.toFixed(2)),
    netPnl:Number(r.netPnl.toFixed(2)),
    returnPct:Number(r.returnPct.toFixed(4)),
    maxDrawdown:Number(r.maxDrawdown.toFixed(2)),
    trades:r.tradeCount,
    wins:r.winCount,
    losses:r.lossCount,
    fees:Number(r.totalFees.toFixed(2)),
    slippage:Number(r.totalSlippage.toFixed(2))
  }));
  await persist(r,i);
}
