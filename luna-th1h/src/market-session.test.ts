import {marketPhaseAt,sessionDateAt} from "./market-session.js";

const cases:Array<[string,string]>=([
  ["2026-09-21T02:59:59.000Z","CLOSED"],
  ["2026-09-21T03:00:00.000Z","ACTIVE"],
  ["2026-09-21T05:29:59.000Z","ACTIVE"],
  ["2026-09-21T05:30:00.000Z","BREAK"],
  ["2026-09-21T06:59:59.000Z","BREAK"],
  ["2026-09-21T07:00:00.000Z","ACTIVE"],
  ["2026-09-21T09:19:59.000Z","ACTIVE"],
  ["2026-09-21T09:20:00.000Z","REDUCE_ONLY"],
  ["2026-09-21T09:25:00.000Z","FORCE_CLOSE"],
  ["2026-09-21T09:30:00.000Z","CLOSED"],
  ["2026-09-20T04:00:00.000Z","CLOSED"]
]);

for(const [ts,expected] of cases){
  const actual=marketPhaseAt(ts);
  if(actual!==expected) throw new Error(`marketPhaseAt failed ts=${ts} expected=${expected} actual=${actual}`);
}

const date=sessionDateAt("2026-09-21T16:30:00.000Z");
if(date!=="2026-09-21") throw new Error(`sessionDateAt failed: ${date}`);

let invalidCaught=false;
try{ marketPhaseAt("2026-09-21T09:00:00.000Z","Asia/Bangkok","16:25","16:20"); }
catch(err){ invalidCaught=String(err).includes("forceCloseTime must be after reduceOnlyTime"); }
if(!invalidCaught) throw new Error("invalid close-time ordering was not rejected");

console.log("market-session tests: PASS");
