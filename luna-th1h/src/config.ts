const num=(name:string, fallback:number)=>Number(process.env[name] ?? fallback);
const bool=(name:string, fallback:boolean)=>String(process.env[name] ?? fallback).toLowerCase()==="true";

const MARKET_TIMEZONE="Asia/Bangkok";
const requestedTimezone=process.env.LUNA_TIMEZONE ?? MARKET_TIMEZONE;
if(requestedTimezone!==MARKET_TIMEZONE){
  throw new Error(`LUNA_TIMEZONE_MUST_BE_${MARKET_TIMEZONE.replace("/","_").toUpperCase()}`);
}

export const config={
  mode:process.env.LUNA_MODE ?? "paper",
  initialCapital:num("LUNA_INITIAL_CAPITAL",1_000_000),
  maxPositionPct:num("LUNA_MAX_POSITION_PCT",1.00),
  maxGrossExposurePct:num("LUNA_MAX_GROSS_EXPOSURE_PCT",1),
  entryNotionalPct:num("LUNA_ENTRY_NOTIONAL_PCT",0.20),
  feeBps:num("LUNA_FEE_BPS",25),
  sellTaxBps:num("LUNA_SELL_TAX_BPS",10),
  slippageBps:num("LUNA_SLIPPAGE_BPS",5),
  marketImpactBps:num("LUNA_MARKET_IMPACT_BPS",8),
  liveReconciliation:bool("LUNA_LIVE_RECONCILIATION",false),
  liveReconciliationMs:num("LUNA_LIVE_RECONCILIATION_MS",5000),
  executionTest:bool("LUNA_EXECUTION_TEST",false),
  priceOnlyFallback:bool("LUNA_PRICE_ONLY_FALLBACK",false),
  executionMode:process.env.LUNA_EXECUTION_MODE ?? "paper",
  liveGatewayUrl:process.env.LUNA_LIVE_GATEWAY_URL ?? "",
  liveGatewayKey:process.env.LUNA_LIVE_GATEWAY_KEY ?? "",
  timezone:MARKET_TIMEZONE,
  marketDataProvider:process.env.MARKET_DATA_PROVIDER ?? "mock",
  marketDataGatewayUrl:process.env.LUNA_MARKET_GATEWAY_URL ?? "",
  marketDataGatewayKey:process.env.LUNA_MARKET_GATEWAY_KEY ?? "",
  marketDataGatewayPollMs:num("LUNA_MARKET_GATEWAY_POLL_MS",100),
  maxQuoteAgeMs:num("LUNA_MAX_QUOTE_AGE_MS",3000),
  reduceOnlyTime:process.env.LUNA_REDUCE_ONLY_TIME ?? "16:20",
  forceCloseTime:process.env.LUNA_FORCE_CLOSE_TIME ?? "16:25",
  supabaseUrl:process.env.SUPABASE_URL ?? "",
  supabaseAnonKey:process.env.SUPABASE_ANON_KEY ?? "",
  supabaseFunctionUrl:process.env.SUPABASE_FUNCTION_URL ?? "",
  lunaAgentKey:process.env.LUNA_AGENT_KEY ?? "",
};