import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildPlanJsonSchema,
  normalizeTaskPlan,
  type PlannedWorkItem,
} from "./plan_helpers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS["default"] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL_NAME = Deno.env.get("LUNA_AGENT_MODEL") ?? "";
const RESPONSES_URL = Deno.env.get("LUNA_AGENT_RESPONSES_URL") ?? "https://api.openai.com/v1/responses";
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Access-Control-Allow-Origin": "https://luna.floot.app",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-luna-agent",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Origin",
};

type AgentRow = {
  agent_key: string;
  display_name: string;
  department: string;
  role_description: string;
  system_prompt: string;
  capabilities: string[];
  allowed_actions: string[];
  enabled: boolean;
  health_status: string;
  model_provider: string;
  model_name: string | null;
  last_heartbeat_at: string | null;
  prompt_version: string;
  requires_human_gate: boolean;
};

type ModelReply = { text: string; responseId: string | null; inputTokens: number | null; outputTokens: number | null };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function appError(code: string, status = 400): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status });
}

function safeString(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorize(req: Request): Promise<{ ok: true; credentialHash: string } | { ok: false; code: string; status: number }> {
  const token = req.headers.get("x-luna-agent") ?? "";
  if (!token) return { ok: false, code: "UNAUTHORIZED", status: 401 };

  const hash = await sha256(token);
  const verified = await db.rpc("luna_verify_agent", { p_sha256_hash: hash });
  if (verified.error) return { ok: false, code: "AGENT_AUTH_CHECK_UNAVAILABLE", status: 503 };
  if (verified.data !== true) return { ok: false, code: "UNAUTHORIZED", status: 401 };

  const rate = await db.rpc("luna_security_rate_limit", {
    p_bucket_key: "ceo-agent:" + hash,
    p_limit: 20,
    p_window_seconds: 60,
  });
  if (rate.error) return { ok: false, code: "SECURITY_RATE_LIMIT_UNAVAILABLE", status: 503 };
  if (rate.data?.allowed === false) return { ok: false, code: "SECURITY_RATE_LIMITED", status: 429 };
  return { ok: true, credentialHash: hash };
}

function providerReady() {
  return Boolean(MODEL_API_KEY.trim() && MODEL_NAME.trim());
}

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const parts: string[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function callModel(instructions: string, input: string, schemaName?: string, schema?: Record<string, unknown>): Promise<ModelReply> {
  if (!providerReady()) throw appError("MODEL_PROVIDER_NOT_CONFIGURED", 503);
  const body: Record<string, unknown> = {
    model: MODEL_NAME.trim(),
    store: false,
    max_output_tokens: 3500,
    instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
    text: schema && schemaName
      ? { format: { type: "json_schema", name: schemaName, strict: true, schema } }
      : { format: { type: "text" } },
  };

  let response: Response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + MODEL_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw appError("MODEL_PROVIDER_UNREACHABLE", 503);
  }
  if (!response.ok) {
    // Never pass provider response bodies into user-facing errors; they may contain sensitive metadata.
    throw appError("MODEL_PROVIDER_HTTP_" + response.status, response.status === 429 ? 429 : 503);
  }

  const payload = await response.json();
  const text = extractOutputText(payload);
  if (!text) throw appError("MODEL_PROVIDER_EMPTY_OUTPUT", 502);
  return {
    text,
    responseId: typeof payload?.id === "string" ? payload.id : null,
    inputTokens: Number.isFinite(payload?.usage?.input_tokens) ? Number(payload.usage.input_tokens) : null,
    outputTokens: Number.isFinite(payload?.usage?.output_tokens) ? Number(payload.usage.output_tokens) : null,
  };
}

function parseModelJson<T>(reply: ModelReply): T {
  try {
    return JSON.parse(reply.text) as T;
  } catch {
    throw appError("MODEL_OUTPUT_INVALID_JSON", 502);
  }
}

async function getAgents(): Promise<AgentRow[]> {
  const result = await db.from("luna_erp_agents")
    .select("agent_key,display_name,department,role_description,system_prompt,capabilities,allowed_actions,enabled,health_status,model_provider,model_name,last_heartbeat_at,prompt_version,requires_human_gate")
    .order("department", { ascending: true })
    .order("agent_key", { ascending: true });
  if (result.error) throw appError("AGENT_REGISTRY_QUERY_FAILED", 500);
  return (result.data ?? []) as AgentRow[];
}

async function verifyProvider() {
  const reply = await callModel(
    "You are performing a connectivity test. Reply with exactly the word READY and nothing else.",
    "Return READY.",
  );
  if (reply.text.trim().toUpperCase() !== "READY") throw appError("MODEL_PROVIDER_SMOKE_TEST_FAILED", 502);

  const updated = await db.from("luna_erp_agents")
    .update({
      health_status: "HEALTHY",
      last_heartbeat_at: new Date().toISOString(),
      model_provider: "OPENAI_RESPONSES_API",
      model_name: MODEL_NAME.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("enabled", true);
  if (updated.error) throw appError("AGENT_HEALTH_UPDATE_FAILED", 500);

  return { ok: true, provider: "OPENAI_RESPONSES_API", model: MODEL_NAME.trim(), roles_marked_healthy: true };
}

function healthSummary(agents: AgentRow[]) {
  const enabled = agents.filter((a) => a.enabled);
  const healthy = enabled.filter((a) => a.health_status === "HEALTHY");
  const CEO = agents.find((a) => a.agent_key === "ceo_orchestrator");
  const specialists = healthy.filter((a) => a.agent_key !== "ceo_orchestrator");
  const latestHeartbeat = healthy.map((a) => a.last_heartbeat_at).filter(Boolean).sort().at(-1) ?? null;
  const blockers: string[] = [];
  if (!providerReady()) blockers.push("MODEL_PROVIDER_NOT_CONFIGURED");
  if (!CEO || !CEO.enabled || CEO.health_status !== "HEALTHY") blockers.push("CEO_AGENT_NOT_HEALTHY");
  if (specialists.length === 0) blockers.push("NO_HEALTHY_SPECIALIST_AGENTS");
  return {
    status: blockers.length ? "BLOCKED" : "READY_FOR_AGENT_WORK",
    provider_configured: providerReady(),
    model: providerReady() ? MODEL_NAME.trim() : null,
    total_roles: agents.length,
    enabled_roles: enabled.length,
    healthy_roles: healthy.length,
    healthy_specialists: specialists.length,
    latest_heartbeat_at: latestHeartbeat,
    blockers,
    roles: agents.map((a) => ({
      agent_key: a.agent_key,
      display_name: a.display_name,
      department: a.department,
      enabled: a.enabled,
      health_status: a.health_status,
      model_provider: a.model_provider,
      model_name: a.model_name,
      last_heartbeat_at: a.last_heartbeat_at,
      prompt_version: a.prompt_version,
    })),
  };
}

function deliverableSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary","deliverable_markdown","facts","assumptions","risks","evidence_needed","next_actions","confidence","external_actions_performed"],
    properties: {
      summary: { type: "string" },
      deliverable_markdown: { type: "string" },
      facts: { type: "array", items: { type: "string" }, maxItems: 12 },
      assumptions: { type: "array", items: { type: "string" }, maxItems: 12 },
      risks: { type: "array", items: { type: "string" }, maxItems: 12 },
      evidence_needed: { type: "array", items: { type: "string" }, maxItems: 12 },
      next_actions: { type: "array", items: { type: "string" }, maxItems: 12 },
      confidence: { type: "string", enum: ["LOW","MEDIUM","HIGH"] },
      external_actions_performed: { type: "array", items: { type: "string" }, maxItems: 0 },
    },
  };
}

function summarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary","completed_items","pending_items","blockers","decision_needed","recommended_next_step"],
    properties: {
      summary: { type: "string" },
      completed_items: { type: "array", items: { type: "string" }, maxItems: 8 },
      pending_items: { type: "array", items: { type: "string" }, maxItems: 8 },
      blockers: { type: "array", items: { type: "string" }, maxItems: 8 },
      decision_needed: { type: "array", items: { type: "string" }, maxItems: 8 },
      recommended_next_step: { type: "string" },
    },
  };
}

async function executeWorkOrder(agent: AgentRow, row: Record<string, any>) {
  const runStart = new Date().toISOString();
  const { data: run, error: runInsertError } = await db.from("luna_erp_agent_runs")
    .insert({
      work_order_id: row.id,
      agent_key: agent.agent_key,
      trace_id: row.trace_id,
      status: "RUNNING",
      model_provider: "OPENAI_RESPONSES_API",
      model_name: MODEL_NAME.trim(),
      prompt_version: agent.prompt_version,
      input: {
        work_order_id: row.id,
        title: row.title,
        description: row.description,
        task_payload: row.task_payload ?? {},
        acceptance_criteria: row.acceptance_criteria ?? [],
      },
      started_at: runStart,
    })
    .select("id")
    .single();
  if (runInsertError) {
    await db.from("luna_erp_work_orders").update({
      status: "FAILED",
      last_error_code: "AGENT_RUN_RECORD_CREATE_FAILED",
      blocker_detail: null,
      ended_at: new Date().toISOString(),
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return { work_order_id: row.id, agent_key: agent.agent_key, status: "FAILED", error_code: "AGENT_RUN_RECORD_CREATE_FAILED" };
  }

  try {
    const instructions = [
      agent.system_prompt,
      "",
      "Runtime boundary: you have no external browser, shell, repository, database-write, secret, deployment, or trading tools in this execution. You may produce analysis, draft code, review notes, plans and other text deliverables. Never claim to have changed an external system, run a test, read a source not provided, or performed an action. Put missing external evidence under evidence_needed. external_actions_performed must be an empty array.",
      "All outputs are proposals until independently validated. Keep real-money trading disabled.",
    ].join("\n");
    const reply = await callModel(
      instructions,
      JSON.stringify({
        title: row.title,
        description: row.description,
        task_payload: row.task_payload ?? {},
        acceptance_criteria: row.acceptance_criteria ?? [],
        risk_level: row.risk_level,
        paper_only: row.paper_only,
      }),
      "agent_deliverable",
      deliverableSchema(),
    );
    const output = parseModelJson<Record<string, unknown>>(reply);
    if (output.external_actions_performed && (!Array.isArray(output.external_actions_performed) || output.external_actions_performed.length !== 0)) {
      throw appError("AGENT_CLAIMED_EXTERNAL_ACTION", 502);
    }

    const completedAt = new Date().toISOString();
    const updateOrder = await db.from("luna_erp_work_orders").update({
      status: "VALIDATION",
      result_summary: safeString(output.summary, 2000),
      output,
      evidence: Array.isArray(output.facts) ? output.facts : [],
      last_error_code: null,
      ended_at: completedAt,
      lease_expires_at: null,
      updated_at: completedAt,
    }).eq("id", row.id).eq("status", "RUNNING");
    if (updateOrder.error) throw appError("WORK_ORDER_SAVE_FAILED", 500);

    const updateRun = await db.from("luna_erp_agent_runs").update({
      status: "COMPLETED",
      output,
      provider_response_id: reply.responseId,
      input_tokens: reply.inputTokens,
      output_tokens: reply.outputTokens,
      completed_at: completedAt,
    }).eq("id", run.id);
    if (updateRun.error) throw appError("AGENT_RUN_SAVE_FAILED", 500);

    await db.from("luna_erp_agents").update({
      last_heartbeat_at: completedAt,
      updated_at: completedAt,
      health_status: "HEALTHY",
    }).eq("agent_key", agent.agent_key);

    return { work_order_id: row.id, agent_key: agent.agent_key, status: "VALIDATION", summary: safeString(output.summary, 1000) };
  } catch (error) {
    const code = (error as any)?.code && typeof (error as any).code === "string" ? (error as any).code : "MODEL_RUN_FAILED";
    const completedAt = new Date().toISOString();
    await db.from("luna_erp_work_orders").update({
      status: "FAILED",
      last_error_code: code.slice(0, 120),
      ended_at: completedAt,
      lease_expires_at: null,
      updated_at: completedAt,
    }).eq("id", row.id).eq("status", "RUNNING");
    await db.from("luna_erp_agent_runs").update({
      status: "FAILED",
      error_code: code.slice(0, 120),
      completed_at: completedAt,
    }).eq("id", run.id);
    return { work_order_id: row.id, agent_key: agent.agent_key, status: "FAILED", error_code: code };
  }
}

async function runBatch(parentId: string, requestedMax: number): Promise<Array<Record<string, unknown>>> {
  const max = Math.min(Math.max(Math.floor(requestedMax || 1), 1), 5);
  const agents = (await getAgents()).filter((a) =>
    a.agent_key !== "ceo_orchestrator" && a.enabled && a.health_status === "HEALTHY" && Boolean(a.system_prompt)
  );
  const results: Array<Record<string, unknown>> = [];
  let idlePasses = 0;

  while (results.length < max && idlePasses < agents.length) {
    let claimedAny = false;
    for (const agent of agents) {
      if (results.length >= max) break;
      const claim = await db.rpc("luna_erp_claim_next_work_order", {
        p_agent_key: agent.agent_key,
        p_parent_work_order_id: parentId,
        p_lease_seconds: 120,
      });
      if (claim.error) throw appError("WORK_ORDER_CLAIM_FAILED", 500);
      const rows = Array.isArray(claim.data) ? claim.data : claim.data ? [claim.data] : [];
      const row = rows[0];
      if (!row) continue;
      claimedAny = true;
      results.push(await executeWorkOrder(agent, row));
    }
    idlePasses = claimedAny ? 0 : idlePasses + 1;
  }
  return results;
}

async function updateParentStatus(parentId: string) {
  const parentResult = await db.from("luna_erp_work_orders")
    .select("id,status,requires_human_gate,trace_id,output,task_payload")
    .eq("id", parentId)
    .maybeSingle();
  if (parentResult.error || !parentResult.data) throw appError("PARENT_WORK_ORDER_NOT_FOUND", 404);
  const parent = parentResult.data as any;
  const childResult = await db.from("luna_erp_work_orders")
    .select("id,title,owner_agent_key,status,requires_human_gate,blocker_code,last_error_code,result_summary,output")
    .eq("parent_work_order_id", parentId)
    .order("created_at", { ascending: true });
  if (childResult.error) throw appError("CHILD_WORK_ORDER_LOOKUP_FAILED", 500);
  const children = childResult.data ?? [];

  const approvalResult = await db.from("luna_erp_approvals")
    .select("id,status,gate_type")
    .eq("work_order_id", parentId)
    .eq("status", "PENDING");
  if (approvalResult.error) throw appError("APPROVAL_LOOKUP_FAILED", 500);
  const pendingParentApprovals = approvalResult.data ?? [];

  if (parent.requires_human_gate || pendingParentApprovals.length) {
    await db.from("luna_erp_work_orders").update({
      status: "BLOCKED",
      blocker_code: "HUMAN_APPROVAL_REQUIRED",
      blocker_detail: "This work requires a recorded human approval before it can proceed.",
      updated_at: new Date().toISOString(),
    }).eq("id", parentId);
    return { parent_work_order_id: parentId, status: "BLOCKED", children, blockers: ["HUMAN_APPROVAL_REQUIRED"] };
  }

  const unfinished = children.filter((c: any) => !["VALIDATION", "COMPLETED"].includes(c.status));
  if (unfinished.length) {
    const hasGate = unfinished.some((c: any) => c.status === "BLOCKED" || c.requires_human_gate);
    const status = hasGate ? "BLOCKED" : "RUNNING";
    await db.from("luna_erp_work_orders").update({
      status,
      blocker_code: hasGate ? "CHILD_OR_APPROVAL_BLOCKER" : null,
      blocker_detail: hasGate ? "One or more child work orders require human approval or are blocked." : null,
      updated_at: new Date().toISOString(),
    }).eq("id", parentId);
    return {
      parent_work_order_id: parentId,
      status,
      children: children.map((c: any) => ({ id: c.id, title: c.title, agent_key: c.owner_agent_key, status: c.status })),
      blockers: unfinished.map((c: any) => ({ id: c.id, status: c.status, blocker_code: c.blocker_code ?? c.last_error_code })),
    };
  }

  const CEO = (await getAgents()).find((a) => a.agent_key === "ceo_orchestrator" && a.enabled && a.health_status === "HEALTHY");
  if (!CEO) throw appError("CEO_AGENT_NOT_HEALTHY", 409);

  const outputContext = children.map((c: any) => ({
    work_order_id: c.id,
    title: c.title,
    agent_key: c.owner_agent_key,
    status: c.status,
    result_summary: c.result_summary,
    output: c.output,
  }));
  const reply = await callModel(
    CEO.system_prompt + "\nYou are producing a truthful executive synthesis of recorded sub-agent outputs. Do not infer that any external change was performed. Mark generated drafts as pending independent validation. Never waive human gates.",
    JSON.stringify({ parent_work_order_id: parentId, children: outputContext }),
    "ceo_task_summary",
    summarySchema(),
  );
  const summary = parseModelJson<Record<string, unknown>>(reply);
  const completedAt = new Date().toISOString();
  const parentOutput = {
    ...(isObject(parent.output) ? parent.output : {}),
    ...summary,
    children: outputContext.map((c) => ({ work_order_id: c.work_order_id, agent_key: c.agent_key, status: c.status })),
    synthesized_by: "ceo_orchestrator",
    provider_response_id: reply.responseId,
    validation_required: true,
  };
  const update = await db.from("luna_erp_work_orders").update({
    status: "VALIDATION",
    result_summary: safeString(summary.summary, 2000),
    output: parentOutput,
    blocker_code: null,
    blocker_detail: null,
    ended_at: completedAt,
    updated_at: completedAt,
  }).eq("id", parentId);
  if (update.error) throw appError("CEO_SUMMARY_SAVE_FAILED", 500);

  await db.from("luna_erp_agent_runs").insert({
    work_order_id: parentId,
    agent_key: "ceo_orchestrator",
    trace_id: parent.trace_id ?? crypto.randomUUID(),
    status: "COMPLETED",
    model_provider: "OPENAI_RESPONSES_API",
    model_name: MODEL_NAME.trim(),
    prompt_version: CEO.prompt_version,
    input: { parent_work_order_id: parentId, child_count: children.length },
    output: summary,
    provider_response_id: reply.responseId,
    input_tokens: reply.inputTokens,
    output_tokens: reply.outputTokens,
    started_at: new Date().toISOString(),
    completed_at: completedAt,
  });

  return { parent_work_order_id: parentId, status: "VALIDATION", summary, children: outputContext };
}

async function loadTaskTree(parentId: string) {
  const parent = await db.from("luna_erp_work_orders")
    .select("id,idempotency_key,title,description,status,priority,owner_agent_key,trace_id,requires_human_gate,task_payload,result_summary,output,created_at,updated_at")
    .eq("id", parentId).maybeSingle();
  if (parent.error || !parent.data) throw appError("PARENT_WORK_ORDER_NOT_FOUND", 404);
  const children = await db.from("luna_erp_work_orders")
    .select("id,title,owner_agent_key,status,priority,dependency_ids,acceptance_criteria,blocker_code,blocker_detail,last_error_code,result_summary,output,created_at,updated_at")
    .eq("parent_work_order_id", parentId)
    .order("created_at", { ascending: true });
  if (children.error) throw appError("CHILD_WORK_ORDER_LOOKUP_FAILED", 500);
  return { parent: parent.data, children: children.data ?? [] };
}

async function dispatchTask(body: Record<string, any>) {
  const task = safeString(body.task, 10000);
  if (!task) throw appError("TASK_REQUIRED", 400);
  if (task.length < 4) throw appError("TASK_TOO_SHORT", 400);
  const userContext = safeString(body.context, 6000);
  const requester = safeString(body.requested_by, 100) || "human_user";
  const requestedKey = safeString(body.idempotency_key, 120);
  const idempotencyKey = requestedKey || crypto.randomUUID();

  const existing = await db.from("luna_erp_work_orders")
    .select("id")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing.error) throw appError("IDEMPOTENCY_LOOKUP_FAILED", 500);
  if (existing.data?.id) {
    return { idempotent_replay: true, ...(await loadTaskTree(existing.data.id)) };
  }

  const agents = await getAgents();
  const CEO = agents.find((a) => a.agent_key === "ceo_orchestrator" && a.enabled && a.health_status === "HEALTHY");
  if (!CEO) throw appError("CEO_AGENT_NOT_HEALTHY", 409);
  const specialists = agents.filter((a) =>
    a.agent_key !== "ceo_orchestrator" && a.enabled && a.health_status === "HEALTHY" && Boolean(a.system_prompt)
  );
  if (!specialists.length) throw appError("NO_HEALTHY_SPECIALIST_AGENTS", 409);

  const catalog = specialists.map((a) => ({
    agent_key: a.agent_key,
    display_name: a.display_name,
    department: a.department,
    role_description: a.role_description,
    capabilities: a.capabilities,
  }));
  const reply = await callModel(
    [
      CEO.system_prompt,
      "",
      "Create a task plan with 1 to 8 independent or dependency-ordered specialist work items. Only select from the supplied healthy specialist catalog. The first listed dependency index must point to an earlier item. Include concrete acceptance criteria. If the task requires production publishing, destructive data changes, secret access, policy changes, or live-money trading, set an explicit approval_gate and requires_human_gate=true. LIVE_TRADING must never be executed. For research or factual work, ask for sources and label unverified details. Plans and reports are not evidence of execution.",
    ].join("\n"),
    JSON.stringify({ user_task: task, context: userContext || null, healthy_specialist_catalog: catalog }),
    "ceo_task_plan",
    buildPlanJsonSchema(specialists.map((a) => a.agent_key)),
  );
  const plan = normalizeTaskPlan(parseModelJson<unknown>(reply), specialists.map((a) => a.agent_key));
  const traceId = crypto.randomUUID();
  const parentStatus = plan.requires_human_gate ? "BLOCKED" : "QUEUED";
  const parentGate = plan.approval_gate;

  const parentResult = await db.from("luna_erp_work_orders").insert({
    idempotency_key: idempotencyKey,
    title: plan.title,
    description: plan.objective,
    work_type: "CEO_PARENT",
    status: parentStatus,
    priority: 3,
    owner_agent_key: "ceo_orchestrator",
    dependency_ids: [],
    acceptance_criteria: [
      "Every child task has a recorded deliverable or explicit blocker.",
      "CEO summary reflects actual work-order states and evidence.",
      "Independent validation occurs before declaring completion.",
    ],
    evidence: [],
    blocker_code: plan.requires_human_gate ? "HUMAN_APPROVAL_REQUIRED" : null,
    blocker_detail: plan.requires_human_gate ? "CEO plan requires a human approval gate before specialist execution." : null,
    risk_level: plan.risk_level,
    paper_only: true,
    requires_human_gate: plan.requires_human_gate,
    requested_by: requester,
    trace_id: traceId,
    task_payload: {
      user_task: task,
      context: userContext || null,
      plan_summary: plan.summary,
      approval_gate: parentGate,
      planned_work_items_count: plan.work_items.length,
    },
  }).select("id,trace_id,status").single();
  if (parentResult.error) {
    if (parentResult.error.code === "23505") throw appError("IDEMPOTENCY_KEY_CONFLICT", 409);
    throw appError("PARENT_WORK_ORDER_CREATE_FAILED", 500);
  }
  const parentId = parentResult.data.id as string;

  try {
    const childRows = plan.work_items.map((item: PlannedWorkItem, index: number) => {
      const gated = item.requires_human_gate || plan.requires_human_gate;
      return {
        idempotency_key: idempotencyKey + ":child:" + (index + 1),
        title: item.title,
        description: item.description,
        work_type: "AGENT_TASK",
        status: gated ? "BLOCKED" : "QUEUED",
        priority: item.priority,
        owner_agent_key: item.agent_key,
        dependency_ids: [],
        acceptance_criteria: item.acceptance_criteria,
        evidence: [],
        blocker_code: gated ? "HUMAN_APPROVAL_REQUIRED" : null,
        blocker_detail: gated ? "This task is waiting on a recorded human approval." : null,
        risk_level: item.risk_level,
        paper_only: true,
        requires_human_gate: gated,
        parent_work_order_id: parentId,
        requested_by: "ceo_orchestrator",
        trace_id: traceId,
        task_payload: {
          plan_index: index,
          user_task: task,
          context: userContext || null,
          plan_summary: plan.summary,
          approval_gate: item.approval_gate,
          dependency_indexes: item.dependency_indexes,
        },
      };
    });
    const childrenResult = await db.from("luna_erp_work_orders").insert(childRows)
      .select("id,title,owner_agent_key,status,task_payload");
    if (childrenResult.error) throw appError("CHILD_WORK_ORDER_CREATE_FAILED", 500);
    const children = childrenResult.data ?? [];
    const idByIndex = new Map<number, string>();
    for (const child of children as any[]) {
      idByIndex.set(Number(child.task_payload?.plan_index), String(child.id));
    }
    for (const [idx, item] of plan.work_items.entries()) {
      const dependencyIds = item.dependency_indexes.map((depIndex) => idByIndex.get(depIndex)).filter(Boolean);
      const id = idByIndex.get(idx);
      if (id) {
        const update = await db.from("luna_erp_work_orders")
          .update({ dependency_ids: dependencyIds, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (update.error) throw appError("CHILD_DEPENDENCY_SAVE_FAILED", 500);
      }
    }

    const approvals: Array<Record<string, unknown>> = [];
    if (plan.requires_human_gate && parentGate !== "NONE") {
      approvals.push({
        work_order_id: parentId,
        gate_type: parentGate,
        status: "PENDING",
        requested_by: "ceo_orchestrator",
        rationale: "The CEO plan identifies a consequential action that requires human approval.",
      });
    }
    for (const item of plan.work_items) {
      if (item.requires_human_gate && item.approval_gate !== "NONE") {
        const childId = idByIndex.get(plan.work_items.indexOf(item));
        if (childId) approvals.push({
          work_order_id: childId,
          gate_type: item.approval_gate,
          status: "PENDING",
          requested_by: "ceo_orchestrator",
          rationale: "The specialist task is gated and will not execute until human approval is recorded.",
        });
      }
    }
    if (approvals.length) {
      const approvalResult = await db.from("luna_erp_approvals").upsert(approvals, {
        onConflict: "work_order_id,gate_type",
      });
      if (approvalResult.error) throw appError("APPROVAL_GATE_CREATE_FAILED", 500);
    }

    const runResult = await db.from("luna_erp_agent_runs").insert({
      work_order_id: parentId,
      agent_key: "ceo_orchestrator",
      trace_id: traceId,
      status: "COMPLETED",
      model_provider: "OPENAI_RESPONSES_API",
      model_name: MODEL_NAME.trim(),
      prompt_version: CEO.prompt_version,
      input: { task, context: userContext || null, specialist_count: specialists.length },
      output: plan as unknown as Record<string, unknown>,
      provider_response_id: reply.responseId,
      input_tokens: reply.inputTokens,
      output_tokens: reply.outputTokens,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    if (runResult.error) throw appError("CEO_RUN_TRACE_SAVE_FAILED", 500);

    const runnable = !plan.requires_human_gate;
    const taskRuns = runnable ? await runBatch(parentId, Math.min(plan.work_items.length, 5)) : [];
    const parentState = await updateParentStatus(parentId);
    return {
      ok: true,
      parent_work_order_id: parentId,
      trace_id: traceId,
      status: parentState.status,
      summary: plan.summary,
      idempotency_key: idempotencyKey,
      planned_tasks: plan.work_items.length,
      specialist_runs: taskRuns,
      plan,
      parent_state: parentState,
      next_action: parentState.status === "VALIDATION"
        ? "Independent QA/human review is required before marking complete."
        : parentState.status === "BLOCKED"
          ? "Resolve the recorded human approval or task blocker before execution continues."
          : "Run the queued task batch again or inspect work-order evidence.",
    };
  } catch (error) {
    await db.from("luna_erp_work_orders").update({
      status: "FAILED",
      last_error_code: (error as any)?.code ?? "TASK_TREE_CREATE_FAILED",
      blocker_detail: "Task planning was persisted incompletely. Inspect child work orders before retrying.",
      ended_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", parentId);
    throw error;
  }
}

async function runBatchAction(body: Record<string, any>) {
  const parentId = safeString(body.parent_work_order_id, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parentId)) {
    throw appError("INVALID_PARENT_WORK_ORDER_ID", 400);
  }
  const batchMax = Number.isSafeInteger(body.max_tasks) ? Number(body.max_tasks) : 3;
  const results = await runBatch(parentId, batchMax);
  const state = await updateParentStatus(parentId);
  const tree = await loadTaskTree(parentId);
  return {
    ok: true,
    parent_work_order_id: parentId,
    specialist_runs: results,
    parent_state: state,
    tree,
    next_action: state.status === "VALIDATION"
      ? "Independent QA/human review is required before marking complete."
      : "Inspect blocked dependencies or call run_batch again if eligible work remains.",
  };
}

async function respondHealth() {
  const agents = await getAgents();
  const health = healthSummary(agents);
  return json({ ok: true, ...health }, health.status === "BLOCKED" ? 200 : 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  try {
    const auth = await authorize(req);
    if (!auth.ok) return json({ ok: false, error: auth.code }, auth.status);

    if (req.method === "GET") return await respondHealth();
    if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return json({ ok: false, error: "CONTENT_TYPE_JSON_REQUIRED" }, 415);
    }

    const body = await req.json();
    if (!isObject(body)) return json({ ok: false, error: "INVALID_REQUEST_BODY" }, 400);
    const action = safeString(body.action, 80);

    if (action === "verify_runtime") {
      const result = await verifyProvider();
      return json(result);
    }
    if (action === "dispatch_task") {
      const result = await dispatchTask(body);
      return json(result);
    }
    if (action === "run_batch") {
      const result = await runBatchAction(body);
      return json(result);
    }
    if (action === "health") return await respondHealth();

    return json({
      ok: false,
      error: "UNKNOWN_ACTION",
      supported_actions: ["health", "verify_runtime", "dispatch_task", "run_batch"],
    }, 400);
  } catch (error) {
    const code = (error as any)?.code && typeof (error as any).code === "string"
      ? (error as any).code
      : "INTERNAL_AGENT_ERROR";
    const status = Number.isSafeInteger((error as any)?.status) ? Number((error as any).status) : 500;
    return json({ ok: false, error: code }, status);
  }
});
