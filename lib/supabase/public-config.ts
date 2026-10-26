/**
 * Public Supabase configuration for LUNA.
 *
 * NEXT_PUBLIC_* values from the deployment environment take precedence.
 * The fallback URL and sb_publishable_* key are public client configuration,
 * not server secrets. Never place a Supabase service-role key in this file.
 */
const DEFAULT_SUPABASE_URL = "https://wigzicwgcsrhdummrbjx.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7VStBEcxsvkQ7i_8NTuF9A_1vxiQRbD";

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL;

export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || DEFAULT_SUPABASE_PUBLISHABLE_KEY;
