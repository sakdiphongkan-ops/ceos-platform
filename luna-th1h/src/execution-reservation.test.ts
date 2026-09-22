import {createPortfolio,planOrder,simulateFill,type ExecutionReservations} from "./execution.js";

const state=createPortfolio(1000);
const reservations:ExecutionReservations={
  reservedBuyCash:0,
  reservedGrossExposure:0,
  reservedSellQty:{}
};

const q=(symbol:string,last:number)=>({
  symbol,
  ts:"2026-09-21T03:00:00.000Z",
  bid:last-0.01,
  ask:last+0.01,
  last,
  bidSize:100,
  askSize:100,
  source:"test"
});

const signal=(symbol:string)=>({
  symbol,
  ts:"2026-09-21T03:00:00.000Z",
  action:"BUY" as const,
  reason:"TEST",
  strategyVersion:"test",
  targetAllocationPct:100
});

const first=planOrder(signal("AAA"),q("AAA",10),state,reservations);
if(!first.accepted) throw new Error("first order should be accepted");
if(first.qty>5) throw new Error("per-entry cap should limit the first order");
const fill=simulateFill(first);
const reservedCash=Math.max(0,-fill.totalCashDelta);
const reservedGross=Math.max(0,fill.notional);
reservations.reservedBuyCash+=reservedCash;
reservations.reservedGrossExposure+=reservedGross;

const second=planOrder(signal("BBB"),q("BBB",10),state,reservations);
if(second.accepted) throw new Error("second order must be blocked by reservations");

console.log("execution reservation tests: PASS");
