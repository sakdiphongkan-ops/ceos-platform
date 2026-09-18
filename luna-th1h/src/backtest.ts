import {applyFill,createPortfolio,mark,planOrder,simulateFill,snapshot,type PortfolioState} from "./execution.js";
import {DEFAULT_PARAMS,StrategyV1,type StrategyParams} from "./strategy-v1.js";
import type {Quote} from "./types.js";

export interface BacktestTrade{
  ts:string;
  symbol:string;
  side:"BUY"|"SELL";
  qty:number;
  referencePrice:number;
  fillPrice:number;
  notional:number;
  fee:number;
  slippage:number;
  realizedPnl:number;
  reason:string;
  strategyVersion:string;
}

export interface BacktestEquityPoint{
  ts:string;
  equity:number;
  cash:number;
  marketValue:number;
  grossExposure:number;
  realizedPnl:number;
  unrealizedPnl:number;
  fees:number;
}

export interface BacktestResult{
  strategyVersion:string;
  initialCapital:number;
  finalEquity:number;
  netPnl:number;
  returnPct:number;
  maxDrawdown:number;
  tradeCount:number;
  winCount:number;
  lossCount:number;
  totalFees:number;
  totalSlippage:number;
  trades:BacktestTrade[];
  equityCurve:BacktestEquityPoint[];
  finalPortfolio:ReturnType<typeof snapshot>;
}

function equity(state:PortfolioState){
  const s=snapshot(state);
  return s.cash+s.market_value;
}

function maxDrawdown(curve:BacktestEquityPoint[]){
  let peak=-Infinity;
  let max=0;
  for(const p of curve){
    peak=Math.max(peak,p.equity);
    max=Math.max(max,peak-p.equity);
  }
  return max;
}

export function runBacktest(
  quotes:Quote[],
  initialCapital:number,
  params:Partial<StrategyParams> = DEFAULT_PARAMS
):BacktestResult{
  const strategy=new StrategyV1(params);
  const state=createPortfolio(initialCapital);
  const trades:BacktestTrade[]=[];
  const equityCurve:BacktestEquityPoint[]=[];

  for(const q of quotes){
    const nowMs=Date.parse(q.ts);
    if(!Number.isFinite(nowMs)) throw new Error(`INVALID_TIMESTAMP ${q.ts}`);
    mark(state,q);

    const pos=state.positions[q.symbol];
    const signal=strategy.evaluate(q,{
      positionQty:pos?.qty??0,
      avgPrice:pos?.avgPrice??0,
      nowMs
    });

    const order=planOrder(signal,q,state);
    if(order.accepted){
      const fill=simulateFill(order);
      const beforeRealized=state.positions[q.symbol]?.realizedPnl??0;
      applyFill(state,fill);
      const afterRealized=state.positions[q.symbol]?.realizedPnl??beforeRealized;
      trades.push({
        ts:q.ts,
        symbol:q.symbol,
        side:fill.side,
        qty:fill.qty,
        referencePrice:fill.referencePrice,
        fillPrice:fill.fillPrice,
        notional:fill.notional,
        fee:fill.fee,
        slippage:fill.slippage,
        realizedPnl:afterRealized-beforeRealized,
        reason:signal.reason,
        strategyVersion:signal.strategyVersion
      });
    }

    const s=snapshot(state);
    equityCurve.push({
      ts:q.ts,
      equity:s.cash+s.market_value,
      cash:s.cash,
      marketValue:s.market_value,
      grossExposure:s.gross_exposure,
      realizedPnl:s.realized_pnl,
      unrealizedPnl:s.unrealized_pnl,
      fees:s.fees
    });
  }

  const finalPortfolio=snapshot(state);
  const finalEquity=finalPortfolio.cash+finalPortfolio.market_value;
  const wins=trades.filter(t=>t.realizedPnl>0).length;
  const losses=trades.filter(t=>t.realizedPnl<0).length;

  return {
    strategyVersion:strategy.version,
    initialCapital,
    finalEquity,
    netPnl:finalEquity-initialCapital,
    returnPct:((finalEquity/initialCapital)-1)*100,
    maxDrawdown:maxDrawdown(equityCurve),
    tradeCount:trades.length,
    winCount:wins,
    lossCount:losses,
    totalFees:finalPortfolio.fees,
    totalSlippage:state.slippageCost,
    trades,
    equityCurve,
    finalPortfolio
  };
}
