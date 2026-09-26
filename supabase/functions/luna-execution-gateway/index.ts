import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(req: Request) {
  const token = req.headers.get("x-luna-agent");
  if (!token) return false;
  const hash = await sha256(token);
  const { data, error } = await supabase
    .from("private.luna_agent_credentials")
    .select("credential_id")
    .eq("sha256_hash", hash)
    .eq("enabled", true)
    .eq("credential_scope", "execution")
    .limit(1);
  return !error && !!data?.length;
}

const requiredAdmission = [
  "session_id",
  "strategy_version",
  "mode",
  "symbol",
  "side",
  "qty",
  "client_order_id",
  "idempotency_key",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ ok: false, error: "POST_REQUIRED" }, 405);
  if (!(await authorized(req))) return json({ ok: false, error: "UNAUTHORIZED" }, 401);

  try {
    const body = await req.json();
    const action = String(body?.action ?? "admit").toLowerCase();

    if (action === "admit") {
      for (const key of requiredAdmission) {
        if (body?.[key] === undefined || body?.[key] === null || body?.[key] === "") {
          return json({ ok: false, error: "INVALID_REQUEST", missing: key }, 400);
        }
      }

      const { data, error } = await supabase.rpc("luna_execution_admit_request", {
        p_session_id: String(body.session_id),
        p_strategy_version: String(body.strategy_version),
        p_mode: String(body.mode).toLowerCase(),
        p_symbol: String(body.symbol).toUpperCase(),
        p_side: String(body.side).toUpperCase(),
        p_qty: Number(body.qty),
        p_limit_price: body.limit_price == null ? null : Number(body.limit_price),
        p_client_order_id: String(body.client_order_id),
        p_idempotency_key: String(body.idempotency_key),
        p_request_source: "luna-execution-gateway",
      });

      if (error) return json({ ok: false, error: "EXECUTION_GATE_ERROR", detail: error.message }, 500);
      const result = data ?? { admitted: false, reason: "EMPTY_GATE_RESPONSE" };
      const status = result.admitted === true ? 200 : result.decision === "DUPLICATE" ? 409 : 423;
      return json({ ok: true, ...result }, status);
    }

    if (action === "mark_submitted") {
      const requestId = String(body?.request_id ?? "");
      const brokerOrderId = String(body?.broker_order_id ?? "");
      if (!requestId || !brokerOrderId) return json({ ok: false, error: "INVALID_MARK_SUBMITTED" }, 400);

      const { data, error } = await supabase
        .from("luna_execution_requests")
        .update({
          executed: true,
          broker_order_id: brokerOrderId,
          metadata: {
            ack_kind: body?.ack_kind ?? null,
            broker_native_submitted_at_ms: body?.broker_native_submitted_at_ms ?? null,
            marked_at: new Date().toISOString(),
          },
        })
        .eq("request_id", requestId)
        .eq("decision", "ADMITTED")
        .select("request_id,client_order_id,decision,executed,broker_order_id")
        .limit(1)
        .maybeSingle();

      if (error) return json({ ok: false, error: "MARK_SUBMITTED_FAILED", detail: error.message }, 500);
      if (!data) return json({ ok: false, error: "REQUEST_NOT_ADMITTED_OR_ALREADY_UPDATED" }, 409);
      return json({ ok: true, ...data });
    }

    if (action === "mark_denied") {
      const requestId = String(body?.request_id ?? "");
      const reason = String(body?.reason ?? "BROKER_REJECTED");
      if (!requestId) return json({ ok: false, error: "INVALID_MARK_DENIED" }, 400);

      const { data, error } = await supabase
        .from("luna_execution_requests")
        .update({
          executed: false,
          decision: "DENIED",
          decision_reason: reason,
          metadata: { marked_at: new Date().toISOString() },
        })
        .eq("request_id", requestId)
        .eq("decision", "ADMITTED")
        .select("request_id,client_order_id,decision,executed,broker_order_id")
        .limit(1)
        .maybeSingle();

      if (error) return json({ ok: false, error: "MARK_DENIED_FAILED", detail: error.message }, 500);
      if (!data) return json({ ok: false, error: "REQUEST_NOT_ADMITTED_OR_ALREADY_UPDATED" }, 409);
      return json({ ok: true, ...data });
    }

    if (action === "lookup") {
      const requestId = body?.request_id ? String(body.request_id) : "";
      const clientOrderId = body?.client_order_id ? String(body.client_order_id) : "";
      const brokerOrderId = body?.broker_order_id ? String(body.broker_order_id) : "";
      if (!requestId && !clientOrderId && !brokerOrderId) {
        return json({ ok: false, error: "INVALID_LOOKUP" }, 400);
      }

      let query = supabase
        .from("luna_execution_requests")
        .select("request_id,session_id,strategy_version,mode,symbol,side,qty,limit_price,client_order_id,idempotency_key,decision,decision_reason,executed,broker_order_id,created_by,metadata,received_at")
        .limit(1);

      if (requestId) query = query.eq("request_id", requestId);
      else if (clientOrderId) query = query.eq("client_order_id", clientOrderId);
      else query = query.eq("broker_order_id", brokerOrderId);

      const { data, error } = await query.maybeSingle();
      if (error) return json({ ok: false, error: "LOOKUP_FAILED", detail: error.message }, 500);
      if (!data) return json({ ok: false, error: "NOT_FOUND" }, 404);
      return json({ ok: true, request: data });
    }

    return json({ ok: false, error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
