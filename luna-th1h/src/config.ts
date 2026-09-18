const num=(name:string, fallback:number)=>Number(process.env[name] ?? fallback);
export const config={
  mode:process.env.LUNA_MODE ?? "paper",
  initialCapital:num("LUNA_INITIAL_CAPITAL",1_000_000),
  maxPositionPct:num("LUNA_MAX_POSITION_PCT",0.20),
  maxGrossExposurePct:num("LUNA_MAX_GROSS_EXPOSURE_PCT",1),
  timezone:process.env.LUNA_TIMEZONE ?? "Asia/Bangkok",
  marketDataProvider:process.env.MARKET_DATA_PROVIDER ?? "mock",
  supabaseUrl:process.env.SUPABASE_URL ?? "",
  supabaseKey:process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
};
