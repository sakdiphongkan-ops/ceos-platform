export type SignalSizingInput = {
  momentumBps:number;
  minMomentumBps:number;
  trendGapBps:number;
  hasBook:boolean;
  dataQuality?:string;
};

export type SignalSizing = {
  strength:number;
  targetFraction:number;
  reason:string;
};

function clamp(value:number,min=0,max=1){
  return Math.min(max,Math.max(min,value));
}

export function computeSignalSizing(input:SignalSizingInput):SignalSizing{
  const fullMomentumBps=Math.max(input.minMomentumBps+40,120);
  const momentumScore=clamp(
    (input.momentumBps-input.minMomentumBps) /
    Math.max(1,fullMomentumBps-input.minMomentumBps)
  );
  const trendScore=clamp(input.trendGapBps/50);

  // A public last-price feed without a verified book is useful for paper research,
  // but it is intentionally sized smaller than a verified bid/ask feed.
  const qualityPenalty=!input.hasBook
    ? (String(input.dataQuality ?? '').includes('unverified') ? 0.55 : 0.65)
    : 1;

  const rawStrength=0.60*momentumScore+0.40*trendScore;
  const strength=clamp(rawStrength*qualityPenalty);

  // Non-linear sizing: weak signals stay small; exceptional signals can consume
  // nearly all available portfolio capacity. There is no fixed 20% per-symbol cap.
  const targetFraction=clamp(0.05 + 0.95*Math.pow(strength,1.7));

  return {
    strength,
    targetFraction,
    reason:[
      'momentum='+momentumScore.toFixed(3),
      'trend='+trendScore.toFixed(3),
      'data='+qualityPenalty.toFixed(2),
      'target='+(targetFraction*100).toFixed(1)+'%'
    ].join(' ')
  };
}
