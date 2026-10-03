import { createClient } from "../supabase/server";

export async function getLunaUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error) return null;
  return data.user ?? null;
}

export async function getLunaAccountAccess() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_luna_account_access");

  if (error || !data?.length) return null;

  return data[0] as {
    user_id: string;
    email: string | null;
    customer_id: string | null;
    plan_code: string;
    subscription_status: string;
    current_period_end: string | null;
  };
}
