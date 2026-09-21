import type {PortfolioState} from "./execution.js";

export interface BrokerPositionSnapshot{
  symbol:string;
  qty:number;
  avg_price:number;
}

export interface BrokerAccountSnapshot{
  cash:number;
  positions:BrokerPositionSnapshot[];
}

export interface LiveReconciliationTolerance{
  cash:number;
  qty:number;
}

export interface LiveReconciliationResult{
  ok:boolean;
  cashDelta:number;
  positionMismatches:Array<{
    symbol:string;
    localQty:number;
    brokerQty:number;
    delta:number;
  }>;
}

export function compareLiveAccountState(
  local:Pick<PortfolioState,"cash"|"positions">,
  broker:BrokerAccountSnapshot,
  tolerance:LiveReconciliationTolerance
):LiveReconciliationResult{
  const cashDelta=broker.cash-local.cash;
  const brokerBySymbol=new Map(
    broker.positions
      .filter(x=>x.qty>0)
      .map(x=>[x.symbol,x.qty] as const)
  );
  const symbols=new Set([
    ...Object.keys(local.positions),
    ...brokerBySymbol.keys()
  ]);

  const positionMismatches:Array<{
    symbol:string;
    localQty:number;
    brokerQty:number;
    delta:number;
  }>=[];

  for(const symbol of [...symbols].sort()){
    const localQty=Math.max(0,Number(local.positions[symbol]?.qty??0));
    const brokerQty=Math.max(0,Number(brokerBySymbol.get(symbol)??0));
    const delta=brokerQty-localQty;
    if(Math.abs(delta)>tolerance.qty){
      positionMismatches.push({symbol,localQty,brokerQty,delta});
    }
  }

  return {
    ok:Number.isFinite(cashDelta)
      && Math.abs(cashDelta)<=tolerance.cash
      && positionMismatches.length===0,
    cashDelta,
    positionMismatches
  };
}
