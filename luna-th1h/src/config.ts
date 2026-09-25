// LUNA_SOURCE_REFRESH_2026_09_22
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
  entryNotionalPct:num("LUNA_ENTRY_NOTIONAL_PCT",0.05),
  maxDailyLoss:num("LUNA_MAX_DAILY_LOSS",5_000),
  maxDailyTurnover:num("LUNA_MAX_DAILY_TURNOVER",2_000_000),
  maxOrderNotional:num("LUNA_MAX_ORDER_NOTIONAL",50_000),
  maxOrdersPerMinute:num("LUNA_MAX_ORDERS_PER_MINUTE",2),
  feeBps:num("LUNA_FEE_BPS",25),
  sellTaxBps:num("LUNA_SELL_TAX_BPS",10),
  slippageBps:num("LUNA_SLIPPAGE_BPS",5),
  marketImpactBps:num("LUNA_MARKET_IMPACT_BPS",8),
  liveReconciliation:bool("LUNA_LIVE_RECONCILIATION",false),
  liveReconciliationMs:num("LUNA_LIVE_RECONCILIATION_MS",5000),
  liveOrderGateEnabled:bool("LUNA_LIVE_ORDER_GATE_ENABLED",false),
  liveSafetyGatewayFailureTripCount:num("LUNA_LIVE_SAFETY_GATEWAY_FAILURE_TRIP_COUNT",3),
  liveSafetyMaxQuoteDeviationBps:num("LUNA_LIVE_SAFETY_MAX_QUOTE_DEVIATION_BPS",75),
  liveSafetyMaxClockSkewMs:num("LUNA_LIVE_SAFETY_MAX_CLOCK_SKEW_MS",1500),
  liveAccountCashDriftTolerance:num("LUNA_LIVE_ACCOUNT_CASH_DRIFT_TOLERANCE",25),
  liveAccountQtyDriftTolerance:num("LUNA_LIVE_ACCOUNT_QTY_DRIFT_TOLERANCE",0.5),
  executionTest:bool("LUNA_EXECUTION_TEST",false),
  observeOnly:bool("LUNA_OBSERVE_ONLY",true),
  prewarmEnabled:bool("LUNA_PREWARM_ENABLED",true),
  priceOnlyFallback:bool("LUNA_PRICE_ONLY_FALLBACK",false),
  m1OverlayMode:(process.env.LUNA_M1_OVERLAY_MODE ?? "shadow") as "off"|"shadow"|"enforce",
  m1OverlayStrategyVersion:process.env.LUNA_M1_OVERLAY_STRATEGY_VERSION ?? "luna-m1-orthogonal-sizer-l2-v1",
  m1OverlayRefreshMs:num("LUNA_M1_OVERLAY_REFRESH_MS",60*60_000),
  executionMode:process.env.LUNA_EXECUTION_MODE ?? "paper",
  liveGatewayUrl:process.env.LUNA_LIVE_GATEWAY_URL ?? "",
  liveGatewayKey:process.env.LUNA_LIVE_GATEWAY_KEY ?? "",
  timezone:MARKET_TIMEZONE,
  // Fail closed to the real gateway when no provider is explicitly configured.
  // Mock data must be opt-in via MARKET_DATA_PROVIDER=mock.
  marketDataProvider:process.env.MARKET_DATA_PROVIDER ?? "settrade-gateway",
  marketDataGatewayUrl:process.env.LUNA_MARKET_GATEWAY_URL ?? "",
  marketDataGatewayKey:process.env.LUNA_MARKET_GATEWAY_KEY ?? "",
  marketDataGatewayPollMs:num("LUNA_MARKET_GATEWAY_POLL_MS",100),
  maxQuoteAgeMs:num("LUNA_MAX_QUOTE_AGE_MS",2000),
  maxExecutionConcurrency:num("LUNA_MAX_EXECUTION_CONCURRENCY",4),
  maxAnalysisConcurrency:num("LUNA_MAX_ANALYSIS_CONCURRENCY",32),
  telemetryBatchSize:num("LUNA_TELEMETRY_BATCH_SIZE",100),
  telemetryFlushMs:num("LUNA_TELEMETRY_FLUSH_MS",2000),
  telemetryTickBatchShare:num("LUNA_TELEMETRY_TICK_SHARE",0.90),
  holdTickPersistMs:num("LUNA_HOLD_TICK_PERSIST_MS",20000),
  heartbeatMs:num("LUNA_HEARTBEAT_MS",5000),
  decisionLogMode:process.env.LUNA_DECISION_LOG_MODE ?? "signals",
  reduceOnlyTime:process.env.LUNA_REDUCE_ONLY_TIME ?? "16:20",
  forceCloseTime:process.env.LUNA_FORCE_CLOSE_TIME ?? "16:25",
  supabaseUrl:process.env.SUPABASE_URL ?? "",
  supabaseAnonKey:process.env.SUPABASE_ANON_KEY ?? "",
  supabaseFunctionUrl:process.env.SUPABASE_FUNCTION_URL ?? "",
  supabaseRequestTimeoutMs:num("LUNA_SUPABASE_REQUEST_TIMEOUT_MS",5000),
  lunaAgentKey:process.env.LUNA_AGENT_KEY ?? "",
};