import type {Quote} from "../types.js";
export async function* mockQuotes():AsyncGenerator<Quote>{
  while(true){
    yield {symbol:"__HEALTH__",ts:new Date().toISOString(),bid:null,ask:null,last:null,bidSize:null,askSize:null,source:"mock"};
    await new Promise(r=>setTimeout(r,5000));
  }
}
