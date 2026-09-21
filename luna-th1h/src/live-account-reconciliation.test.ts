import {compareLiveAccountState} from "./live-account-reconciliation.js";

const local={
  cash:100000,
  positions:{
    AAA:{qty:100,avgPrice:100,costBasis:10000,realizedPnl:0}
  }
};

const match=compareLiveAccountState(local,{
  cash:99990,
  positions:[{symbol:"AAA",qty:100,avg_price:100}]
},{cash:25,qty:0.5});
if(!match.ok) throw new Error("matching broker state should pass");

const cashDrift=compareLiveAccountState(local,{
  cash:99800,
  positions:[{symbol:"AAA",qty:100,avg_price:100}]
},{cash:25,qty:0.5});
if(cashDrift.ok) throw new Error("cash drift should block");

const positionDrift=compareLiveAccountState(local,{
  cash:100000,
  positions:[{symbol:"AAA",qty:101,avg_price:100}]
},{cash:25,qty:0.5});
if(positionDrift.ok) throw new Error("position drift should block");
if(positionDrift.positionMismatches[0]?.symbol!=="AAA") throw new Error("missing AAA mismatch");

console.log("live account reconciliation tests: PASS");
