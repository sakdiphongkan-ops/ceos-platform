/**
 * Regression matrix for work items 202610170003 + 202610170001.
 * This is an offline, deterministic paper-only test. It does not call any
 * provider, write to Supabase, create orders, or enable live trading.
 */
import {strict as assert} from "node:assert";
import {normalizeGatewayQuote,shouldEmitQuote} from "./market/provider.js";
import {createPortfolio,planOrder} from "./execution.js";

const NOW=Date.parse("2026-10-18T03:00:00.000Z");
const FRESH_TS=new Date(NOW-250).toISOString();

const validRaw={
  symbol:"PTT",
  ts:FRESH_TS,
  source_ts:FRESH_TS,
  bid:31.75,
  ask:31.80,
  last:31.80,
  bid_size:1000,
  ask_size:1200,
  source:"toptrader-public-ws",
  data_quality:"verified",
};

function normalize(overrides:Record<string,unknown>={}){
  return normalizeGatewayQuote(
    {...validRaw,...overrides},
    2_000,       // max quote age
    true,        // verified order book required
    false,       // public price-only fallback disabled in this matrix
    true,        // paper mode
    false,       // live trading unarmed
    NOW          // deterministic clock
  );
}

const passed:string[]=[];
function check(name:string,fn:()=>void){
  fn();
  passed.push(name);
}

// 1. Fresh quote with explicit verification is accepted.
check("fresh_quote",()=>{
  const q=normalize();
  assert.ok(q);
  assert.equal(q.symbol,"PTT");
  assert.equal(q.bid,31.75);
  assert.equal(q.dataQuality,"verified");
});

// 2. Stale quote must fail closed.
check("stale_quote",()=>{
  const q=normalize({source_ts:new Date(NOW-5_000).toISOString()});
  assert.equal(q,null);
});

// 3. Missing timestamp and missing prices must not become numeric zeroes.
check("missing_quote_fields",()=>{
  assert.equal(normalize({ts:undefined,source_ts:undefined}),null);
  assert.equal(normalize({bid:null,ask:null,last:null}),null);
});

// 4. Future source timestamp must fail closed.
check("future_timestamp",()=>{
  const q=normalize({source_ts:new Date(NOW+1_000).toISOString()});
  assert.equal(q,null);
});

// 5. Crossed/invalid bid-ask book must fail closed.
check("invalid_bid_ask",()=>{
  const q=normalize({bid:31.90,ask:31.80});
  assert.equal(q,null);
});

// 6. Book with no explicit verification provenance must fail closed.
check("missing_verification",()=>{
  const q=normalize({data_quality:undefined,verified_book:undefined,verified:undefined});
  assert.equal(q,null);
});

// 7. SELL with zero holdings must never fabricate sellable quantity.
check("zero_position_sell",()=>{
  const q=normalize();
  assert.ok(q);
  const result=planOrder({
    symbol:"PTT",
    ts:FRESH_TS,
    action:"SELL",
    reason:"REGRESSION_ZERO_POSITION",
    strategyVersion:"quote-regression"
  },q,createPortfolio(30_000));
  assert.equal(result.accepted,false);
  if(!result.accepted) assert.equal(result.reason,"NO_LONG_POSITION");
});

// 8. Identical duplicate snapshots are suppressed; a newer source timestamp is not.
check("duplicate_snapshot",()=>{
  const q=normalize();
  assert.ok(q);
  const previous=new Map<string,string>();
  assert.equal(shouldEmitQuote(previous,q),true);
  assert.equal(shouldEmitQuote(previous,{...q}),false);
  assert.equal(shouldEmitQuote(previous,{
    ...q,sourceTs:new Date(NOW-200).toISOString()
  }),true);
});

console.log("LUNA quote regression matrix: PASS");
for(const name of passed) console.log("PASS "+name);
console.log(`TOTAL ${passed.length}/8; paper-only; no network/database/order side effects`);
