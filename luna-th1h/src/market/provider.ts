import type {Quote} from "../types.js";
import {mockQuotes} from "./mock.js";
import {setMarketplaceQuotes} from "./set-marketplace.js";

export function marketQuotes(provider:string):AsyncGenerator<Quote>{
  switch(provider){
    case "mock":
      return mockQuotes();
    case "set-marketplace":
      return setMarketplaceQuotes();
    default:
      throw new Error(`UNKNOWN_MARKET_DATA_PROVIDER: ${provider}`);
  }
}
