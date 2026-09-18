import type {Quote} from "../types.js";

export async function* mockQuotes():AsyncGenerator<Quote>{
  let step=0;
  while(true){
    const now=new Date().toISOString();
    yield {symbol:"__HEALTH__",ts:now,bid:null,ask:null,last:null,bidSize:null,askSize:null,source:"mock"};

    if(process.env.LUNA_EXECUTION_TEST==="true"){
      const mid=100+(step*0.15);
      yield {
        symbol:"__LUNA_TEST__",
        ts:new Date().toISOString(),
        bid:Number((mid-0.05).toFixed(4)),
        ask:Number((mid+0.05).toFixed(4)),
        last:Number(mid.toFixed(4)),
        bidSize:5000,
        askSize:5000,
        source:"mock-test"
      };
      step++;
    }

    await new Promise(r=>setTimeout(r,5000));
  }
}