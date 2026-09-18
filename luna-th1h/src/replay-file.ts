import {readNormalizedCsv} from "./research-csv.js";
import {runBacktest} from "./backtest.js";
import {DEFAULT_PARAMS} from "./strategy-v1.js";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";

async function main(){
  const path=process.env.BACKTEST_FILE;
  if(!path) throw new Error("BACKTEST_FILE is required. Expected normalized CSV columns: ts,symbol,bid,ask,last,bid_size,ask_size");

  const [raw,quotes]=await Promise.all([
    readFile(path),
    readNormalizedCsv(path)
  ]);
  if(quotes.length===0) throw new Error("No quotes loaded from BACKTEST_FILE");

  const result=runBacktest(quotes,Number(process.env.LUNA_INITIAL_CAPITAL ?? 1_000_000),DEFAULT_PARAMS);
  const checksum=createHash("sha256").update(raw).digest("hex");

  console.log(JSON.stringify({
    event:"BACKTEST_FILE_COMPLETE",
    dataset:{
      path,
      checksum_sha256:checksum,
      source:"normalized-csv",
      rows:quotes.length,
      symbols:[...new Set(quotes.map(x=>x.symbol))].length,
      start_ts:quotes[0].ts,
      end_ts:quotes.at(-1)!.ts
    },
    result:{
      strategyVersion:result.strategyVersion,
      finalEquity:Number(result.finalEquity.toFixed(2)),
      netPnl:Number(result.netPnl.toFixed(2)),
      returnPct:Number(result.returnPct.toFixed(6)),
      maxDrawdown:Number(result.maxDrawdown.toFixed(2)),
      tradeCount:result.tradeCount,
      winCount:result.winCount,
      lossCount:result.lossCount,
      totalFees:Number(result.totalFees.toFixed(2)),
      totalSlippage:Number(result.totalSlippage.toFixed(2))
    }
  }));
}

main().catch(err=>{
  console.error(JSON.stringify({event:"BACKTEST_FILE_ERROR",error:String(err)}));
  process.exit(1);
});
