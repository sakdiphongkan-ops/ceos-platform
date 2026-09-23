import {describe,expect,it} from "vitest";
import {applyM1OverlayToSignal,computeM1OverlayWeights} from "./m1-overlay.js";

const rows=Array.from({length:20},(_,i)=>({
  symbol:"S"+String(i).padStart(2,"0"),
  selectionScore:i/20,
  mom3:i/100,
  high52Ratio:0.8+i/1000,
  vol20:0.01+i/1000,
  avgAmount20:1_000_000+i*1000
}));

describe("M1 L2 overlay",()=>{
  it("produces exact 20 weights summing to 100%",()=>{
    const out=computeM1OverlayWeights(rows);
    expect(out).toHaveLength(20);
    expect(out.reduce((s,x)=>s+x.weight,0)).toBeCloseTo(1,12);
    expect(Math.min(...out.map(x=>x.weight))).toBeCloseTo(0,12);
    expect(Math.max(...out.map(x=>x.weight))).toBeCloseTo(0.10,12);
  });
  it("neutralizes missing MOM3 without dropping the name",()=>{
    const out=computeM1OverlayWeights(rows.map((x,i)=>i===19?{...x,mom3:null}:x));
    expect(out).toHaveLength(20);
    expect(out.some(x=>x.symbol==="S19"&&x.mom3Missing)).toBe(true);
    expect(out.reduce((s,x)=>s+x.weight,0)).toBeCloseTo(1,12);
  });
  it("shadow never changes the allocation",()=>{
    const r=applyM1OverlayToSignal({action:"BUY",symbol:"S01",targetAllocationPct:7.5,overlayAction:"SHADOW",overlayWeight:0.02});
    expect(r.targetAllocationPct).toBe(7.5);
  });
  it("enforce caps or blocks a BUY",()=>{
    const capped=applyM1OverlayToSignal({action:"BUY",symbol:"S01",targetAllocationPct:7.5,overlayAction:"ENFORCE",overlayWeight:0.03});
    expect(capped.targetAllocationPct).toBe(3);
    const blocked=applyM1OverlayToSignal({action:"BUY",symbol:"S02",targetAllocationPct:7.5,overlayAction:"ENFORCE",overlayWeight:0});
    expect(blocked.accepted).toBe(false);
  });
});