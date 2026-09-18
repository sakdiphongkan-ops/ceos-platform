import {StrategyV1,type StrategyParams} from "./strategy-v1.js";
import {applyFill,createPortfolio,mark,planOrder,simulateFill,snapshot,type PortfolioState} from "./execution.js";
import type {Quote,Signal} from "./types.js";
import {createUniverseFilter,type UniverseMembership} from "./universe.js";
import type {BacktestEquityPoint,BacktestResult,BacktestTrade} from "./backtest.js";

export interface ResearchV2Config{
  maxCandidatesPerTimestamp:number;
  ranking:{momentumWeight:number;imbalanceWeight:number;spreadWeight:number};
  allowedMarkets:string[];
  sessionTimeZone:string;
  universeMemberships?:UniverseMembership[];
}
export interface ResearchV2Run{
  variant:number;
  params:Partial<StrategyParams>;
  train:BacktestResult;
  validation:BacktestResult;
  test:BacktestResult;
}
const GRID:Array<Partial<StrategyParams>>=[
  {minMomentumBps:4,maxSpreadBps:30,minImbalance:0},
  {minMomentumBps:8,maxSpreadBps:25,minImbalance:0.05},
  {minMomentumBps:12,maxSpreadBps:20,minImbalance:0.10},
  {minMomentumBps:16,maxSpreadBps:20,minImbalance:0.10}
];
export const DEFAULT_RESEARCH_V2_CONFIG:ResearchV2Config={
  maxCandidatesPerTimestamp:5,
  ranking:{momentumWeight:1,imbalanceWeight:20,spreadWeight:0.25},
  allowedMarkets:["SET","mai"],
  sessionTimeZone:"Asia/Bangkok"
};

function sessionDate(ts:string,tz:string){
  return new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts));
}
function groups(quotes:Quote[],tz:string){
  const map=new Map<string,Quote[]>();
  for(const q of quotes){
    const d=sessionDate(q.ts,tz);
    const arr=map.get(d)??[]; arr.push(q); map.set(d,arr);
  }
  return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}
function splitSessions(quotes:Quote[],tz:string){
  const sessions=groups(quotes,tz);
  const n=sessions.length, a=Math.max(1,Math.floor(n*.6)), b=Math.max(a+1,Math.floor(n*.8));
  const flat=(xs:[string,Quote[]][])=>xs.flatMap(x=>x[1]).sort((p,q)=>p.ts.localeCompare(q.ts)||p.symbol.localeCompare(q.symbol));
  return {train:flat(sessions.slice(0,a)),validation:flat(sessions.slice(a,b)),test:flat(sessions.slice(b))};
}
function candidateScore(signal:Signal,config:ResearchV2Config){
  const m=signal.reason.match(/momentum=([-\d.]+)bps/);
  const s=signal.reason.match(/spread=([-\d.]+)bps/);
  const i=signal.reason.match(/imbalance=([-\d.]+)/);
  if(!m||!s||!i) return Number.NEGATIVE_INFINITY;
  return Number(m[1])*config.ranking.momentumWeight+Number(i[1])*config.ranking.imbalanceWeight-Number(s[1])*config.ranking.spreadWeight;
}
function runCrossSectional(quotes:Quote[],initialCapital:number,params:Partial<StrategyParams>,config:ResearchV2Config):BacktestResult{
  const strategy=new StrategyV1(params);
  const state=createPortfolio(initialCapital);
  const trades:BacktestTrade[]=[]; const curve:BacktestEquityPoint[]=[];
  const filter=config.universeMemberships?.length ? createUniverseFilter(config.universeMemberships,config.allowedMarkets) : ()=>true;
  const sorted=quotes.filter(q=>filter(q.symbol,q.ts)).sort((a,b)=>a.ts.localeCompare(b.ts)||a.symbol.localeCompare(b.symbol));
  const sessions=groups(sorted,config.sessionTimeZone);

  for(const [,sessionQuotes] of sessions){
    const tsMap=new Map<string,Quote[]>();
    for(const q of sessionQuotes){const a=tsMap.get(q.ts)??[];a.push(q);tsMap.set(q.ts,a);}
    for(const [,batch] of [...tsMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
      for(const q of batch) mark(state,q);
      const sells:{q:Quote;signal:Signal}[]=[]; const buys:{q:Quote;signal:Signal;score:number}[]=[];
      for(const q of batch){
        const pos=state.positions[q.symbol];
        const signal=strategy.evaluate(q,{positionQty:pos?.qty??0,avgPrice:pos?.avgPrice??0,nowMs:Date.parse(q.ts)});
        if(signal.action==="SELL") sells.push({q,signal});
        else if(signal.action==="BUY") buys.push({q,signal,score:candidateScore(signal,config)});
      }
      for(const item of sells){
        const order=planOrder(item.signal,item.q,state);
        if(order.accepted) recordFill(state,order,trades,item.signal.reason,item.q.ts,item.signal.strategyVersion);
      }
      buys.sort((a,b)=>b.score-a.score||a.q.symbol.localeCompare(b.q.symbol));
      let chosen=0;
      for(const item of buys){
        if(chosen>=config.maxCandidatesPerTimestamp) break;
        const order=planOrder(item.signal,item.q,state);
        if(order.accepted){recordFill(state,order,trades,item.signal.reason,item.q.ts,item.signal.strategyVersion);chosen++;}
      }
      appendCurve(state,batch.at(-1)!.ts,curve);
    }
    forceCloseSession(state,trades,sessionQuotes.at(-1)!,strategy.version);
    appendCurve(state,sessionQuotes.at(-1)!.ts,curve);
  }

  const fp=snapshot(state), finalEquity=fp.cash+fp.market_value;
  return {
    strategyVersion:strategy.version,initialCapital,finalEquity,netPnl:finalEquity-initialCapital,
    returnPct:(finalEquity/initialCapital-1)*100,maxDrawdown:drawdown(curve),
    tradeCount:trades.length,winCount:trades.filter(t=>t.realizedPnl>0).length,
    lossCount:trades.filter(t=>t.realizedPnl<0).length,totalFees:fp.fees,totalSlippage:state.slippageCost,
    trades,equityCurve:curve,finalPortfolio:fp
  };
}
function recordFill(state:PortfolioState,order:Extract<ReturnType<typeof planOrder>,{accepted:true}>,trades:BacktestTrade[],reason:string,ts:string,version:string){
  const fill=simulateFill(order);
  const before=state.positions[order.symbol]?.realizedPnl??0;
  applyFill(state,fill);
  const after=state.positions[order.symbol]?.realizedPnl??before;
  trades.push({ts,symbol:fill.symbol,side:fill.side,qty:fill.qty,referencePrice:fill.referencePrice,fillPrice:fill.fillPrice,notional:fill.notional,fee:fill.fee,slippage:fill.slippage,realizedPnl:after-before,reason,strategyVersion:version});
}
function appendCurve(state:PortfolioState,ts:string,curve:BacktestEquityPoint[]){
  const s=snapshot(state);curve.push({ts,equity:s.cash+s.market_value,cash:s.cash,marketValue:s.market_value,grossExposure:s.gross_exposure,realizedPnl:s.realized_pnl,unrealizedPnl:s.unrealized_pnl,fees:s.fees});
}
function forceCloseSession(state:PortfolioState,trades:BacktestTrade[],fallback:Quote,version:string){
  for(const [symbol,pos] of Object.entries(state.positions)){
    if(pos.qty<=0) continue;
    const q=state.marks[symbol]??fallback;
    const signal:Signal={symbol,ts:q.ts,action:"SELL",reason:"END_OF_SESSION",strategyVersion:version};
    const order=planOrder(signal,q,state);
    if(order.accepted) recordFill(state,order,trades,"END_OF_SESSION",q.ts,version);
  }
}
function drawdown(curve:BacktestEquityPoint[]){
  let peak=-Infinity,max=0; for(const p of curve){peak=Math.max(peak,p.equity);max=Math.max(max,peak-p.equity);} return max;
}

export function runResearchV2(quotes:Quote[],initialCapital=1_000_000,config:ResearchV2Config=DEFAULT_RESEARCH_V2_CONFIG){
  const split=splitSessions(quotes,config.sessionTimeZone);
  const results=GRID.map((params,i)=>({
    variant:i+1,params,
    train:runCrossSectional(split.train,initialCapital,params,config),
    validation:runCrossSectional(split.validation,initialCapital,params,config),
    test:runCrossSectional(split.test,initialCapital,params,config)
  }));
  const selected=[...results].sort((a,b)=>b.validation.netPnl-a.validation.netPnl)[0]??null;
  return {results,selectedVariant:selected?.variant??null,splitSizes:{train:split.train.length,validation:split.validation.length,test:split.test.length}};
}
