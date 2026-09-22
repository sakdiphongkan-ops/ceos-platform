import {assertFreshSourceTs,latencyMetrics} from "./latency-ledger.js";
const x=latencyMetrics({
 sourceTs:"2026-09-22T10:00:00.000Z",
 ingestTs:"2026-09-22T10:00:00.100Z",
 decisionTs:"2026-09-22T10:00:00.180Z",
 submitTs:"2026-09-22T10:00:00.220Z",
 ackTs:"2026-09-22T10:00:00.300Z",
 fillTs:"2026-09-22T10:00:00.500Z"
});
if(x.find(v=>v.stage==="source_to_fill")?.ms!==500) throw new Error("latency ledger total mismatch");
if(assertFreshSourceTs("2026-09-22T10:00:00.000Z",Date.parse("2026-09-22T10:00:00.400Z"),1000)!==400) throw new Error("freshness calculation mismatch");
let failed=false;
try{latencyMetrics({sourceTs:"2026-09-22T10:00:00.500Z",ingestTs:"2026-09-22T10:00:00.100Z"});}catch{failed=true}
if(!failed) throw new Error("negative latency sequence must fail");
console.log("latency ledger tests: PASS");
