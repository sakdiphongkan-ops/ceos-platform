import { createClient } from "../supabase/server";
import { createAdminClient } from "../supabase/admin";

export async function getLunaUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error) return null;
  return data.user ?? null;
}

export async function getLunaAccountAccess() {
  const user = await getLunaUser();
  if (!user) return null;

  const admin = createAdminClient();

  const { data: membership, error: membershipError } = await admin
    .from("luna_customer_memberships")
    .select("customer_id")
    .eq("user_id", user.id)
    .eq("status", "ACTIVE")
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (membershipError) return null;

  let planCode = "FREE";
  let subscriptionStatus = "ACTIVE";
  let currentPeriodEnd: string | null = null;

  if (membership?.customer_id) {
    const { data: subscription, error: subscriptionError } = await admin
      .from("luna_subscriptions")
      .select("plan_code,status,current_period_end")
      .eq("customer_id", membership.customer_id)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subscriptionError) return null;

    planCode = subscription?.plan_code ?? "FREE";
    subscriptionStatus = subscription?.status ?? "ACTIVE";
    currentPeriodEnd = subscription?.current_period_end ?? null;
  }

  return {
    user_id: user.id,
    email: user.email ?? null,
    customer_id: membership?.customer_id ?? null,
    plan_code: planCode,
    subscription_status: subscriptionStatus,
    current_period_end: currentPeriodEnd,
  };
}
