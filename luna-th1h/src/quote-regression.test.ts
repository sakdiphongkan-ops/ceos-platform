/**
 * Regression matrix for work items 202610170003 + 202610170001.
 * This is an offline, deterministic paper-only test. It does not call any
 * provider, write to Supabase, create orders, or enable live trading.
 */
import {strict as assert} from "node:assert";
import {boundedPositiveNumber,normalizeGatewayQuote,shouldEmitQuote} from "./market/provider.js";
import {normalizeSetStockQuote,numberOrNull} from "./market/set-marketplace.js";
import {createPortfolio,planOrder} from "./execution.js";

const NOW=Date.parse("2026-10-18T03:00:00.000Z");
const FRESH_TS=new Date(NOW-250).toISOString();

const validRaw={
  symbol:"PTT",
  ts:FRESH_TS,
  source_ts:FRESH_TS,
  book_received_ts:FRESH_TS,
  book_source_ts:FRESH_TS,
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
  assert.equal(normalize({bid:true}),null);
  assert.equal(normalize({ask:{price:31.8}}),null);
  // Even callers that disable the verified-book gate cannot turn malformed
  // supplied numeric fields into silently missing values.
  assert.equal(normalizeGatewayQuote({
    ...validRaw,bid:true
  },2_000,false,false,true,false,NOW),null);
  assert.equal(normalizeGatewayQuote({
    ...validRaw,ask:"Infinity"
  },2_000,false,false,true,false,NOW),null);
  assert.equal(normalize({...validRaw,book_received_ts:undefined}),null);
  assert.equal(normalize({...validRaw,book_received_ts:new Date(NOW-5_000).toISOString()}),null);
  assert.equal(normalize({...validRaw,book_source_ts:new Date(NOW-5_000).toISOString()}),null);
  assert.doesNotThrow(()=>normalize({bid_levels:[null,{price:true,size:"large"}]}));
});

// 6. Verification must be an exact approved marker, not a substring match.
check("strict_verification_provenance",()=>{
  assert.equal(normalize({data_quality:undefined,verified_book:undefined,verified:undefined}),null);
  assert.equal(normalize({data_quality:"not verified",verified_book:undefined,verified:undefined}),null);
  assert.equal(normalize({data_quality:"unverified_book",verified_book:undefined,verified:undefined}),null);
  assert.ok(normalize({data_quality:"VERIFIED_BOOK"}));
  assert.equal(normalize({
    source:"settrade-open-api-realtime-spoof",
    data_quality:undefined,verified_book:undefined,verifiedBook:undefined,verified:undefined
  }),null);
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
  // Receipt timestamps may advance on each poll without creating a new source quote.
  assert.equal(shouldEmitQuote(previous,{
    ...q,
    ts:new Date(NOW-100).toISOString(),
    bookReceivedTs:new Date(NOW-100).toISOString()
  }),false);
  // A real source timestamp change must still pass through.
  assert.equal(shouldEmitQuote(previous,{
    ...q,sourceTs:new Date(NOW-200).toISOString()
  }),true);
  assert.equal(shouldEmitQuote(previous,{
    ...q,bidLevels:[{price:31.7,size:500}]
  }),true);

  // Preserve changes to an actual book timestamp even when quote source_ts is absent.
  const bookOnlyPrevious=new Map<string,string>();
  const bookOnly={...q,sourceTs:undefined,bookSourceTs:new Date(NOW-250).toISOString()};
  assert.equal(shouldEmitQuote(bookOnlyPrevious,bookOnly),true);
  assert.equal(shouldEmitQuote(bookOnlyPrevious,{
    ...bookOnly,ts:new Date(NOW-100).toISOString(),
    bookReceivedTs:new Date(NOW-100).toISOString()
  }),false);
  assert.equal(shouldEmitQuote(bookOnlyPrevious,{
    ...bookOnly,bookSourceTs:new Date(NOW-200).toISOString()
  }),true);
});

// 10. Source identifiers are exact allowlisted values, not prefixes.
check("execution_source_allowlist_is_exact",()=>{
  const normalized=normalize();
  assert.ok(normalized);
  const spoofed={...normalized,source:"settrade-open-api-realtime-spoof",dataQuality:undefined};
  const result=planOrder({
    symbol:"PTT",ts:FRESH_TS,action:"BUY",
    reason:"REGRESSION_SOURCE_SPOOF",strategyVersion:"quote-regression"
  },spoofed,createPortfolio(30_000));
  assert.equal(result.accepted,false);
  if(!result.accepted) assert.equal(result.reason,"BUY_BLOCKED_NO_VERIFIED_BOOK");

  const mismatch=planOrder({
    symbol:"KBANK",ts:FRESH_TS,action:"BUY",
    reason:"REGRESSION_SYMBOL_MISMATCH",strategyVersion:"quote-regression"
  },normalized,createPortfolio(30_000));
  assert.equal(mismatch.accepted,false);
  if(!mismatch.accepted) assert.equal(mismatch.reason,"QUOTE_SYMBOL_MISMATCH");

  const malformedBook={...normalized,bid:true as unknown as number};
  const invalidBook=planOrder({
    symbol:"PTT",ts:FRESH_TS,action:"BUY",
    reason:"REGRESSION_NON_NUMERIC_BOOK",strategyVersion:"quote-regression"
  },malformedBook,createPortfolio(30_000));
  assert.equal(invalidBook.accepted,false);
  if(!invalidBook.accepted) assert.equal(invalidBook.reason,"BUY_BLOCKED_NO_VERIFIED_BOOK");
});

// 11. Malformed environment values must not disable quote-age checks or spin polling.
check("bounded_environment_numbers",()=>{
  assert.equal(boundedPositiveNumber("NaN",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("Infinity",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber(true,2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber(null,2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber(["5000"],2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("0",2_000,1,60_000),2_000);
  assert.equal(boundedPositiveNumber("5000",2_000,1,60_000),5_000);
  assert.equal(normalizeGatewayQuote({
    ...validRaw,source_ts:new Date(NOW-5_000).toISOString()
  },Number.NaN,true,false,true,false,NOW),null);
  assert.equal(normalizeGatewayQuote({
    ...validRaw,source_ts:new Date(NOW-5_000).toISOString()
  },Number.POSITIVE_INFINITY,true,false,true,false,NOW),null);
  assert.equal(normalizeGatewayQuote({
    ...validRaw,ts:new Date(NOW-5_000).toISOString(),source_ts:FRESH_TS
  },2_000,true,false,true,false,NOW),null);
  assert.equal(normalizeGatewayQuote({
    ...validRaw,source_ts:1712345678 as unknown as string
  },2_000,true,false,true,false,NOW),null);
});

// 12. Set marketplace must preserve null as null and reject malformed prices.
check("set_marketplace_null_and_invalid_price",()=>{
  assert.equal(numberOrNull(null),null);
  assert.equal(numberOrNull(undefined),null);
  assert.equal(numberOrNull(""),null);
  assert.equal(numberOrNull("  "),null);
  assert.equal(numberOrNull(true),null);
  assert.equal(numberOrNull({price:31.8}),null);
  const freshTime=new Date(NOW-250).toISOString();
  const valid=normalizeSetStockQuote({
    symbol:"PTT",time:freshTime,last:31.8,
    bid:[{rank:1,price:31.7,volume:500}],
    offer:[{rank:1,price:31.8,volume:600}]
  },NOW,2_000);
  assert.ok(valid);
  assert.equal(valid.sourceTs,freshTime);
  assert.equal(valid.bookReceivedTs,new Date(NOW).toISOString());
  assert.equal(valid.bookSourceTs,freshTime);
  assert.equal(valid.ts,new Date(NOW).toISOString());

  const missing=normalizeSetStockQuote({
    symbol:"PTT",time:freshTime,last:null,
    bid:[{rank:1,price:null,volume:null}],
    offer:[{rank:1,price:null,volume:null}]
  },NOW,2_000);
  assert.equal(missing,null);
  const zero=normalizeSetStockQuote({
    symbol:"PTT",time:freshTime,last:0,
    bid:[{rank:1,price:31.7,volume:500}],
    offer:[{rank:1,price:31.8,volume:600}]
  },NOW,2_000);
  assert.equal(zero,null);
  assert.equal(normalizeSetStockQuote({
    symbol:"PTT",time:"not-a-timestamp",last:31.8,
    bid:[{rank:1,price:31.7,volume:500}],
    offer:[{rank:1,price:31.8,volume:600}]
  },NOW,2_000),null);
  assert.equal(normalizeSetStockQuote({
    symbol:"PTT",time:new Date(NOW-10_000).toISOString(),last:31.8,
    bid:[{rank:1,price:31.7,volume:500}],
    offer:[{rank:1,price:31.8,volume:600}]
  },NOW,2_000),null);
  assert.equal(normalizeSetStockQuote({
    symbol:"PTT",time:new Date(NOW+31_000).toISOString(),last:31.8,
    bid:[{rank:1,price:31.7,volume:500}],
    offer:[{rank:1,price:31.8,volume:600}]
  },NOW,2_000),null);
  assert.equal(normalizeSetStockQuote({
    symbol:"PTT",time:new Date(NOW+1_000).toISOString(),last:31.8,
    bid:[{rank:1,price:31.7,volume:500}],
    offer:[{rank:1,price:31.8,volume:600}]
  },NOW,2_000),null);
});

// 13. Explicit public paper-only price fallback clears book data but never emits
// a quote with no usable last price or when live execution is armed.
check("paper_price_only_fallback_is_narrow",()=>{
  const raw={...validRaw,source:"tradingview-public-screener",last:31.8};
  const allowed=normalizeGatewayQuote(raw,2_000,true,true,true,false,NOW);
  assert.ok(allowed);
  assert.equal(allowed.last,31.8);
  assert.equal(allowed.bid,null);
  assert.equal(allowed.ask,null);
  assert.equal(allowed.bidSize,null);
  const noLast=normalizeGatewayQuote({...raw,last:null},2_000,true,true,true,false,NOW);
  assert.equal(noLast,null);
  const liveArmed=normalizeGatewayQuote({
    ...raw,data_quality:undefined,verified_book:undefined,verifiedBook:undefined,verified:undefined
  },2_000,true,true,true,true,NOW);
  assert.equal(liveArmed,null);
});

console.log("LUNA quote regression matrix: PASS");
for(const name of passed) console.log("PASS "+name);
console.log(`TOTAL ${passed.length}/13; paper-only; no network/database/order side effects`);
