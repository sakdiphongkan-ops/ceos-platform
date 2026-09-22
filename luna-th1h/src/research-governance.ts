import fs from "node:fs";
import crypto from "node:crypto";

function sha256File(file:string){
  const h=crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function stableLevel(levels:any[]|undefined){
  return Array.isArray(levels)
    ? levels.map(x=>({price:Number(x?.price),size:Number(x?.size)}))
      .filter(x=>Number.isFinite(x.price)&&Number.isFinite(x.size))
    : null;
}

function canonicalQuote(q:any){
  return JSON.stringify({
    symbol:q.symbol,
    ts:q.ts,
    sourceTs:q.sourceTs??null,
    bid:q.bid??null,
    ask:q.ask??null,
    last:q.last??null,
    bidSize:q.bidSize??null,
    askSize:q.askSize??null,
    source:q.source??null,
    dataQuality:q.dataQuality??null,
    bidLevels:stableLevel(q.bidLevels),
    askLevels:stableLevel(q.askLevels)
  });
}

export function digestQuotes(quotes:any[]){
  const h=crypto.createHash("sha256");
  for(const q of quotes) h.update(canonicalQuote(q)+"\n");
  return h.digest("hex");
}

export interface PitMembershipManifest{
  schemaVersion:string;
  provider:string;
  sourceUrl:string;
  authorityLevel:string;
  retrievedAt:string;
  membershipFileSha256:string;
}

export function assertPitMembershipProvenance(membershipFile:string,manifestFile:string){
  const raw=JSON.parse(fs.readFileSync(manifestFile,"utf8")) as Partial<PitMembershipManifest>;
  if(raw.schemaVersion!=="LUNA-PIT-MEMBERSHIP-V1") throw new Error("PIT_MANIFEST_SCHEMA_INVALID");
  for(const key of ["provider","sourceUrl","authorityLevel","retrievedAt","membershipFileSha256"] as const){
    if(!String(raw[key]??"").trim()) throw new Error("PIT_MANIFEST_MISSING_"+key.toUpperCase());
  }
  const expected=sha256File(membershipFile);
  if(raw.membershipFileSha256!==expected) throw new Error("PIT_MEMBERSHIP_SHA256_MISMATCH");
  const parsedUrl=new URL(String(raw.sourceUrl));
  const allowed=(process.env.LUNA_PIT_AUTHORITY_DOMAINS??"set.or.th,settrade.com")
    .split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  const host=parsedUrl.hostname.toLowerCase();
  const domainOk=allowed.some(d=>host===d||host.endsWith("."+d));
  if(!domainOk) throw new Error("PIT_MANIFEST_SOURCE_DOMAIN_NOT_ALLOWED:"+host);
  if(!["PRIMARY_EXCHANGE","INDEX_PROVIDER","ISSUER_OFFICIAL"].includes(String(raw.authorityLevel))){
    throw new Error("PIT_MANIFEST_AUTHORITY_LEVEL_INVALID");
  }
  if(!Number.isFinite(Date.parse(String(raw.retrievedAt)))){
    throw new Error("PIT_MANIFEST_RETRIEVED_AT_INVALID");
  }
  return raw as PitMembershipManifest;
}

interface FrozenHoldoutLock{
  schemaVersion:string;
  protocolVersion:string;
  datasetSha256:string;
  holdoutStart:string;
  holdoutDigest:string;
  frozenAt:string;
}

export function assertFrozenHoldoutAllowed(input:{
  lockFile:string;
  exposureLedger:string;
  datasetSha256:string;
  holdoutStart:string;
  holdoutDigest:string;
}){
  if(fs.existsSync(input.exposureLedger)){
    throw new Error("HOLDOUT_ALREADY_EXPOSED:"+input.exposureLedger);
  }
  const lock=JSON.parse(fs.readFileSync(input.lockFile,"utf8")) as Partial<FrozenHoldoutLock>;
  if(lock.schemaVersion!=="LUNA-HOLDOUT-LOCK-V1") throw new Error("HOLDOUT_LOCK_SCHEMA_INVALID");
  if(lock.protocolVersion!=="LUNA-15M-HOLDOUT-V1") throw new Error("HOLDOUT_LOCK_PROTOCOL_INVALID");
  if(lock.datasetSha256!==input.datasetSha256) throw new Error("HOLDOUT_DATASET_SHA256_MISMATCH");
  if(lock.holdoutStart!==input.holdoutStart) throw new Error("HOLDOUT_START_MISMATCH");
  if(lock.holdoutDigest!==input.holdoutDigest) throw new Error("HOLDOUT_DIGEST_MISMATCH");
  if(!Number.isFinite(Date.parse(String(lock.frozenAt)))) throw new Error("HOLDOUT_LOCK_TIMESTAMP_INVALID");
  return lock as FrozenHoldoutLock;
}

export function writeHoldoutExposureLedger(file:string,payload:Record<string,unknown>){
  if(fs.existsSync(file)) throw new Error("HOLDOUT_EXPOSURE_LEDGER_ALREADY_EXISTS");
  fs.mkdirSync(require("node:path").dirname(file),{recursive:true});
  const body={
    schemaVersion:"LUNA-HOLDOUT-EXPOSURE-V1",
    ...payload
  };
  const tmp=file+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(body,null,2),"utf8");
  fs.renameSync(tmp,file);
}
