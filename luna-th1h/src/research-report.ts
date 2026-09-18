import type {Quote} from "./types.js";
import {runResearch} from "./research.js";

export interface ResearchReport{
  dataset:string;
  observations:number;
  generatedAt:string;
  splits:{trainPct:number;validationPct:number;testPct:number};
  variants:Array<{
    variant:number;
    params:Record<string,unknown>;
    train:Record<string,unknown>;
    validation:Record<string,unknown>;
    test:Record<string,unknown>;
  }>;
}

export function buildResearchReport(quotes:Quote[]):ResearchReport{
  const runs=runResearch(quotes);
  return {
    dataset:quotes[0]?.source??"unknown",
    observations:quotes.length,
    generatedAt:new Date().toISOString(),
    splits:{trainPct:60,validationPct:20,testPct:20},
    variants:runs.map(r=>({
      variant:r.variant,
      params:r.params as Record<string,unknown>,
      train:summary(r.train),
      validation:summary(r.validation),
      test:summary(r.test)
    }))
  };
}

function summary(r:any){
  return {
    finalEquity:Number(r.finalEquity.toFixed(2)),
    netPnl:Number(r.netPnl.toFixed(2)),
    returnPct:Number(r.returnPct.toFixed(4)),
    maxDrawdown:Number(r.maxDrawdown.toFixed(2)),
    tradeCount:r.tradeCount,
    winCount:r.winCount,
    lossCount:r.lossCount,
    totalFees:Number(r.totalFees.toFixed(2)),
    totalSlippage:Number(r.totalSlippage.toFixed(2))
  };
}
