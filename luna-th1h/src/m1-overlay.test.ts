import {applyM1OverlayToSignal,computeM1OverlayWeights} from "./m1-overlay.js";

const rows=Array.from({length:20},(_,i)=>({
  symbol:"S"+String(i).padStart(2,"0"),
  selectionScore:i/20,
  mom3:i/100,
  high52Ratio:0.8+i/1000,
  vol20:0.01+i/1000,
  avgAmount20:1_000_000+i*1000
}));

const out=computeM1OverlayWeights(rows);
if(out.length!==20) throw new Error("expected exact 20 weights");
if(Math.abs(out.reduce((s,x)=>s+x.weight,0)-1)>1e-12) throw new Error("weight sum != 100%");
if(Math.min(...out.map(x=>x.weight))<0) throw new Error("negative weight");
if(Math.max(...out.map(x=>x.weight))>0.100000000001) throw new Error("weight > 10%");
if(Math.abs(Math.min(...out.map(x=>x.weight))-0)>1e-12) throw new Error("min weight != 0%");
if(Math.abs(Math.max(...out.map(x=>x.weight))-0.1)>1e-12) throw new Error("max weight != 10%");

const missing=computeM1OverlayWeights(rows.map((x,i)=>i===19?{...x,mom3:null}:x));
if(!missing.find(x=>x.symbol==="S19"&&x.mom3Missing)) throw new Error("missing MOM3 was not neutralized");
if(Math.abs(missing.reduce((s,x)=>s+x.weight,0)-1)>1e-12) throw new Error("missing MOM3 changed weight sum");

const shadow=applyM1OverlayToSignal({
  action:"BUY",symbol:"S01",targetAllocationPct:7.5,overlayAction:"SHADOW",overlayWeight:0.02
});
if(shadow.targetAllocationPct!==7.5) throw new Error("shadow mode changed allocation");

const capped=applyM1OverlayToSignal({
  action:"BUY",symbol:"S01",targetAllocationPct:7.5,overlayAction:"ENFORCE",overlayWeight:0.03
});
if(capped.targetAllocationPct!==3) throw new Error("enforce cap failed");

const blocked=applyM1OverlayToSignal({
  action:"BUY",symbol:"S02",targetAllocationPct:7.5,overlayAction:"ENFORCE",overlayWeight:0
});
if(blocked.accepted) throw new Error("zero overlay weight must block BUY");

console.log("M1 L2 overlay tests: PASS");
