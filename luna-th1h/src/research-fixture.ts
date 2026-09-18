import type {Quote} from "./types.js";

export function makeFixture():Quote[]{
  const quotes:Quote[]=[];
  let ts=Date.parse("2026-09-18T02:00:00.000Z");
  const values=[
    100,100.05,100.08,100.02,100.01,100.04,100.06,100.07,100.05,100.04,
    100.06,100.09,100.12,100.18,100.25,100.34,100.45,100.60,100.78,100.95,
    101.10,101.25,101.40,101.55,101.72,101.86,101.94,102.02,102.10,102.18,
    102.15,102.08,101.98,101.88,101.75,101.60,101.45,101.30,101.12,100.95,
    100.78,100.60,100.45,100.30,100.18,100.10,100.04,99.98,99.92,99.88
  ];

  for(const last of values){
    quotes.push({
      symbol:"FIXTURE",
      ts:new Date(ts).toISOString(),
      bid:Number((last-0.01).toFixed(4)),
      ask:Number((last+0.01).toFixed(4)),
      last:Number(last.toFixed(4)),
      bidSize:5000,
      askSize:4000,
      source:"fixture"
    });
    ts+=15_000;
  }
  return quotes;
}
