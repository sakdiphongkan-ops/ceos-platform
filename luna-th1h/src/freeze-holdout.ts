import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {readNormalizedCsv} from "./research-csv.js";
import {validateResearchQuotes} from "./research-preflight.js";
import {applyPitUniverse,readPitMembershipCsv} from "./pit-universe.js";
import {assertPitMembershipProvenance,digestQuotes} from "./research-governance.js";

function bucket15m(ts:string){
  const ms=Date.parse(ts);
  if(!Number.isFinite(ms)) return null;
  return Math.floor(ms/(15*60_000))*(15*60_000);
}
function fileSha(file:string){
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main(){
  const input=process.env.BACKTEST_FILE ?? process.argv[2];
  const pitFile=process.env.LUNA_PIT_UNIVERSE_FILE;
  const manifestFile=process.env.LUNA_PIT_MEMBERSHIP_MANIFEST_FILE;
  const out=process.env.LUNA_HOLDOUT_LOCK_FILE ?? process.argv[3];
  if(!input||!pitFile||!manifestFile||!out){
    throw new Error("BACKTEST_FILE, LUNA_PIT_UNIVERSE_FILE, LUNA_PIT_MEMBERSHIP_MANIFEST_FILE and LUNA_HOLDOUT_LOCK_FILE are required");
  }
  assertPitMembershipProvenance(pitFile,manifestFile);
  let quotes=await readNormalizedCsv(input);
  validateResearchQuotes(quotes,{requireSourceTs:true,requireVerifiedBook:true,minSymbols:Number(process.env.LUNA_RESEARCH_MIN_SYMBOLS??1)});
  const membership=await readPitMembershipCsv(pitFile);
  quotes=applyPitUniverse(quotes,membership).quotes;
  const buckets=[...new Set(quotes.map(q=>bucket15m(q.sourceTs??q.ts)).filter((x):x is number=>x!==null))].sort((a,b)=>a-b);
  if(buckets.length<100) throw new Error("Need at least 100 observed 15m buckets");
  const holdoutStartIndex=Math.floor(buckets.length*0.80);
  const holdoutStart=buckets[holdoutStartIndex];
  if(!holdoutStart) throw new Error("Invalid holdout boundary");
  const holdout=quotes.filter(q=>(bucket15m(q.sourceTs??q.ts)??-Infinity)>=holdoutStart);
  const body={
    schemaVersion:"LUNA-HOLDOUT-LOCK-V1",
    protocolVersion:"LUNA-15M-HOLDOUT-V1",
    datasetSha256:fileSha(input),
    holdoutStart:new Date(holdoutStart).toISOString(),
    holdoutDigest:digestQuotes(holdout),
    frozenAt:new Date().toISOString(),
    datasetRows:quotes.length,
    observed15mBuckets:buckets.length,
    pitMembershipFileSha256:fileSha(pitFile),
    pitMembershipManifest:path.resolve(manifestFile),
    selectionSplit:"60% development / 20% audit / 20% final holdout"
  };
  if(fs.existsSync(out)) throw new Error("HOLDOUT_LOCK_ALREADY_EXISTS:"+out);
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out,JSON.stringify(body,null,2)+"\n","utf8");
  console.log(JSON.stringify(body,null,2));
}
main().catch(err=>{console.error(String(err));process.exit(1);});
