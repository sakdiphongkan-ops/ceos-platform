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
  maxPositionPct:num("LUNA_MAX_POSITION_PCT",0.075),
  maxGrossExposurePct:num("LUNA_MAX_GROSS_EXPOSURE_PCT",0.50),
  entryNotionalPct:num("LUNA_ENTRY_NOTIONAL_PCT",0.05)
  ,maxDailyLoss:num("LUNA_MAX_DAILY_LOSS",5_000)
  ,maxOrdersPerMinute:num("LUNA_MAX_ORDERS_PER_MINUTE",2),
  feeBps:num("LUNA_FEE_BPS",25),
  sellTaxBps:num("LUNA_SELL_TAX_BPS",10),
  slippageBps:num("LUNA_SLIPPAGE_BPS",5),
  marketImpactBps:num("LUNA_MARKET_IMPACT_BPS",8),
  liveReconciliation:bool("LUNA_LIVE_RECONCILIATION",false),
  liveReconciliationMs:num("LUNA_LIVE_RECONCILIATION_MS",5000),
  liveAccountCashDriftTolerance:num("LUNA_LIVE_ACCOUNT_CASH_DRIFT_TOLERANCE",25),
  liveAccountQtyDriftTolerance:num("LUNA_LIVE_ACCOUNT_QTY_DRIFT_TOLERANCE",0.5),
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
  maxQuoteAgeMs:num("LUNA_MAX_QUOTE_AGE_MS",2000),
  maxExecutionConcurrency:num("LUNA_MAX_EXECUTION_CONCURRENCY",4),
  maxAnalysisConcurrency:num("LUNA_MAX_ANALYSIS_CONCURRENCY",16),
  telemetryBatchSize:num("LUNA_TELEMETRY_BATCH_SIZE",50),
  telemetryFlushMs:num("LUNA_TELEMETRY_FLUSH_MS",50),
  telemetryTickBatchShare:num("LUNA_TELEMETRY_TICK_SHARE",0.25),
  holdTickPersistMs:num("LUNA_HOLD_TICK_PERSIST_MS",250),
  heartbeatMs:num("LUNA_HEARTBEAT_MS",5000),
  decisionLogMode:process.env.LUNA_DECISION_LOG_MODE ?? "signals",
  reduceOnlyTime:process.env.LUNA_REDUCE_ONLY_TIME ?? "16:20",
  forceCloseTime:process.env.LUNA_FORCE_CLOSE_TIME ?? "16:25",
  supabaseUrl:process.env.SUPABASE_URL ?? "",
  supabaseAnonKey:process.env.SUPABASE_ANON_KEY ?? "",
  supabaseFunctionUrl:process.env.SUPABASE_FUNCTION_URL ?? "",
  supabaseRequestTimeoutMs:num("LUNA_SUPABASE_REQUEST_TIMEOUT_MS",3000),
  lunaAgentKey:process.env.LUNA_AGENT_KEY ?? "",
};