const num=(name:string, fallback:number)=>Number(process.env[name] ?? fallback);
const bool=(name:string, fallback:boolean)=>String(process.env[name] ?? fallback).toLowerCase()==="true";

export const config={
  mode:process.env.LUNA_MODE ?? "paper",
  initialCapital:num("LUNA_INITIAL_CAPITAL",1_000_000),
  maxPositionPct:num("LUNA_MAX_POSITION_PCT",1.00),
  maxGrossExposurePct:num("LUNA_MAX_GROSS_EXPOSURE_PCT",1),
  entryNotionalPct:num("LUNA_ENTRY_NOTIONAL_PCT",0.20),
  feeBps:num("LUNA_FEE_BPS",25),
  sellTaxBps:num("LUNA_SELL_TAX_BPS",10),
  slippageBps:num("LUNA_SLIPPAGE_BPS",5),
  executionTest:bool("LUNA_EXECUTION_TEST",false),
  priceOnlyFallback:bool("LUNA_PRICE_ONLY_FALLBACK",false),
  executionMode:process.env.LUNA_EXECUTION_MODE ?? "paper",
  liveGatewayUrl:process.env.LUNA_LIVE_GATEWAY_URL ?? "",
  liveGatewayKey:process.env.LUNA_LIVE_GATEWAY_KEY ?? "",
  timezone:process.env.LUNA_TIMEZONE ?? "Asia/Bangkok",
  marketDataProvider:process.env.MARKET_DATA_PROVIDER ?? "mock",
  marketDataGatewayUrl:process.env.LUNA_MARKET_GATEWAY_URL ?? "",
  marketDataGatewayKey:process.env.LUNA_MARKET_GATEWAY_KEY ?? "",
  marketDataGatewayPollMs:num("LUNA_MARKET_GATEWAY_POLL_MS",250),
  reduceOnlyTime:process.env.LUNA_REDUCE_ONLY_TIME ?? "16:20",
  forceCloseTime:process.env.LUNA_FORCE_CLOSE_TIME ?? "16:25",
  supabaseUrl:process.env.SUPABASE_URL ?? "",
  supabaseAnonKey:process.env.SUPABASE_ANON_KEY ?? "",
  supabaseFunctionUrl:process.env.SUPABASE_FUNCTION_URL ?? "",
  lunaAgentKey:process.env.LUNA_AGENT_KEY ?? "",
};