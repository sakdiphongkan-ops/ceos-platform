import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./public-config";

export function createClient() {
  const url = SUPABASE_URL;
  const key = SUPABASE_PUBLISHABLE_KEY;

  return createBrowserClient(url, key);
}
