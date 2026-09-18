import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {readNormalizedCsv} from "./research-csv.js";
import {buildTimeBars} from "./bar-builder.js";
import {runResearch} from "./research.js";

async function main(){
  const path=process.env.BACKTEST_FILE;
  if(!path) throw new Error("BACKTEST_FILE is required.");
  const raw=await readFile(path);
  const ticks=await readNormalizedCsv(path);
  if(!ticks.length) throw new Error("No quotes loaded from BACKTEST_FILE");
  const bars=buildTimeBars(ticks,{intervalMinutes:15});
  const runs=runResearch(bars,Number(process.env.LUNA_INITIAL_CAPITAL??1_000_000));
  const checksum=createHash("sha256").update(raw).digest("hex");

  console.log(JSON.stringify({
    event:"BACKTEST_15M_COMPLETE",
    dataset:{
      path,checksum_sha256:checksum,source:"normalized-csv",
      input_rows:ticks.length,bar_rows:bars.length,
      symbols:[...new Set(bars.map(x=>x.symbol))].length,
      start_ts:bars[0].ts,end_ts:bars.at(-1)!.ts,bar_interval:"15m"
    },
    variants:runs.map(r=>({
      variant:r.variant,params:r.params,
      train:summary(r.train),validation:summary(r.validation),test:summary(r.test)
    }))
  }));
}
function summary(r:any){
  return {
    finalEquity:Number(r.finalEquity.toFixed(2)),
    netPnl:Number(r.netPnl.toFixed(2)),
    returnPct:Number(r.returnPct.toFixed(6)),
    maxDrawdown:Number(r.maxDrawdown.toFixed(2)),
    tradeCount:r.tradeCount,winCount:r.winCount,lossCount:r.lossCount,
    totalFees:Number(r.totalFees.toFixed(2)),totalSlippage:Number(r.totalSlippage.toFixed(2))
  };
}
main().catch(err=>{console.error(JSON.stringify({event:"BACKTEST_15M_ERROR",error:String(err)}));process.exit(1);});
