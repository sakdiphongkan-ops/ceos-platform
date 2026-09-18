import fs from "node:fs";
import path from "node:path";

const dir=process.env.BATCH_REPORT_DIR ?? process.argv[2] ?? "reports/luna-15m";
const files=fs.readdirSync(dir).filter(f=>f.endsWith(".json") && f!=="batch-manifest.json");
type M={train?:any,validation?:any,test?:any};
const variants=new Map<string,{n:number;trainPnl:number;testPnl:number;testTrades:number;testWins:number;testLosses:number;testFees:number;testSlippage:number}>();
let sourceFiles=0;
for(const f of files){
  const j=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
  if(!j.result) continue;
  sourceFiles++;
  for(const v of (j.result.variants??[])){
    const x=variants.get(v.variant)??{n:0,trainPnl:0,testPnl:0,testTrades:0,testWins:0,testLosses:0,testFees:0,testSlippage:0};
    x.n++; x.trainPnl+=Number(v.train?.pnl??0); x.testPnl+=Number(v.test?.pnl??0);
    x.testTrades+=Number(v.test?.trades??0); x.testWins+=Number(v.test?.wins??0); x.testLosses+=Number(v.test?.losses??0);
    x.testFees+=Number(v.test?.fees??0); x.testSlippage+=Number(v.test?.slippage??0); variants.set(v.variant,x);
  }
}
const summary=[...variants.entries()].map(([variant,x])=>({
  variant,runs:x.n,train_pnl_sum:x.trainPnl,test_pnl_sum:x.testPnl,
  test_trades:x.testTrades,test_wins:x.testWins,test_losses:x.testLosses,
  test_win_rate:x.testTrades?x.testWins/x.testTrades:null,
  test_fees:x.testFees,test_slippage:x.testSlippage
}));
const report={generated_at:new Date().toISOString(),source_files:sourceFiles,variants:summary};
fs.writeFileSync(path.join(dir,"aggregate-report.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
