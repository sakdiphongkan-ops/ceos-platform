// Deterministic offline smoke test for LUNA paper execution.
// This test imports only the local execution/risk engine; it does not call a broker,
// market-data provider, Supabase, or any network service.
process.env.LUNA_MODE = "paper";
process.env.LUNA_EXECUTION_MODE = "paper";
process.env.LUNA_INITIAL_CAPITAL = "30000";
process.env.LUNA_PRICE_ONLY_FALLBACK = "false";
process.env.LIVE_TRADING_ARMED = "false";
process.env.LUNA_LIVE_ORDER_GATE_ENABLED = "false";

const { createPortfolio, mark, planOrder, simulateFill, applyFill, snapshot } =
  await import("./execution.js");

const start = "2026-10-19T03:00:00.000Z";
const verifiedQuote = {
  symbol: "PTT",
  ts: start,
  sourceTs: start,
  bid: 99.90,
  ask: 100.10,
  last: 100.00,
  bidSize: 10_000,
  askSize: 10_000,
  source: "deterministic-offline-fixture",
  dataQuality: "verified"
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const state = createPortfolio(30_000);
mark(state, verifiedQuote);

const buy = planOrder({
  symbol: "PTT",
  ts: start,
  action: "BUY",
  reason: "OFFLINE_PAPER_SMOKE_BUY",
  strategyVersion: "paper-smoke-test",
  targetAllocationPct: 5
}, verifiedQuote, state);

assert(buy.accepted, `verified-book paper BUY should be accepted: ${buy.reason}`);
assert(buy.qty > 0, "paper BUY quantity must be positive");
assert(buy.referencePrice === verifiedQuote.ask, "BUY must reference ask, not last or bid");
assert(buy.qty * buy.referencePrice <= 30_000, "BUY notional exceeds starting capital");

const buyFill = simulateFill(buy);
assert(Number.isFinite(buyFill.fillPrice) && buyFill.fillPrice >= buy.referencePrice,
  "BUY fill must be finite and include non-negative execution costs");
assert(buyFill.fee > 0, "paper BUY must include configured transaction fees");
applyFill(state, buyFill);
mark(state, { ...verifiedQuote, ts: "2026-10-19T03:15:00.000Z" });

const afterBuy = snapshot(state);
assert(state.positions.PTT?.qty === buy.qty, "position quantity must equal filled BUY quantity");
assert(state.cash >= 0, "cash must not become negative after BUY");
assert(Number.isFinite(afterBuy.cash + afterBuy.market_value), "equity must be finite");
assert(afterBuy.fees > 0, "snapshot must report accumulated fees");

const sellTs = "2026-10-19T03:15:00.000Z";
const sellQuote = { ...verifiedQuote, ts: sellTs };
mark(state, sellQuote);
const sell = planOrder({
  symbol: "PTT",
  ts: sellTs,
  action: "SELL",
  reason: "OFFLINE_PAPER_SMOKE_SELL",
  strategyVersion: "paper-smoke-test"
}, sellQuote, state);

assert(sell.accepted, `paper SELL against an existing position should be accepted: ${sell.reason}`);
assert(sell.qty === buy.qty, "SELL should close the complete long-only test position");
assert(sell.referencePrice === sellQuote.bid, "SELL must reference bid");
const sellFill = simulateFill(sell);
assert(Number.isFinite(sellFill.fillPrice) && sellFill.fillPrice <= sell.referencePrice,
  "SELL fill must be finite and include non-negative execution costs");
applyFill(state, sellFill);

const final = snapshot(state);
assert(state.positions.PTT?.qty === 0, "paper SELL should close the position");
assert(state.cash > 0 && state.cash < 30_000, "flat-price round trip should leave positive cash and reflect costs");
assert(final.market_value === 0, "closed position should have zero market value");
assert(final.realized_pnl < 0, "flat-price round trip should lose money after spread/fees/slippage");
assert(Math.abs(state.cash - (30_000 + final.realized_pnl)) < 1e-6,
  "cash must reconcile to initial capital plus realized P&L");
assert(final.fees >= buyFill.fee + sellFill.fee, "fees must accumulate across both sides");

// Fail-closed check: an unverified quote with no executable book must not create a BUY.
const noBookState = createPortfolio(30_000);
const unverifiedQuote = {
  ...verifiedQuote,
  bid: null,
  ask: null,
  bidSize: 0,
  askSize: 0,
  source: "historical-unverified-fixture",
  dataQuality: "unverified"
};
mark(noBookState, unverifiedQuote);
const blocked = planOrder({
  symbol: "PTT",
  ts: start,
  action: "BUY",
  reason: "MUST_BLOCK_WITHOUT_BOOK",
  strategyVersion: "paper-smoke-test",
  targetAllocationPct: 5
}, unverifiedQuote, noBookState);
assert(!blocked.accepted, "BUY must be blocked without a verified executable book");
assert(noBookState.positions.PTT === undefined, "blocked BUY must not create a position");
assert(noBookState.cash === 30_000, "blocked BUY must not change cash");

// Verify the process remains paper-only and no live arm was set by the test.
assert(process.env.LUNA_MODE === "paper", "test must remain in paper mode");
assert(process.env.LUNA_EXECUTION_MODE === "paper", "test must remain in paper execution mode");
assert(process.env.LIVE_TRADING_ARMED === "false", "live trading must remain disarmed");
assert(process.env.LUNA_LIVE_ORDER_GATE_ENABLED === "false", "live order gate must remain disabled");

console.log(JSON.stringify({
  event: "LUNA_PAPER_TRADING_SMOKE_TEST_PASS",
  mode: "offline-paper-only",
  initialCapitalTHB: 30_000,
  buyQty: buy.qty,
  sellQty: sell.qty,
  endingCashTHB: Number(state.cash.toFixed(2)),
  realizedPnlTHB: Number(final.realized_pnl.toFixed(2)),
  feesTHB: Number(final.fees.toFixed(2)),
  checks: [
    "BUY against verified fixture book",
    "SELL closes position",
    "fees and slippage applied",
    "cash/P&L reconciliation",
    "unverified/no-book BUY blocked",
    "live order gate remains disabled"
  ]
}, null, 2));
