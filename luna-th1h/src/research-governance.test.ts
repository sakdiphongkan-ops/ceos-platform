import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {assertFrozenHoldoutAllowed,assertPitMembershipProvenance,digestQuotes,writeHoldoutExposureLedger} from "./research-governance.js";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"luna-governance-"));
const membership=path.join(dir,"membership.csv");
const manifest=path.join(dir,"membership.manifest.json");
fs.writeFileSync(membership,"symbol,start_date,end_date\nAAA,2026-01-01,\n","utf8");
const membershipSha=requireSha(membership);
fs.writeFileSync(manifest,JSON.stringify({
  schemaVersion:"LUNA-PIT-MEMBERSHIP-V1",
  provider:"SET",
  sourceUrl:"https://www.set.or.th/en/",
  authorityLevel:"PRIMARY_EXCHANGE",
  retrievedAt:"2026-09-22T00:00:00Z",
  membershipFileSha256:membershipSha
},null,2),"utf8");
assertPitMembershipProvenance(membership,manifest);

const quotes=[
  {symbol:"AAA",ts:"2026-01-02T03:00:01.000Z",sourceTs:"2026-01-02T03:00:00.000Z",bid:100,ask:100.1,last:100.05,bidSize:100,askSize:100,source:"SET",dataQuality:"verified"}
];
const lock=path.join(dir,"holdout.lock.json");
const holdoutDigest=digestQuotes(quotes);
fs.writeFileSync(lock,JSON.stringify({
  schemaVersion:"LUNA-HOLDOUT-LOCK-V1",
  protocolVersion:"LUNA-15M-HOLDOUT-V1",
  datasetSha256:"dataset",
  holdoutStart:quotes[0].sourceTs,
  holdoutDigest,
  frozenAt:"2026-09-22T00:00:00Z"
},null,2),"utf8");
const ledger=path.join(dir,"exposure.json");
assertFrozenHoldoutAllowed({lockFile:lock,exposureLedger:ledger,datasetSha256:"dataset",holdoutStart:quotes[0].sourceTs,holdoutDigest});
writeHoldoutExposureLedger(ledger,{protocolVersion:"LUNA-15M-HOLDOUT-V1",datasetSha256:"dataset",holdoutStart:quotes[0].sourceTs,holdoutDigest,exposedAt:"2026-09-22T00:00:00Z",candidateCount:1,selectionBasis:"development+audit_only"});
let blocked=false;
try{assertFrozenHoldoutAllowed({lockFile:lock,exposureLedger:ledger,datasetSha256:"dataset",holdoutStart:quotes[0].sourceTs,holdoutDigest});}catch(e){blocked=String(e).includes("HOLDOUT_ALREADY_EXPOSED");}
if(!blocked) throw new Error("holdout replay was not blocked");
console.log("research governance tests: PASS");

const requireSha=(file:string)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
