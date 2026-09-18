import {config} from "./config.js";
import {mockQuotes} from "./market/mock.js";
import {evaluate} from "./strategy.js";

async function main(){
  console.log(JSON.stringify({event:"LUNA_BOOT",mode:config.mode,provider:config.marketDataProvider,capital:config.initialCapital}));
  if(config.marketDataProvider!=="mock"){
    throw new Error("Market-data adapter not installed. Keep MARKET_DATA_PROVIDER=mock until an authorized provider is configured.");
  }
  for await(const q of mockQuotes()){
    const signal=evaluate(q);
    console.log(JSON.stringify({event:"SIGNAL",quote:q,signal}));
  }
}
main().catch(err=>{console.error(err);process.exit(1)});
