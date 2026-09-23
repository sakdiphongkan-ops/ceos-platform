export type M1OverlayRow = {
  symbol:string;
  selectionScore:number;
  mom3:number|null;
  high52Ratio:number;
  vol20:number;
  avgAmount20:number;
};

export type M1OverlayWeight = {
  symbol:string;
  weight:number;
  residRank:number;
  mom3Missing:boolean;
};

export const M1_ORTHOGONAL_L2_VERSION="luna-m1-orthogonal-sizer-l2-v1";
export const M1_BASE_VERSION="luna-m1s0k20rev-v1";

function pctRank(values:number[]){
  const sorted=[...values].sort((a,b)=>a-b);
  return values.map(v=>{
    const idx=sorted.findIndex(x=>x===v);
    return sorted.length<=1?0.5:idx/(sorted.length-1);
  });
}

function pctRankWithNeutral(values:Array<number|null>,neutral=0.5){
  const nonNull=values.filter((v):v is number=>Number.isFinite(v??NaN));
  if(!nonNull.length) return values.map(()=>neutral);
  const sorted=[...nonNull].sort((a,b)=>a-b);
  const denominator=Math.max(1,values.length-1);
  return values.map(v=>{
    if(!Number.isFinite(v??NaN)) return neutral;
    const idx=sorted.findIndex(x=>x===v);
    return idx<0?neutral:idx/denominator;
  });
}

export function computeM1OverlayWeights(rows:M1OverlayRow[]):M1OverlayWeight[]{
  if(rows.length!==20) throw new Error("M1_OVERLAY_REQUIRES_20_ROWS");
  if(new Set(rows.map(x=>x.symbol)).size!==20) throw new Error("M1_OVERLAY_DUPLICATE_SYMBOL");

  const high52=rows.map(x=>x.high52Ratio);
  const vol20=rows.map(x=>x.vol20);
  const amount=rows.map(x=>x.avgAmount20);

  const rm3=pctRankWithNeutral(rows.map(x=>x.mom3),0.5);
  const rh52=pctRank(high52);
  const rv=pctRank(vol20);
  const ra=pctRank(amount);
  const aux=rows.map((_,i)=>0.40*rm3[i]+0.25*rh52[i]+0.20*(1-rv[i])+0.15*ra[i]);

  const xs=rows.map(x=>x.selectionScore);
  const ys=aux;
  const xMean=xs.reduce((a,b)=>a+b,0)/xs.length;
  const yMean=ys.reduce((a,b)=>a+b,0)/ys.length;
  const denom=xs.reduce((s,x)=>s+(x-xMean)**2,0);
  const slope=denom===0?0:xs.reduce((s,x,i)=>s+(x-xMean)*(ys[i]-yMean),0)/denom;
  const intercept=yMean-slope*xMean;
  const residuals=rows.map((_,i)=>ys[i]-(intercept+slope*xs[i]));

  const ordered=residuals.map((resid,i)=>({resid,index:i})).sort((a,b)=>b.resid-a.resid||rows[a.index].symbol.localeCompare(rows[b.index].symbol));
  const out:M1OverlayWeight[]=[];
  ordered.forEach((item,rank)=>{
    const z=(rank+1-10.5)/9.5;
    out.push({
      symbol:rows[item.index].symbol,
      weight:(1+z)/20,
      residRank:rank+1,
      mom3Missing:!Number.isFinite(rows[item.index].mom3??NaN),
    });
  });
  const sum=out.reduce((s,x)=>s+x.weight,0);
  if(!Number.isFinite(sum)||Math.abs(sum-1)>1e-12) throw new Error("M1_OVERLAY_WEIGHT_SUM_INVALID");
  if(out.some(x=>x.weight<0||x.weight>0.100000000001)) throw new Error("M1_OVERLAY_WEIGHT_RANGE_INVALID");
  return out.sort((a,b)=>a.symbol.localeCompare(b.symbol));
}

export type M1OverlayAction="OFF"|"SHADOW"|"ENFORCE";

export function applyM1OverlayToSignal(input:{
  action:"BUY"|"SELL"|"HOLD";
  symbol:string;
  targetAllocationPct?:number;
  overlayAction:M1OverlayAction;
  overlayWeight:number|undefined;
}){
  const {action,overlayAction,overlayWeight}=input;
  if(action!=="BUY"||overlayAction==="OFF") return {accepted:true,targetAllocationPct:input.targetAllocationPct??null,reason:null};
  const weight=Number(overlayWeight??0);
  if(!Number.isFinite(weight)||weight<0) return {accepted:false,targetAllocationPct:0,reason:"M1_L2_OVERLAY_INVALID_WEIGHT"};
  if(overlayAction==="SHADOW") return {accepted:true,targetAllocationPct:input.targetAllocationPct??null,reason:"M1_L2_SHADOW weight="+(weight*100).toFixed(2)+"%"};
  if(weight<=0) return {accepted:false,targetAllocationPct:0,reason:"M1_L2_OVERLAY_BLOCK"};
  const current=Number(input.targetAllocationPct??0);
  const capped=Math.min(Math.max(current,0),weight*100);
  return {accepted:true,targetAllocationPct:capped,reason:"M1_L2_ENFORCE cap="+(weight*100).toFixed(2)+"%"};
}