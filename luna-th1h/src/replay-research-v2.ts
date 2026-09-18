import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {readNormalizedCsv} from "./research-csv.js";
import {runResearchV2,DEFAULT_RESEARCH_V2_CONFIG} from "./research-v2.js";
import {readUniverseCsv} from "./universe.js";

async function filesIn(input:string):Promise<string[]>{
  const st=await fs.stat(input);
  if(st.isFile()) return [input];
  const names=await fs.readdir(input,{withFileTypes:true});
  const nested=await Promise.all(names.map(e=>filesIn(path.join(input,e.name))));
  return nested.flat().filter(f=>/\.csv$/i.test(f) && !/universe/i.test(path.basename(f)));
}
const input=process.env.RESEARCH_INPUT??process.argv[2];
if(!input) throw new Error("RESEARCH_INPUT is required.");
const csvs=await filesIn(input);
if(!csvs.length) throw new Error("No normalized CSV files found.");
const all:any[]=[]; const hashes:string[]=[];
for(const file of csvs){const raw=await fs.readFile(file);hashes.push(createHash("sha256").update(raw).digest("hex"));all.push(...await readNormalizedCsv(file));}
const dedup=new Map<string,any>();
for(const q of all) dedup.set(q.ts+"|"+q.symbol,q);
const universeFile=process.env.UNIVERSE_CSV;
const memberships=universeFile?await readUniverseCsv(universeFile):undefined;
const config={...DEFAULT_RESEARCH_V2_CONFIG,
  maxCandidatesPerTimestamp:Number(process.env.LUNA_MAX_CROSS_SECTIONAL_CANDIDATES??5),
  ranking:{
    momentumWeight:Number(process.env.LUNA_RANK_MOMENTUM_WEIGHT??1),
    imbalanceWeight:Number(process.env.LUNA_RANK_IMBALANCE_WEIGHT??20),
    spreadWeight:Number(process.env.LUNA_RANK_SPREAD_WEIGHT??0.25)
  },
  allowedMarkets:(process.env.LUNA_ALLOWED_MARKETS??"SET,mai").split(",").map(x=>x.trim()),
  sessionTimeZone:process.env.LUNA_TIMEZONE??"Asia/Bangkok",
  universeMemberships:memberships
};
const quotes=[...dedup.values()].sort((a,b)=>a.ts.localeCompare(b.ts)||a.symbol.localeCompare(b.symbol));
const out=runResearchV2(quotes,Number(process.env.LUNA_INITIAL_CAPITAL??1_000_000),config);
const summary=(r:any)=>({finalEquity:+r.finalEquity.toFixed(2),netPnl:+r.netPnl.toFixed(2),returnPct:+r.returnPct.toFixed(4),maxDrawdown:+r.maxDrawdown.toFixed(2),tradeCount:r.tradeCount,winCount:r.winCount,lossCount:r.lossCount,totalFees:+r.totalFees.toFixed(2),totalSlippage:+r.totalSlippage.toFixed(2)});
const selected=out.selectedVariant?out.results.find(r=>r.variant===out.selectedVariant):null;
const datasetHash=createHash("sha256").update(hashes.sort().join("")).digest("hex");
const report={
  event:"RESEARCH_V2_COMPLETE",
  dataset:{files:csvs.length,rows:quotes.length,symbols:new Set(quotes.map(q=>q.symbol)).size,start_ts:quotes[0]?.ts,end_ts:quotes.at(-1)?.ts,checksum_sha256:datasetHash,universe_control:universeFile?"VERIFIED_FROM_FILE":"UNVERIFIED_SURVIVORSHIP_CONTROL"},
  config:{maxCandidatesPerTimestamp:config.maxCandidatesPerTimestamp,ranking:config.ranking,allowedMarkets:config.allowedMarkets,sessionTimeZone:config.sessionTimeZone},
  selectedVariant:out.selectedVariant,splitSizes:out.splitSizes,
  variants:out.results.map(r=>({variant:r.variant,params:r.params,train:summary(r.train),validation:summary(r.validation),test:summary(r.test)})),
  oos:selected?summary(selected.test):null,
  oos_equity_curve:selected?.test.equityCurve??[],
  selection_rule:"highest validation net P&L; TEST untouched until after variant selection"
};
const reportPath=process.env.RESEARCH_V2_REPORT;
if(reportPath){await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2),"utf8");}
console.log(JSON.stringify({event:report.event,dataset:report.dataset,selectedVariant:report.selectedVariant,splitSizes:report.splitSizes,oos:report.oos,oosEquityCurvePoints:report.oos_equity_curve.length,reportPath}));
