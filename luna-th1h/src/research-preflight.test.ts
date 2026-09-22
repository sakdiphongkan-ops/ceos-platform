import {validateResearchQuotes} from "./research-preflight.js";
import type {Quote} from "./types.js";

function q(overrides:Partial<Quote>={}):Quote{
  return {
    symbol:"AAA",
    ts:"2026-01-02T03:01:00.000Z",
    sourceTs:"2026-01-02T03:00:00.000Z",
    bid:100,ask:100.1,last:100.05,bidSize:1000,askSize:1000,
    source:"SET",dataQuality:"VERIFIED_BOOK",
    ...overrides
  };
}

const ok=validateResearchQuotes([q()]);
if(ok.verifiedBookRatio!==1 || ok.sourceTimestampRatio!==1) throw new Error("VALID_ROW_FAILED");

try{ validateResearchQuotes([q({sourceTs:undefined})]); throw new Error("MISSING_SOURCE_TS_NOT_REJECTED"); }catch(e){
  if(!String(e).includes("MISSING_SOURCE_TS")) throw e;
}
try{ validateResearchQuotes([q({dataQuality:"UNVERIFIED"})]); throw new Error("UNVERIFIED_NOT_REJECTED"); }catch(e){
  if(!String(e).includes("UNVERIFIED_BOOK_ROW")) throw e;
}
try{ validateResearchQuotes([q({ts:"2026-01-02T02:59:00.000Z"})]); throw new Error("FUTURE_SOURCE_NOT_REJECTED"); }catch(e){
  if(!String(e).includes("SOURCE_TS_AFTER_INGEST")) throw e;
}
try{
  validateResearchQuotes([
    q({sourceTs:"2026-01-02T03:00:00.000Z",ts:"2026-01-02T03:01:00.000Z"}),
    q({sourceTs:"2026-01-02T02:59:00.000Z",ts:"2026-01-02T03:02:00.000Z"})
  ]);
  throw new Error("OUT_OF_ORDER_NOT_REJECTED");
}catch(e){
  if(!String(e).includes("OUT_OF_ORDER_SOURCE_TS")) throw e;
}
console.log("research preflight regression tests passed");
