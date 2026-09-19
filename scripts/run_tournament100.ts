async function main(){
import { buildSeries, makeStrategies, fetchBars, runSignalStudy } from "../lib/tournament100-core";

const SYMBOLS = [
  "ADVANC","AOT","AWC","BANPU","BBL","BCP","BDMS","BEM","BH","BJC","CCET","COM7",
  "CPALL","CPF","CPN","CRC","DELTA","EGCO","GPSC","GULF","HMPRO","IVL","KBANK","KKP",
  "KTB","KTC","LH","MINT","MRDIYT","MTC","OR","OSP","PTT","PTTEP","PTTGC","RATCH",
  "SCB","SCC","SCGP","TCAP","TFG","THAI","TIDLOR","TISCO","TLI","TOP","TRUE","TTB",
  "TU","WHA"
];

const start = Math.floor(Date.parse("2026-09-09T17:00:00Z") / 1000);
const end = Math.floor(Date.parse("2026-09-19T00:00:00+07:00") / 1000);
const costBps = 2 * 5 + 25 + 10;

const data = new Map<string, any[]>();
const errors: string[] = [];

const results = await Promise.allSettled(
  SYMBOLS.map(async (symbol) => [symbol, await fetchBars(symbol, start, end)] as const)
);

results.forEach((r, i) => {
  if (r.status === "fulfilled") data.set(r.value[0], r.value[1]);
  else errors.push(SYMBOLS[i]);
});

const seriesMap = new Map<string, any>();
for (const [symbol, bars] of data) seriesMap.set(symbol, buildSeries(bars));

const strategies = makeStrategies();
const allResults = strategies
  .map((strategy) => ({
    ...runSignalStudy(strategy, data, seriesMap, costBps),
    id: strategy.id,
    family: strategy.family,
    name: strategy.name,
    source: strategy.source,
  }))
  .sort((a, b) => b.totalNetBps - a.totalNetBps);

const output = {
  generatedAt: new Date().toISOString(),
  status: "COMPLETED",
  testType: "100-STRATEGY-SIGNAL-STUDY",
  period: { start: "2026-09-10", end: "2026-09-18", sessions: 7 },
  data: {
    universe: "full",
    universeCount: SYMBOLS.length,
    symbolsReturned: data.size,
    symbolsFailed: errors.length,
    symbolsFailedList: errors,
    bars15m: Array.from(data.values()).reduce((n, a) => n + a.length, 0),
  },
  rules: {
    entry: "completed 15m close -> next 15m open",
    fixedHorizonBars: 4,
    costModelBps: costBps,
    lookahead: false,
    ranking: "total net bps after stated transaction costs",
  },
  strategiesTested: allResults.length,
  top20: allResults.slice(0, 20),
  bottom20: allResults.slice(-20),
  allResults,
};

console.log(JSON.stringify(output, null, 2));

}

main().catch((error)=>{ console.error(error); process.exit(1); });