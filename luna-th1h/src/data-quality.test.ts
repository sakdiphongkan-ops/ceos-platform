import {strict as assert} from "node:assert";
import {assessQuoteQuality} from "./data-quality.js";

const now=Date.parse("2026-09-24T03:00:00.000Z");
const base={
  symbol:"PTT",
  ts:"2026-09-24T02:59:59.000Z",
  sourceTs:"2026-09-24T02:59:58.900Z",
  bid:31.75,
  ask:31.80,
  last:31.80,
  bidSize:1000,
  askSize:1200,
  source:"test"
};

assert.equal(assessQuoteQuality(base,now,2000).ok,true);
assert.equal(assessQuoteQuality({...base,ts:"2026-09-24T02:59:55.000Z"},now,2000).reason,"STALE_QUOTE");
assert.equal(assessQuoteQuality({...base,bid:32,ask:31.8},now,2000).reason,"CROSSED_BOOK");
assert.equal(assessQuoteQuality({...base,last:null,bid:null,ask:null},now,2000).reason,"NO_USABLE_PRICE");
assert.equal(assessQuoteQuality({...base,sourceTs:"2026-09-24T03:00:00.100Z"},now,2000).reason,"SOURCE_TIMESTAMP_AFTER_INGEST");
assert.equal(assessQuoteQuality({...base,ts:"not-a-date"},now,2000).reason,"INVALID_INGEST_TIMESTAMP");
assert.equal(assessQuoteQuality({...base,ts:"2026-09-24T03:00:01.200Z"},now,2000).reason,"INGEST_TIMESTAMP_IN_FUTURE");
assert.equal(assessQuoteQuality({...base,bidSize:-1},now,2000).reason,"INVALID_BID_SIZE");

console.log("data-quality tests passed");
