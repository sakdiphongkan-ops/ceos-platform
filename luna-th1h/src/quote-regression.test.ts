/**
 * Regression matrix for work items 202610170003 + 202610170001.
 * This is an offline, deterministic paper-only test. It does not call any
 * provider, write to Supabase, create orders, or enable live trading.
 */
import {strict as assert} from "node:assert";
import {boundedPositiveNumber,normalizeGatewayQuote,shouldEmitQuote} from "./market/provider.js";
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

// 5. Invalid/non-positive prices and crossed books must fail closed.
check("invalid_price_and_book",()=>{
  assert.equal(normalize({last:0}),null);
  assert.equal(normalize({bid:-1}),null);
  assert.equal(normalize({bid:31.90,ask:31.80}),null);
});

// 6. Verification must be an exact approved marker, not a substring match.
check("strict_verification_provenance",()=>{
  assert.equal(normalize({data_quality:undefined,verified_book:undefined,verified:undefined}),null);
  assert.equal(normalize({data_quality:"not verified",verified_book:undefined,verified:undefined}),null);
  assert.equal(normalize({data_quality:"unverified_book",verified_book:undefined,verified:undefined}),null);
  assert.ok(normalize({data_quality:"VERIFIED_BOOK"}));
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

// 8. SELL cannot use an unverified last price outside the named paper-only fallback.
check("unverified_sell_with_position",()=>{
  const q={...normalize()!,source:"set-marketplace",dataQuality:"not verified"};
  const portfolio=createPortfolio(30_000);
  portfolio.positions.PTT={qty:100,avgPrice:31.5,costBasis:3150,realizedPnl:0};
  const result=planOrder({
    symbol:"PTT",ts:FRESH_TS,action:"SELL",
    reason:"REGRESSION_UNVERIFIED_SELL",strategyVersion:"quote-regression"
  },q,portfolio);
  assert.equal(result.accepted,false);
  if(!result.accepted) assert.equal(result.reason,"NO_EXIT_PRICE");
});

// 9. Identical duplicate snapshots are suppressed; changed source timestamps
// and changed deeper book levels must be emitted.
check("duplicate_snapshot_includes_depth",()=>{
  const q=normalize();
  assert.ok(q);
  const previous=new Map<string,string>();
  assert.equal(shouldEmitQuote(previous,q),true);
  assert.equal(shouldEmitQuote(previous,{...q}),false);
  assert.equal(shouldEmitQuote(previous,{
    ...q,sourceTs:new Date(NOW-200).toISOString()
  }),true);
  assert.equal(shouldEmitQuote(previous,{
    ...q,bidLevels:[{price:31.7,size:500}]
  }),true);
});

// 10. Malformed environment values must not disable quote-age checks or spin polling.
check("bounded_environment_numbers",()=>{
  assert.equal(boundedPositiveNumber("NaN",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("Infinity",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("0",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("5000",2_000,1,60_000),5_000);
});

console.log("LUNA quote regression matrix: PASS");
for(const name of passed) console.log("PASS "+name);
console.log(`TOTAL ${passed.length}/10; paper-only; no network/database/order side effects`);
