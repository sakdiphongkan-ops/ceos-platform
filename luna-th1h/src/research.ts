import {makeFixture} from "./research-fixture.js";
import {runBacktest} from "./backtest.js";
import type {StrategyParams} from "./strategy-v1.js";

const grid:Array<Partial<StrategyParams>>=[
  {minMomentumBps:4,maxSpreadBps:30,minImbalance:0},
  {minMomentumBps:8,maxSpreadBps:25,minImbalance:0.05},
  {minMomentumBps:12,maxSpreadBps:20,minImbalance:0.10},
  {minMomentumBps:16,maxSpreadBps:20,minImbalance:0.10}
];

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
}
