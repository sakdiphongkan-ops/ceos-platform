import {applyPitUniverse} from "./pit-universe.js";
import type {Quote} from "./types.js";

const base={
  ts:"2026-01-02T03:01:00.000Z",
  sourceTs:"2026-01-02T03:00:00.000Z",
  bid:100,ask:100.1,last:100.05,bidSize:1000,askSize:1000,
  source:"SET",dataQuality:"VERIFIED_BOOK"
};

const membership=new Map<string,Array<{start:number;end:number|null}>>([
  ["AAA",[{start:Date.parse("2026-01-01T00:00:00Z"),end:Date.parse("2026-01-31T00:00:00Z")}]],
  ["BBB",[{start:Date.parse("2026-02-01T00:00:00Z"),end:null}]]
]);

const quotes:Quote[]=[
  {...base,symbol:"AAA"},
  {...base,symbol:"BBB"},
  {...base,symbol:"CCC"}
];
const r=applyPitUniverse(quotes,membership);
if(r.quotes.length!==1 || r.quotes[0].symbol!=="AAA") throw new Error("PIT_FILTER_FAILED");
if(r.excludedRows!==2 || r.activeSymbols!==1) throw new Error("PIT_COUNTS_FAILED");
console.log("PIT universe regression tests passed");
