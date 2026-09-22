import {monthlyStats} from "./research-metrics.js";
const curve=[
  {ts:"2026-01-02T03:00:00.000Z",equity:90},
  {ts:"2026-01-30T03:00:00.000Z",equity:100},
  {ts:"2026-02-02T03:00:00.000Z",equity:100},
  {ts:"2026-02-27T03:00:00.000Z",equity:110}
];
const r=monthlyStats(curve,100);
if(Math.abs(r.returns[0]-0)>1e-12) throw new Error("first monthly return must use initial capital");
if(Math.abs(r.returns[1]-0.10)>1e-12) throw new Error("second monthly return must use prior month-end equity");
console.log("monthly research metric test: PASS");
