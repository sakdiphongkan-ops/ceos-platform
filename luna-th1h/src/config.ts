const num=(name:string, fallback:number)=>Number(process.env[name] ?? fallback);
const bool=(name:string, fallback:boolean)=>String(process.env[name] ?? fallback).toLowerCase()==="true";

export const config={
  mode:process.env.LUNA_MODE ?? "paper",
  initialCapital:num("LUNA_INITIAL_CAPITAL",1_000_000),
  maxPositionPct:num("LUNA_MAX_POSITION_PCT",0.20),
  maxGrossExposurePct:num("LUNA_MAX_GROSS_EXPOSURE_PCT",1),
  entryNotionalPct:num("LUNA_ENTRY_NOTIONAL_PCT",0.20),
  feeBps:num("LUNA_FEE_BPS",25),
  sellTaxBps:num("LUNA_SELL_TAX_BPS",10),
  slippageBps:num("LUNA_SLIPPAGE_BPS",5),
  executionTest:bool("LUNA_EXECUTION_TEST",false),
  timezone:process.env.LUNA_TIMEZONE ?? "Asia/Bangkok",
  marketDataProvider:process.env.MARKET_DATA_PROVIDER ?? "mock",
  supabaseUrl:process.env.SUPABASE_URL ?? "",
  supabaseAnonKey:process.env.SUPABASE_ANON_KEY ?? "",
  supabaseFunctionUrl:process.env.SUPABASE_FUNCTION_URL ?? "",
  lunaAgentKey:process.env.LUNA_AGENT_KEY ?? "",
};